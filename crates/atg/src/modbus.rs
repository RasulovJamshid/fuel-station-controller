//! Bounded Modbus TCP reads. Twelve registers describe one tank.
use anyhow::{bail, ensure, Context};
use site_config::{AtgBranch, AtgWordOrder};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::TcpStream;

async fn exchange<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    tid: u16,
    unit: u8,
    start: u16,
    count: u16,
) -> anyhow::Result<Vec<u16>> {
    ensure!((1..=125).contains(&count), "Invalid Modbus request count");
    let mut req = [0u8; 12];
    req[..2].copy_from_slice(&tid.to_be_bytes());
    req[4..6].copy_from_slice(&6u16.to_be_bytes());
    req[6] = unit;
    req[7] = 3;
    req[8..10].copy_from_slice(&start.to_be_bytes());
    req[10..].copy_from_slice(&count.to_be_bytes());
    stream.write_all(&req).await?;
    let mut hdr = [0u8; 7];
    stream.read_exact(&mut hdr).await.context("Modbus header")?;
    ensure!(
        u16::from_be_bytes([hdr[0], hdr[1]]) == tid,
        "Modbus transaction ID mismatch"
    );
    ensure!(
        hdr[2..4] == [0, 0] && hdr[6] == unit,
        "Modbus protocol/unit mismatch"
    );
    let len = u16::from_be_bytes([hdr[4], hdr[5]]) as usize;
    ensure!((3..=253).contains(&len), "Invalid Modbus frame length");
    let mut pdu = vec![0; len - 1];
    stream.read_exact(&mut pdu).await.context("Modbus body")?;
    if pdu[0] == 0x83 {
        ensure!(pdu.len() == 2, "Invalid Modbus exception length");
        bail!("Modbus exception code={:#04x}", pdu[1]);
    }
    ensure!(pdu[0] == 3, "Unexpected Modbus function code");
    ensure!(
        pdu.len() == 2 + count as usize * 2 && pdu[1] as usize == count as usize * 2,
        "Modbus register count/length mismatch"
    );
    Ok(pdu[2..]
        .chunks_exact(2)
        .map(|w| u16::from_be_bytes([w[0], w[1]]))
        .collect())
}

fn words_to_floats(words: &[u16], order: AtgWordOrder) -> Vec<f32> {
    words
        .chunks_exact(2)
        .map(|w| {
            let [a, b] = w[0].to_be_bytes();
            let [c, d] = w[1].to_be_bytes();
            f32::from_be_bytes(match order {
                AtgWordOrder::ABCD => [a, b, c, d],
                AtgWordOrder::CDAB => [c, d, a, b],
                AtgWordOrder::BADC => [b, a, d, c],
                AtgWordOrder::DCBA => [d, c, b, a],
            })
        })
        .collect()
}

pub async fn read_branch(branch: &AtgBranch, timeout: Duration) -> anyhow::Result<Vec<f32>> {
    branch.validate_window()?;
    read_window(
        &branch.host,
        branch.port,
        branch.unit_id,
        branch.pdu_address(),
        branch.register_count,
        branch.word_order,
        timeout,
    )
    .await
}

pub async fn read_host(
    host: &str,
    port: u16,
    unit: u8,
    start: u16,
    count: u16,
    timeout: Duration,
) -> anyhow::Result<Vec<f32>> {
    read_window(host, port, unit, start, count, AtgWordOrder::ABCD, timeout).await
}

async fn read_window(
    host: &str,
    port: u16,
    unit: u8,
    start: u16,
    count: u16,
    order: AtgWordOrder,
    timeout: Duration,
) -> anyhow::Result<Vec<f32>> {
    ensure!(
        count > 0 && count % 12 == 0 && u32::from(start) + u32::from(count) <= 65536,
        "Invalid tank register window"
    );
    let mut stream = tokio::time::timeout(timeout, TcpStream::connect((host, port)))
        .await
        .context("Modbus connect timeout")??;
    let words = read_batches(&mut stream, unit, start, count, timeout).await?;
    Ok(words_to_floats(&words, order))
}

