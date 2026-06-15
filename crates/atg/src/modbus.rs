//! Raw Modbus TCP reading over tokio TcpStream. No external Modbus crate needed.

use std::time::Duration;

use anyhow::{bail, Context};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;

use site_config::AtgBranch;

/// Read Modbus holding registers via TCP. Returns raw 16-bit words.
async fn read_registers(
    host: &str,
    port: u16,
    unit_id: u8,
    pdu_addr: u16,
    count: u16,
    timeout: Duration,
) -> anyhow::Result<Vec<u16>> {
    let addr = format!("{}:{}", host, port);
    let stream = tokio::time::timeout(timeout, TcpStream::connect(&addr))
        .await
        .context("Modbus connect timeout")?
        .with_context(|| format!("Modbus connect to {addr}"))?;

    stream.set_nodelay(true).ok();
    let (mut reader, mut writer) = tokio::io::split(stream);

    // MBAP header (6 B) + PDU (6 B = unit_id + FC + start_addr[2] + count[2])
    let mut req = [0u8; 12];
    req[0..2].copy_from_slice(&1u16.to_be_bytes()); // transaction ID
    req[2..4].copy_from_slice(&0u16.to_be_bytes()); // protocol ID = 0 (Modbus)
    req[4..6].copy_from_slice(&6u16.to_be_bytes()); // PDU length
    req[6] = unit_id;
    req[7] = 0x03; // FC 03 = Read Holding Registers
    req[8..10].copy_from_slice(&pdu_addr.to_be_bytes());
    req[10..12].copy_from_slice(&count.to_be_bytes());

    tokio::time::timeout(timeout, writer.write_all(&req))
        .await
        .context("Modbus write timeout")?
        .context("Modbus write request")?;

    // Response: MBAP (6 B) + unit_id (1 B) + FC (1 B) + byte_count (1 B)
    let mut hdr = [0u8; 9];
    tokio::time::timeout(timeout, reader.read_exact(&mut hdr))
        .await
        .context("Modbus read header timeout")?
        .context("Modbus read response header")?;

    let fc = hdr[7];
    if fc & 0x80 != 0 {
        // Exception response: next byte is exception code
        let mut exc = [0u8; 1];
        let _ = tokio::time::timeout(timeout, reader.read_exact(&mut exc)).await;
        bail!(
            "Modbus exception: FC={:#04x} code={:#04x}",
            fc,
            exc.first().copied().unwrap_or(0)
        );
    }
    if fc != 0x03 {
        bail!("Unexpected Modbus function code in response: {:#04x}", fc);
    }

    let byte_count = hdr[8] as usize;
    let mut data = vec![0u8; byte_count];
    tokio::time::timeout(timeout, reader.read_exact(&mut data))
        .await
        .context("Modbus read data timeout")?
        .context("Modbus read response data")?;

    Ok(data
        .chunks_exact(2)
        .map(|b| u16::from_be_bytes([b[0], b[1]]))
        .collect())
}

/// Decode pairs of Modbus words as big-endian IEEE 754 float32.
/// Matches pyModbusTCP's `word_list_to_long` + `decode_ieee`.
fn words_to_floats(words: &[u16]) -> Vec<f32> {
    words
        .chunks_exact(2)
        .map(|pair| f32::from_bits(((pair[0] as u32) << 16) | (pair[1] as u32)))
        .collect()
}

/// Read all holding registers for one ATG branch and decode as f32 floats.
pub async fn read_branch(branch: &AtgBranch, timeout: Duration) -> anyhow::Result<Vec<f32>> {
    read_host(
        &branch.host,
        branch.port,
        branch.unit_id,
        branch.pdu_address(),
        branch.register_count,
        timeout,
    )
    .await
}

/// Read holding registers from a raw ATG Modbus host and decode as f32 floats.
pub async fn read_host(
    host: &str,
    port: u16,
    unit_id: u8,
    pdu_addr: u16,
    count: u16,
    timeout: Duration,
) -> anyhow::Result<Vec<f32>> {
    let regs = read_registers(host, port, unit_id, pdu_addr, count, timeout).await?;
    Ok(words_to_floats(&regs))
}
