# Wayne 3490D Dispenser Protocol
## Reverse Engineering Documentation

**Dispenser model:** Wayne 3490D (iGEM controller)  
**Converter:** ASIS PCC485 (RS232 ↔ RS485 intelligent protocol converter)  
**Sniffed:** RS232 line between PC and ASIS PCC485  
**Tool:** Custom ESP32-S3 passive dual-channel RS232 sniffer  
**Total frames verified:** 694/695 (99.86%)  
**Date:** May 2026  

---

## Table of Contents

1. [Hardware setup](#1-hardware-setup)
2. [Serial port settings](#2-serial-port-settings)
3. [Device addresses](#3-device-addresses)
4. [CRC algorithm](#4-crc-algorithm)
5. [Frame types](#5-frame-types)
6. [Command reference](#6-command-reference)
7. [Data frame encoding](#7-data-frame-encoding)
8. [Transaction lifecycle](#8-transaction-lifecycle)
9. [Timing](#9-timing)
10. [Disconnect and reconnect](#10-disconnect-and-reconnect)
11. [Error frames and bus artifacts](#11-error-frames-and-bus-artifacts)
12. [Multi-product and multi-nozzle](#12-multi-product-and-multi-nozzle)
13. [Captured scenarios](#13-captured-scenarios)
14. [Protocol source](#14-protocol-source)

---

## 1. Hardware setup

```
Station PC
    │
    │ RS232 (9600 baud, Odd parity)
    │ ← THIS LINE IS SNIFFED →
    │
ASIS PCC485 converter
    │
    │ RS485 (Wayne DART protocol, 9600 Odd, 13-byte frames)
    │
Wayne 3490D dispensers (up to 4 sides per converter)
```

The ASIS PCC485 is an **intelligent protocol converter**. It translates between:
- **PC side (RS232):** simplified 3-byte / variable-length frames — what we capture
- **Dispenser side (RS485):** full 13-byte WayneDartV2 frames — not directly captured

All captures in this document are from the **RS232 PC side**.

---

## 2. Serial port settings

| Parameter | Value |
|---|---|
| Baud rate | **9600** |
| Parity | **Odd** |
| Data bits | 8 |
| Stop bits | 1 |
| Flow control | None |

> **Important:** 9600 baud with **Odd** parity confirmed by switching sniffer from 4800 8N1 to 9600 8O1 — data became clean and structured. The 4800 8N1 captures were misinterpretations.

---

## 3. Device addresses

Each physical dispenser side has a unique address byte.

| Label | Byte (hex) | Byte (decimal) | Description |
|---|---|---|---|
| P0 | `0x50` | 80 | Dispenser 1 Side A |
| P1 | `0x51` | 81 | Dispenser 1 Side B |
| P2 | `0x52` | 82 | Dispenser 2 Side A |
| P3 | `0x53` | 83 | Dispenser 2 Side B |

**Formula:** `address_byte = 79 + nozzle_id` where nozzle_id = 1..4

**Valid address range:** `0x50–0x6F` (Wayne spec 50H–6FH)

---

## 4. CRC algorithm

**CRC16 with init=0, polynomial=0xA001 (Europump style)**

> Critical: init = **0**, NOT 0xFFFF. Using 0xFFFF produces wrong checksums.

### Implementation (Python)

```python
def _build_table():
    table = []
    for i in range(256):
        value = 0; temp = i
        for j in range(8):
            if (value ^ temp) & 1:
                value = (value >> 1) ^ 0xA001
            else:
                value >>= 1
            temp >>= 1
        table.append(value)
    return table

TABLE = _build_table()

def crc16(data: bytes) -> int:
    crc = 0  # init=0
    for byte in data:
        crc = (crc >> 8) ^ TABLE[(crc ^ byte) & 0xFF]
    return crc

def build_frame(data: list[int]) -> bytes:
    b = bytes(data)
    crc = crc16(b)
    return b + bytes([crc & 0xFF, crc >> 8, 0x03, 0xFA])
    #               CK1=lo first  CK2=hi    end marker
```

### Implementation (Rust)

```rust
const fn build_table() -> [u16; 256] {
    let mut table = [0u16; 256];
    let mut i = 0usize;
    while i < 256 {
        let mut value = 0u16;
        let mut temp = i as u16;
        let mut j = 0;
        while j < 8 {
            if (value ^ temp) & 1 != 0 { value = (value >> 1) ^ 0xA001; }
            else { value >>= 1; }
            temp >>= 1;
            j += 1;
        }
        table[i] = value;
        i += 1;
    }
    table
}

static CRC_TABLE: [u16; 256] = build_table();

pub fn crc16(data: &[u8]) -> u16 {
    let mut crc: u16 = 0; // init=0
    for &byte in data {
        crc = (crc >> 8) ^ CRC_TABLE[((crc as u8) ^ byte) as usize];
    }
    crc
}

pub fn build_frame(data: &[u8]) -> Vec<u8> {
    let crc = crc16(data);
    let mut frame = data.to_vec();
    frame.push((crc & 0xFF) as u8); // CK1 = low byte
    frame.push((crc >> 8) as u8);   // CK2 = high byte
    frame.push(0x03);
    frame.push(0xFA);
    frame
}
```

### Test vectors — all must pass

| Input bytes | CK1 | CK2 | Command |
|---|---|---|---|
| `52 30 01 01 04` | `E7` | `5F` | P2 BUSY |
| `52 30 01 01 08` | `E7` | `5A` | P2 STOP |
| `52 30 01 01 05` | `26` | `9F` | P2 DONE |
| `53 30 01 01 08` | `DA` | `9A` | P3 STOP |
| `50 30 01 01 08` | `9E` | `9A` | P0 STOP |
| `51 30 01 01 08` | `A3` | `5A` | P1 STOP |
| `52 30 01 01 04 01 01 05` | `19` | `94` | P2 AUTH |
| `53 30 01 01 04 01 01 05` | `D8` | `58` | P3 AUTH |
| `52 31 01 01 08` | `E6` | `A6` | P2 STOP CONFIRM |
| `53 31 01 01 08` | `DB` | `66` | P3 STOP CONFIRM |

### CRC scope

| Frame type | CRC computed over |
|---|---|
| Short frames (3 bytes) | No CRC — short frames have no checksum |
| Command frames (≤16 bytes) | All bytes before `[CK1][CK2][03][FA]` |
| Short data frames (16 bytes) | First 12 bytes |
| Extended data frames (22+ bytes) | First 18 bytes only — extra config bytes appended after CRC |

---

## 5. Frame types

### 5.1 Short frames (3 bytes, no CRC)

```
Byte 0   Byte 1   Byte 2
[addr]   [type]   0xFA
```

| Direction | Frame | Meaning |
|---|---|---|
| PC → DISP | `[addr] 20 FA` | Status poll |
| DISP → PC | `[addr] 70 FA` | Idle status |
| DISP → PC | `[addr] C0 FA` | Authorized / delivering / acknowledge |
| PC → DISP | `[addr] C0 FA` | Acknowledge received data frame |
| DISP → PC | `[addr] C1 FA` | Stop acknowledged |

### 5.2 Command frames (variable length, with CRC)

```
[addr] 30 [params...] [CK1] [CK2] 03 FA
```

Or with confirm variant:

```
[addr] 31 [params...] [CK1] [CK2] 03 FA
```

### 5.3 Data frames (16 bytes, from dispenser)

```
[addr] [seq] 02 08 00 00 [V1][V2] 00 [A1][A2][A3] [CK1][CK2] 03 FA
```

### 5.4 Extended data frames (22+ bytes, from dispenser)

```
[addr] [seq] 02 08 00 00 [V1][V2] 00 [A1][A2][A3] [config bytes] [CK1][CK2] 03 FA
```

CRC covers only the first 18 bytes. Config bytes are outside CRC.

### 5.5 Special sequence frames (from dispenser)

```
[addr] [seq] 03 04 01 [product] 00 [nozzle] [CK1][CK2] 03 FA  ← nozzle lifted
[addr] [seq] 01 01 05 [CK1][CK2] 03 FA                        ← transaction done
[addr] [seq] 01 01 01 [CK1][CK2] 03 FA                        ← delivery stopped
[addr] [seq] 01 01 02 [CK1][CK2] 03 FA                        ← nozzle status
[addr] [seq] 01 01 00 [CK1][CK2] 03 FA                        ← post-stop idle
```

---

## 6. Command reference

### POLL — PC polls a dispenser

```
Direction: PC → DISPENSER
Frame:     [addr] 20 FA
CRC:       none

Example P2: 52 20 FA
```

### IDLE — dispenser reports idle

```
Direction: DISPENSER → PC
Frame:     [addr] 70 FA
CRC:       none

Example P2: 52 70 FA
```

### ACK — acknowledge

```
Direction: both
Frame:     [addr] C0 FA
CRC:       none

Used by dispenser: response to authorize, config, any command
Used by PC:        acknowledge each data frame received
```

### AUTHORIZE — initial authorization with nozzle parameters

```
Direction: PC → DISPENSER
Frame:     [addr] 30 01 01 04 01 01 05 [CK1][CK2] 03 FA
CRC input: [addr] 30 01 01 04 01 01 05

Example P2: 52 30 01 01 04 01 01 05 19 94 03 FA
Example P3: 53 30 01 01 04 01 01 05 D8 58 03 FA
```

Sent once when nozzle is first lifted. Followed by CONFIG frame.

### CONFIG — price and preset configuration

```
Direction: PC → DISPENSER  
Frame:     [addr] 30 01 01 05 [long config] [CK1][CK2] 03 FA
Sent:      twice in sequence
```

The config payload encodes:
- Number of nozzles and grades
- Price per product (encoding not fully decoded)
- Preset: `09 99` = full tank (unlimited), other values = preset amount

**Example full-fill config for P2:**
```
52 30 01 01 05 02 04 01 02 03 04 05 0C 01 50 00 01 05
00 01 24 00 01 43 30 03 04 00 09 99 00 01 01 06 [CK] 03 FA
```

Price bytes observed:
- `01 50` → product 1 price (exact encoding unit unknown)
- `01 24` → product 2 price
- `09 99` → full fill preset (unlimited)

### BUSY — keepalive during delivery

```
Direction: PC → DISPENSER
Frame:     [addr] 30 01 01 04 [CK1][CK2] 03 FA
CRC input: [addr] 30 01 01 04

Hardcoded checksums:
  P0: 52 30 01 01 04 E7 5F 03 FA  ← wait, P0 is 50
  P0 (0x50): 50 30 01 01 04 CK? 03 FA
  P1 (0x51): 51 30 01 01 04 CK? 03 FA
  P2 (0x52): 52 30 01 01 04 E7 5F 03 FA
  P3 (0x53): 53 30 01 01 04 DA 9F 03 FA
```

Sent every 1–2 poll cycles during active delivery. Dispenser stops if BUSY is not received.

### STOP — emergency stop

```
Direction: PC → DISPENSER (sent to ALL addresses simultaneously)
Frame:     [addr] 30 01 01 08 [CK1][CK2] 03 FA
CRC input: [addr] 30 01 01 08

Hardcoded per address:
  P0 (0x50): 50 30 01 01 08 9E 9A 03 FA
  P1 (0x51): 51 30 01 01 08 A3 5A 03 FA
  P2 (0x52): 52 30 01 01 08 E7 5A 03 FA
  P3 (0x53): 53 30 01 01 08 DA 9A 03 FA
```

Followed by STOP CONFIRM.

### STOP CONFIRM — confirm stop (31 variant)

```
Direction: PC → DISPENSER
Frame:     [addr] 31 01 01 08 [CK1][CK2] 03 FA

Hardcoded per address:
  P0 (0x50): 50 31 01 01 08 9F 66 03 FA
  P1 (0x51): 51 31 01 01 08 A2 A6 03 FA
  P2 (0x52): 52 31 01 01 08 E6 A6 03 FA
  P3 (0x53): 53 31 01 01 08 DB 66 03 FA
```

### DONE — acknowledge transaction complete

```
Direction: PC → DISPENSER
Frame:     [addr] 30 01 01 05 [CK1][CK2] 03 FA
CRC input: [addr] 30 01 01 05

Example P2: 52 30 01 01 05 26 9F 03 FA
Example P3: 53 30 01 01 05 [CK] 03 FA
```

Sent after dispenser sends the transaction-complete frame (`01 01 05`).

---

## 7. Data frame encoding

### 7.1 Data frame structure

```
Byte  0:     [addr]    device address (0x50-0x53)
Byte  1:     [seq]     sequence counter 0x31–0x3F (rolling, wraps to 0x31)
Bytes 2–3:   02 08     fixed header
Bytes 4–5:   00 00     fixed zeros
Bytes 6–7:   [V1][V2]  volume in BCD centiliters
Byte  8:     00        separator
Bytes 9–11:  [A1][A2][A3]  amount in BCD (unit = 100 sum)
Bytes 12–13: [CK1][CK2]   CRC16 over bytes 0–11
Bytes 14–15: 03 FA     frame terminator
```

### 7.2 Volume encoding — BCD centiliters

Each byte is a pair of BCD decimal digits.

```
V1 V2 → string → decimal → ÷100 = liters

Example:  09 97 → "0997" → 997 → 9.97 L
Example:  10 00 → "1000" → 1000 → 10.00 L
Example:  22 47 → "2247" → 2247 → 22.47 L
```

**Decode in Python:**
```python
def decode_volume(v1: int, v2: int) -> float:
    digits = f"{v1:02X}{v2:02X}"   # BCD bytes to hex string
    return int(digits) / 100.0      # "0997" → 9.97
```

**Decode in Rust:**
```rust
fn decode_volume(v1: u8, v2: u8) -> f64 {
    let digits = format!("{:02X}{:02X}", v1, v2);
    digits.parse::<f64>().unwrap_or(0.0) / 100.0
}
```

### 7.3 Amount encoding — BCD × 100 sum

Three bytes, each a pair of BCD decimal digits. Result is in units of **100 sum**.

```
A1 A2 A3 → string → decimal = amount in 100-sum units

Example: 10 46 85 → "104685" → 104,685 (this means 104,685 sum)
Example: 10 50 00 → "105000" → 105,000 sum
Example: 23 59 35 → "235935" → 235,935 sum
```

**Decode in Python:**
```python
def decode_amount(a1: int, a2: int, a3: int) -> int:
    digits = f"{a1:02X}{a2:02X}{a3:02X}"
    return int(digits)   # already in sum units, no division needed
```

### 7.4 Cross-validation from real captures

All values verified against known fill amounts:

| V1 V2 | Volume | A1 A2 A3 | Amount | Price check |
|---|---|---|---|---|
| `09 97` | 9.97 L | `10 46 85` | 104,685 sum | 10,500 sum/L ✓ |
| `10 00` | 10.00 L | `10 50 00` | 105,000 sum | 10,500 sum/L ✓ |
| `14 28` | 14.28 L | `14 99 40` | 149,940 sum | 10,500 sum/L ✓ |
| `22 47` | 22.47 L | `23 59 35` | 235,935 sum | 10,500 sum/L ✓ |
| `01 95` | 1.95 L | `02 04 75` | 20,475 sum | 10,500 sum/L ✓ |

**Consistent price: exactly 10,500 sum/L across all frames.**

### 7.5 Sequence counter

Byte[1] of data frames is a rolling counter:
- Range: `0x31` to `0x3F` (decimal 49–63)
- Rolls: after `0x3F` → back to `0x31`
- Resets: to `0x31` at start of each new transaction

### 7.6 Extended data frame

Some data frames include additional nozzle/product config bytes after the CRC.  
These carry product identification and are not covered by the CRC.

```
[addr][seq] 02 08 00 00 [V1][V2] 00 [A1][A2][A3]  ← CRC covers these 12 bytes
[CK1][CK2]                                         ← CRC
03 04 [product_code] [nozzle_id] 00 [grade]        ← extra config (outside CRC)
[CK1*][CK2*]                                       ← second CRC (over first 18 bytes)
03 FA                                              ← end
```

**Known product/nozzle codes observed:**
- `03 04 01 05 00 12` → product ID=05 (AI-92), nozzle=12
- `03 04 01 43 00 11` → product ID=43 (AI-95 or premium), nozzle=11

---

## 8. Transaction lifecycle

### 8.1 Normal fill — complete sequence

```
Step 1 — Polling (continuous, every 562ms round trip for 4 dispensers)
  PC → DISP:  52 20 FA
  DISP → PC:  52 70 FA

Step 2 — Nozzle lifted (dispenser initiates)
  DISP → PC:  52 [seq] 03 04 01 [product] 00 [nozzle] [CK] 03 FA

Step 3 — Authorization (PC responds)
  PC → DISP:  52 30 01 01 04 01 01 05 19 94 03 FA  ← AUTH initial
  DISP → PC:  52 C0 FA                              ← accepted

Step 4 — Config frame (sent TWICE)
  PC → DISP:  52 30 01 01 05 [long config with prices] [CK] 03 FA
  DISP → PC:  52 C0 FA
  PC → DISP:  52 30 01 01 05 [same frame again] [CK] 03 FA
  DISP → PC:  52 C0 FA

Step 5 — Transaction start (vol=0)
  DISP → PC:  52 [seq] 02 08 00 00 00 00 00 00 00 00 [extra config] [CK] 03 FA
  PC → DISP:  52 C0 FA                              ← ACK
  PC → DISP:  52 30 01 01 04 E7 5F 03 FA            ← BUSY keepalive

Step 6 — Active delivery (repeating ~562ms per round)
  PC → DISP:  52 20 FA                              ← poll
  DISP → PC:  52 [seq] 02 08 00 00 [V1][V2] 00 [A1][A2][A3] [CK] 03 FA
  PC → DISP:  52 C0 FA                              ← ACK data frame
  PC → DISP:  52 30 01 01 04 E7 5F 03 FA            ← BUSY keepalive
  DISP → PC:  52 C0 FA

  [volume increases on each frame — 0.07L, 0.08L, 0.10L, ... 9.97L, 10.00L]

Step 7 — Preset reached / nozzle still in tank
  [volume stops increasing, data frames continue with frozen value]
  PC → DISP:  52 30 01 01 04 E7 5F 03 FA            ← BUSY (keep alive)

Step 8 — Nozzle replaced (transaction complete)
  DISP → PC:  52 [seq] 01 01 05 [CK] 03 FA          ← DONE signal
  PC → DISP:  52 C0 FA                              ← ACK
  PC → DISP:  52 30 01 01 05 26 9F 03 FA            ← DONE acknowledge
  DISP → PC:  52 C0 FA
  DISP → PC:  52 70 FA                              ← back to IDLE
```

### 8.2 Emergency stop — mid-fill

```
[Active delivery at vol=1.95L]

  PC → DISP:  52 31 01 01 08 E6 A6 03 FA  ← STOP pre-command (31 variant)
  DISP → PC:  52 C1 FA                    ← stop acknowledged
  PC → DISP:  52 C0 FA
  PC → DISP:  52 30 01 01 08 E7 5A 03 FA  ← STOP command (30 variant)
  DISP → PC:  52 C0 FA

  [STOP also sent to all other addresses simultaneously]
  PC → DISP:  53 31 01 01 08 DB 66 03 FA  ← P3 STOP pre
  PC → DISP:  50 31 01 01 08 9F 66 03 FA  ← P0 STOP pre
  PC → DISP:  51 31 01 01 08 A2 A6 03 FA  ← P1 STOP pre
  [followed by 30 variant for each]

  [Dispenser freezes at 1.95L, keeps sending data frames with frozen vol]
  DISP → PC:  52 [seq] 02 08 00 00 01 95 00 02 04 75 [CK] 03 FA  ← frozen

  [After DONE ack is sent]
  PC → DISP:  52 30 01 01 05 26 9F 03 FA  ← DONE ACK
  DISP → PC:  52 C0 FA

  [Eventually dispenser sends stopped state]
  DISP → PC:  52 [seq] 01 01 01 [CK] 03 FA  ← STOPPED
  DISP → PC:  52 70 FA                       ← back to IDLE
```

### 8.3 Ghost fill — nozzle up then immediately down (zero volume)

```
  DISP → PC:  52 [seq] 03 04 01 05 00 12 [CK] 03 FA  ← nozzle up
  PC → DISP:  52 30 01 01 04 01 01 05 19 94 03 FA     ← AUTH (app responds)
  [operator sends STOP immediately]
  PC → DISP:  52 30 01 01 08 E7 5A 03 FA              ← STOP
  DISP → PC:  52 [seq] 01 01 05 [CK] 03 FA            ← done (vol=0)
  DISP → PC:  52 70 FA                                 ← IDLE
```

### 8.4 Price change fill

Same as normal fill but config frame contains new prices.  
Price takes effect on this transaction immediately.  
The app sends a full-fill AUTH + CONFIG while dispenser is IDLE (pre-authorization).  
When nozzle is lifted, fill starts automatically with new prices.

### 8.5 Two simultaneous fills (both sides)

Dispensers operate completely independently.  
PC polls all 4 addresses in round-robin regardless of which are active.  
Each address pair (P0+P1, P2+P3) represents a physical dispenser with two sides.

```
P0:  52 20 FA → 52 70 FA  [idle]
P1:  51 20 FA → [AUTH + data frames for active fill on P1]
P2:  52 20 FA → [AUTH + data frames for active fill on P2]
P3:  53 20 FA → 53 70 FA  [idle]
[round-robin continues]
```

---

## 9. Timing

All timing measured from captured log timestamps.

| Measurement | Value |
|---|---|
| Poll interval per dispenser | ~140 ms |
| Full round robin (4 dispensers) | **562 ms** |
| Response time (dispenser → PC) | **5–6 ms** |
| Maximum response timeout | ~300 ms |
| Data frame interval during fill | **562 ms** (one per round) |
| BUSY keepalive interval | ~1–2 poll cycles |
| Offline detection (ASFuelControl ref.) | 5 seconds = ~32 missed polls |

---

## 10. Disconnect and reconnect

### Short disconnect (~10 seconds)

```
Last response: [all dispensers] 70 FA
[cable disconnected]
PC keeps sending polls at same rate — NO backoff, NO slowdown
  52 20 FA → [no response]
  53 20 FA → [no response]
  ... 853 unanswered polls over 133 seconds ...
[cable reconnected]
  52 20 FA → 52 70 FA  ← immediate idle response
  [all dispensers respond normally on first poll after reconnect]
```

**Short disconnect behavior:** All dispensers return immediately to `70 FA`. No settlement needed. App can trust state immediately.

### Long disconnect (~133 seconds)

```
[cable disconnected for 133 seconds]
[cable reconnected]

Round 1 (flush):
  52 20 FA → 52 [seq] 02 08 00 00 00 00 00 00 00 00 [config] [CK] 03 FA
  [all dispensers send data flush frames with vol=0]
  PC → 52 C0 FA  ← ACKs each flush frame

Round 2 (settling):
  [mix of data frames and idle frames]

Round 3+ (normal):
  52 20 FA → 52 70 FA  ← back to normal
```

**Long disconnect behavior:** ASIS PCC485 queued state during disconnect and flushes it on reconnect. Wait **3 full poll rounds (~560ms × 3 = ~1.7 seconds)** before trusting state.

### PC behavior during disconnect

- Continues polling at **constant rate** — no exponential backoff
- No special reconnect handshake or initialization
- No special commands sent on reconnect
- PC just resumes normal polling and responds to whatever dispenser sends

---

## 11. Error frames and bus artifacts

### 11.1 RS485 bus turnaround garbage byte

**Root cause:** Half-duplex RS485 bus switching TX→RX briefly floats, producing a spurious byte before the real response.

```
Captured as bad frame:
  BC  53 3C 02 08 00 00 03 15 00 03 30 75 36 92 03 FA
  ↑
  garbage byte (values seen: BC, FE, FC, B8, DC, FF, DE, F8)

Actual valid frame:
  53 3C 02 08 00 00 03 15 00 03 30 75 36 92 03 FA
```

**Fix:** When starting a new frame, skip bytes until a valid address byte (`0x50–0x6F`) is found.

**Verification:** 213/213 frames in `bad_frame_poll.log` are valid after stripping the garbage byte.

### 11.2 0xFA as data byte

One frame in 695 was misidentified because `0xFA` appeared as a BCD data byte inside the frame:

```
52 3D 02 08 00 00 06 41 00 06 73 05 02 10 FA 03 FA
                                          ↑
                                  0xFA as data byte
                                  → sniffer split frame incorrectly
```

**Fix:** Frame terminator is **two bytes** `03 FA`, not just `FA`. A single `0xFA` byte within a frame is a valid data byte.

### 11.3 Frame validation rules

```
1. Collect bytes until [0x03, 0xFA] appears as the last two bytes
2. First byte must be 0x50–0x6F — if not, discard as garbage byte
3. Short frames (3 bytes): no CRC, accept if structure matches
4. Long frames: verify CRC16(init=0) over correct byte range
5. CRC mismatch: discard frame, do NOT update state machine
6. Buffer overflow (>64 bytes without terminator): clear buffer
```

---

## 12. Multi-product and multi-nozzle

### Nozzle identification from extended frames

When a dispenser has multiple products/nozzles, the nozzle-up frame and extended data frames include product and nozzle identification.

**Nozzle-up frame with product info:**
```
[addr] [seq] 03 04 01 [product_code] 00 [nozzle_code] [CK] 03 FA

Product/nozzle codes observed from Dispenser 2 Side A (P2/0x52):
  03 04 01 05 00 12  →  product=0x05 (AI-92), nozzle_code=0x12
  03 04 01 43 00 11  →  product=0x43 (AI-95), nozzle_code=0x11
```

**Price per liter by product:**
- AI-92: 10,500 sum/L (confirmed from transaction data)
- AI-95: 14,300 sum/L (confirmed from transaction data)

### Hose identification map (P2 — Dispenser 2 Side A)

| Nozzle code | Product code | Product | Price |
|---|---|---|---|
| `0x12` | `0x05` | AI-92 | 10,500 sum/L |
| `0x11` | `0x43` | AI-95 | 14,300 sum/L |

---

## 13. Captured scenarios

All scenarios sniffed at the Wayne 3490D site using the ESP32-S3 dual-channel passive sniffer.

| Log file | Scenario | Key findings |
|---|---|---|
| `from_Start_to_end_10liters.log` | Complete 10L fill | Full transaction lifecycle, vol/amount BCD confirmed |
| `missing_initial_request_105000.log` | 105,000 sum preset fill | Amount encoding confirmed |
| `full_fill.log` | Full tank fill | Full-fill preset `09 99` bytes identified |
| `stop_from_app_and_continue.log` | E-stop + continuation | Stop sequence, continuation = new AUTH |
| `2_product_from_one_side.log` | Two products same side | Nozzle/product identification bytes |
| `two_filling_same_product.log` | Simultaneous fills P2+P3 | Independent operation confirmed |
| `hose_up_down_without_filling.log` | Ghost fill (zero volume) | Zero-volume transaction abort |
| `changeprice.log` | Price change via fill | Price embedded in CONFIG frame |
| `disconnect_rs232.log` | 133s disconnect | Long reconnect flush behavior |
| `bad_frame_poll.log` | Bus artifacts | Garbage byte pattern, all 213 valid after strip |

---

## 14. Protocol source

### Identity

This protocol is the **ASIS PCC485 PC-side simplified protocol**.

The ASIS PCC485 converter translates between:
- **PC side (what we captured):** simplified 3-byte/variable-length frames at 9600 Odd
- **Dispenser RS485 side:** full Wayne DART 13-byte frames

The CRC algorithm matches **EuropumpProtocol.cs** (init=0, poly=0xA001).  
The parity and STOP command match **WayneDartV2Protocol.cs** (9600 Odd, `0x08` for STOP).  
All frame bytes are from **real captures**, not from any source code.

### Reference implementations analyzed

| File | Baud | Parity | CRC init | Compatible |
|---|---|---|---|---|
| `EuropumpProtocol.cs` | 9600 | None | 0 | CRC ✓ / Parity ✗ / STOP bug |
| `WayneDartV2Protocol.cs` | 9600 | Odd | 0 | CRC ✓ / Parity ✓ / STOP ✓ |
| `WayneDartV1Protocol.cs` | 9600 | Odd | 0 | ✓ |
| `WayneDartProtocol.cs` | 9600 | Odd | 0 | ✓ |
| `WayneDLProtocol.cs` | 9600 | Odd | 0 | CRC ✓ / frame format different |
| `WayneSUProtocol.cs` | 9600 | Odd | 0 | CRC ✓ / 13-byte frames |
| `GilbarcoProtocol.cs` | 5787 | Even | N/A | Different protocol entirely |

**Best reference:** `WayneDartV2Protocol.cs` — most compatible with our captures.

### CRC verified against all 695 captured frames

```
Total frames with 03 FA terminator:  695
Passed CRC16 (init=0, A001):         694  (99.86%)
Failed:                                1   (0.14%)
Failure reason:                       Sniffer firmware bug — 0xFA as data byte
                                      caused incorrect frame split
Real CRC failures:                    0   (0%)
```

---

*Document generated from real sniffer captures at UNG Bostonliq station.*  
*All protocol details verified against 695 frames across 10 capture sessions.*