async fn read_batches<S: AsyncRead + AsyncWrite + Unpin>(
    stream: &mut S,
    unit: u8,
    start: u16,
    count: u16,
    timeout: Duration,
) -> anyhow::Result<Vec<u16>> {
    let mut words = Vec::with_capacity(count as usize);
    let mut offset = 0u16;
    let mut tid = 1u16;
    while offset < count {
        // Ten complete tanks per request; no float/tank spans two reads.
        let batch = (count - offset).min(120);
        words.extend(
            tokio::time::timeout(timeout, exchange(stream, tid, unit, start + offset, batch))
                .await
                .context("Modbus response timeout")??,
        );
        offset += batch;
        tid += 1;
    }
    Ok(words)
}

#[cfg(test)]
mod tests {
    use super::*;
    async fn response(bytes: Vec<u8>, count: u16) -> anyhow::Result<Vec<u16>> {
        let (mut client, mut server) = tokio::io::duplex(1024);
        tokio::spawn(async move {
            let mut req = [0; 12];
            server.read_exact(&mut req).await.unwrap();
            server.write_all(&bytes).await.unwrap();
        });
        exchange(&mut client, 1, 7, 999, count).await
    }
    #[tokio::test]
    async fn validates_frames_and_exception_without_extra_read() {
        assert_eq!(
            response(vec![0, 1, 0, 0, 0, 7, 7, 3, 4, 0, 1, 0, 2], 2)
                .await
                .unwrap(),
            vec![1, 2]
        );
        for frame in [
            vec![0, 2, 0, 0, 0, 7, 7, 3, 4, 0, 1, 0, 2],
            vec![0, 1, 0, 0, 0, 7, 8, 3, 4, 0, 1, 0, 2],
            vec![0, 1, 0, 0, 0, 5, 7, 3, 2, 0, 1],
        ] {
            assert!(response(frame, 2).await.is_err());
        }
        assert!(response(vec![0, 1, 0, 0, 0, 3, 7, 0x83, 2], 2)
            .await
            .unwrap_err()
            .to_string()
            .contains("0x02"));
    }
    #[tokio::test]
    async fn reads_twelve_tanks_in_multiple_bounded_requests() {
        let (mut client, mut server) = tokio::io::duplex(2048);
        let device = tokio::spawn(async move {
            for (tid, start, count) in [(1u16, 999u16, 120u16), (2, 1119, 24)] {
                let mut req = [0; 12];
                server.read_exact(&mut req).await.unwrap();
                assert_eq!(u16::from_be_bytes([req[0], req[1]]), tid);
                assert_eq!(u16::from_be_bytes([req[8], req[9]]), start);
                assert_eq!(u16::from_be_bytes([req[10], req[11]]), count);
                let mut reply = vec![];
                reply.extend(tid.to_be_bytes());
                reply.extend([0, 0]);
                reply.extend((count * 2 + 3).to_be_bytes());
                reply.extend([1, 3, (count * 2) as u8]);
                for _ in 0..count / 2 {
                    reply.extend(123.5f32.to_be_bytes());
                }
                server.write_all(&reply).await.unwrap();
            }
        });
        let words = read_batches(&mut client, 1, 999, 144, Duration::from_secs(1))
            .await
            .unwrap();
        assert_eq!(words_to_floats(&words, AtgWordOrder::ABCD), vec![123.5; 72]);
        device.await.unwrap();
    }
    #[test]
    fn byte_orders() {
        for (words, order) in [
            (vec![0x3f80, 0], AtgWordOrder::ABCD),
            (vec![0, 0x3f80], AtgWordOrder::CDAB),
            (vec![0x803f, 0], AtgWordOrder::BADC),
            (vec![0, 0x803f], AtgWordOrder::DCBA),
        ] {
            assert_eq!(words_to_floats(&words, order), vec![1.0]);
        }
    }
}
