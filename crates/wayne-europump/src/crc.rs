const fn build_crc_table() -> [u16; 256] {
    let mut table = [0u16; 256];
    let mut i = 0usize;
    while i < 256 {
        let mut value = 0u16;
        let mut temp = i as u16;
        let mut j = 0;
        while j < 8 {
            if (value ^ temp) & 1 != 0 {
                value = (value >> 1) ^ 0xA001;
            } else {
                value >>= 1;
            }
            temp >>= 1;
            j += 1;
        }
        table[i] = value;
        i += 1;
    }
    table
}

static CRC_TABLE: [u16; 256] = build_crc_table();

pub fn crc16(data: &[u8]) -> u16 {
    let mut crc: u16 = 0;
    for &byte in data {
        let index = ((crc as u8) ^ byte) as usize;
        crc = (crc >> 8) ^ CRC_TABLE[index];
    }
    crc
}

pub fn build_frame(data: &[u8]) -> Vec<u8> {
    let crc = crc16(data);
    let mut frame = data.to_vec();
    frame.push((crc & 0xFF) as u8);
    frame.push((crc >> 8) as u8);
    frame.push(0x03);
    frame.push(0xFA);
    frame
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crc_vectors() {
        assert_eq!(crc16(&[0x52, 0x30, 0x01, 0x01, 0x04]), 0x5FE7);
        assert_eq!(crc16(&[0x52, 0x30, 0x01, 0x01, 0x08]), 0x5AE7);
        assert_eq!(crc16(&[0x52, 0x30, 0x01, 0x01, 0x05]), 0x9F26);
        assert_eq!(crc16(&[0x53, 0x30, 0x01, 0x01, 0x08]), 0x9ADA);
        assert_eq!(crc16(&[0x50, 0x30, 0x01, 0x01, 0x08]), 0x9A9E);
        assert_eq!(crc16(&[0x51, 0x30, 0x01, 0x01, 0x08]), 0x5AA3);
    }

    #[test]
    fn frame_endings() {
        let f = build_frame(&[0x52, 0x30, 0x01, 0x01, 0x04]);
        assert_eq!(
            f,
            vec![0x52, 0x30, 0x01, 0x01, 0x04, 0xE7, 0x5F, 0x03, 0xFA]
        );
        let f = build_frame(&[0x52, 0x30, 0x01, 0x01, 0x08]);
        assert_eq!(
            f,
            vec![0x52, 0x30, 0x01, 0x01, 0x08, 0xE7, 0x5A, 0x03, 0xFA]
        );
        let f = build_frame(&[0x52, 0x30, 0x01, 0x01, 0x05]);
        assert_eq!(
            f,
            vec![0x52, 0x30, 0x01, 0x01, 0x05, 0x26, 0x9F, 0x03, 0xFA]
        );
        let f = build_frame(&[0x53, 0x30, 0x01, 0x01, 0x08]);
        assert_eq!(
            f,
            vec![0x53, 0x30, 0x01, 0x01, 0x08, 0xDA, 0x9A, 0x03, 0xFA]
        );
        let f = build_frame(&[0x50, 0x30, 0x01, 0x01, 0x08]);
        assert_eq!(
            f,
            vec![0x50, 0x30, 0x01, 0x01, 0x08, 0x9E, 0x9A, 0x03, 0xFA]
        );
        let f = build_frame(&[0x51, 0x30, 0x01, 0x01, 0x08]);
        assert_eq!(
            f,
            vec![0x51, 0x30, 0x01, 0x01, 0x08, 0xA3, 0x5A, 0x03, 0xFA]
        );
    }
}
