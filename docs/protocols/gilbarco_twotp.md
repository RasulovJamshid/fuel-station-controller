# Gilbarco Two-Wire Protocol (TWOTP-IS-1.0-S)
## Reverse Engineering Documentation

**Dispenser model:** Gilbarco (multi-nozzle, 4 nozzles per side)  
**Interface:** RS-232 direct serial (two-wire)  
**Sniffed:** RS-232 line between PC and dispenser controller  
**Tool:** Custom ESP32-S3 passive dual-channel RS-232 sniffer  
**Reference cross-checked:** ASFuelControlV1 (C# implementation)  
**Date:** June 2026  

---

## Table of Contents

1. [Hardware setup](#1-hardware-setup)
2. [Serial port settings](#2-serial-port-settings)
3. [Device addresses](#3-device-addresses)
4. [Protocol echo](#4-protocol-echo)
5. [LRC checksum](#5-lrc-checksum)
6. [Single-byte commands](#6-single-byte-commands)
7. [Multi-byte commands](#7-multi-byte-commands)
8. [Response parsing](#8-response-parsing)
9. [Transaction lifecycle](#9-transaction-lifecycle)
10. [Price scale](#10-price-scale)
11. [Timing](#11-timing)
12. [Captured scenarios](#12-captured-scenarios)

---

## 1. Hardware setup

```
Station PC
    │
    │ RS-232 (9600 baud, no parity)
    │ ← THIS LINE IS SNIFFED →
    │
Gilbarco dispensers (up to 6 addresses per bus)
    │
    ├── Dispenser 1 Side A  (addr 0x01)
    ├── Dispenser 1 Side B  (addr 0x02)
    ├── Dispenser 2 Side A  (addr 0x03)
    ├── Dispenser 2 Side B  (addr 0x04)
    ├── Dispenser 3 Side A  (addr 0x05)  ← offline in captured site
    └── Dispenser 3 Side B  (addr 0x06)  ← offline in captured site
```

Each physical dispenser has two sides (fueling positions), each with up to 4 nozzles.  
The captured site had 3 dispensers (2 working), 4 nozzles per side (3 active, nozzle 4 locked — 3 tanks only).

---

## 2. Serial port settings

| Parameter | Value |
|---|---|
| Baud rate | **9600** |
| Parity | **None** |
| Data bits | 8 |
| Stop bits | 1 |
| Flow control | None |

> **Important:** current site captures are from the 9600/no-parity setup. Older 5787/even captures are kept under legacy log folders for reference only.

---

## 3. Device addresses

Each dispenser side has a unique 1-based integer address byte.

| Label | Address byte | Notes |
|---|---|---|
| Dispenser 1 Side A | `0x01` (1) | Active |
| Dispenser 1 Side B | `0x02` (2) | Active |
| Dispenser 2 Side A | `0x03` (3) | Active |
| Dispenser 2 Side B | `0x04` (4) | Active |
| Dispenser 3 Side A | `0x05` (5) | Offline (hardware fault) |
| Dispenser 3 Side B | `0x06` (6) | Offline (hardware fault) |

The PC polls every address in sequence every ~200 ms. Addresses with no response after `offline_threshold_polls` polls are marked offline.

---

## 4. Protocol echo

The Gilbarco dispenser **always echoes the received command byte(s) as the first byte(s) of its response**. This is a protocol-level echo, not RS-485 hardware echo.

- Single-byte command → dispenser echoes 1 byte, then sends data
- `GetNozzle` (9-byte command) → dispenser echoes all 9 bytes, then sends 19 bytes of data

**Our serial.rs strips the echo** before returning the buffer to parsers. All parser functions in this codebase receive **echo-stripped** buffers.

Example (status poll for addr 2):
```
PC sends:         02
Dispenser echoes: 02  (stripped by serial.rs)
Dispenser data:   62  (status byte → Idle)
Parser receives:  [62]
```

---

## 5. LRC checksum

Used only on multi-byte commands (SetPrice, PresetAmount, GetNozzle).

```
Algorithm:
  bLRC = 0
  for each byte in frame (excluding terminator 0xF0):
      bLRC = (bLRC + byte) & 0x0F   // nibble sum
  LRC = ((bLRC ^ 0x0F) + 1) & 0x0F
  return LRC | 0xE0
```

Result is a single byte in range `0xE0..=0xEF`, placed second-to-last before `0xF0`.

---

## 6. Single-byte commands

All single-byte commands are derived from the address byte by adding an offset.

| Command | Formula | Hex (addr=2) | Response bytes (raw, with echo) |
|---|---|---|---|
| GetStatus | `addr` | `02` | 2 (echo + status) |
| Authorize | `addr + 16` | `12` | 1 (echo only) |
| ListenMode | `addr + 32` | `22` | 1 (echo + listen confirm) |
| Halt | `addr + 48` | `32` | 1 (echo only) |
| GetTransaction | `addr + 64` | `42` | 34 (echo + 33 data bytes) |
| GetTotals | `addr + 80` | `52` | 95 (echo + 94 data bytes) |
| GetDisplay | `addr + 96` | `62` | 7 (echo + 6 BCD bytes) |

After echo stripping by serial.rs, subtract 1 from every "Response bytes" count above.

---

## 7. Multi-byte commands

Multi-byte commands are sent while the pump is in ListenMode (`0xD1..0xDF` status).

### 7.1 GetNozzle

Query which nozzle is currently lifted. Fixed 9-byte frame, same for all addresses.

```
FF E9 FE E0 E1 E0 FB EE F0
```

Response (raw with echo): 28 bytes = 9 echo + 19 data.  
After echo stripping: 19 bytes.  
Nozzle ID byte at **buf[14]** (0-based, after stripping):

| Byte value | Nozzle |
|---|---|
| `0xB1` | Nozzle 1 |
| `0xB2` | Nozzle 2 |
| `0xB3` | Nozzle 3 |
| `0xB4` | Nozzle 4 |

Verified from log: `multifillv2.log` — nozzle 2 lifted → buf[14] = `0xB2`.

### 7.2 SetPrice

Set the price for a specific nozzle. Must be in ListenMode first.

```
Frame: FF E5 F4 F6 [NozzleID] F7 [p0] [p1] [p2] [p3] FB [LRC] F0
```

- `NozzleID` = `0xDF + nozzle_index` (nozzle 1 → `0xE0`, nozzle 2 → `0xE1`, etc.)
- `p0..p3` = price encoded as 4 BCD bytes, LSB first (`0xE0 | digit`)
- Max price: 4 digits (0–9999)

### 7.3 PresetAmount

Money preset (full-amount authorization). Must be in ListenMode first.

```
Frame: FF E5 F2 F8 [a0] [a1] [a2] [a3] [a4] [a5] FB [LRC] F0
```

- `a0..a5` = amount encoded as 6 BCD bytes, LSB first (`0xE0 | digit`)
- Not observed in captured logs at this site (operators did not use amount preset)

---

## 8. Response parsing

### 8.1 Status byte (1 byte after echo stripping)

Returned by GetStatus command.

| Range | Meaning |
|---|---|
| `0x61..0x6F` | Idle |
| `0x71..0x7F` | NozzleLifted |
| `0x81..0x8F` | Authorized |
| `0x91..0x9F` | Delivering |
| `0xA1..0xBF` | TransactionComplete |
| `0xC1..0xCF` | Stopped |
| `0xD1..0xDF` | ListenMode (pump accepted listen command) |
| anything else | Offline / unknown |

### 8.2 GetDisplay (6 bytes after echo stripping)

Returns live dispensed amount during delivery.

```
buf[0..6]  — 6 BCD bytes, LSB first (0xE0|digit)
```

Decode: `value = sum(digit[i] * 10^i for i in 0..6)`.  
Divide by 10 to get displayed sum on pump.

Example from log (during 10L fill): `E0 E2 E2 E0 E0 E0` → raw 220.

### 8.3 GetNozzle (19 bytes after echo stripping)

```
buf[14]  — nozzle identifier byte (0xB1..0xB4)
```

### 8.4 GetTransaction (33 bytes after echo stripping)

Final transaction data after fill completes.

```
buf[12..16]  — unit_price_raw  (4 bytes, LSB first)
buf[17..23]  — volume_raw      (6 bytes, LSB first)
buf[24..30]  — amount_raw      (6 bytes, LSB first)
```

All fields use the same BCD encoding: `value = sum((byte & 0x0F) * 10^i)`.

**Verified from log** (`fill_10litre_from_start_to_end.log`):
- `unit_price_raw` = 1100 → price 1100 (÷10 to get real sum: 11000 sum/L)
- `volume_raw` = 10000 → 10.000 L (÷1000)
- `amount_raw` = 11000 → 110000 sum (÷10)

### 8.5 GetTotals (94 bytes after echo stripping)

Accumulated pump totals per nozzle. Called once after each GetTransaction.

Frame structure (94 bytes, 3 active nozzles):
```
buf[0]        — 0xFF frame header
buf[1 + 30*n] — 0xF6 nozzle section header  (n = 0-based nozzle)
buf[2 + 30*n] — 0xE0|n nozzle index byte
buf[3 + 30*n] — 0xF9 volume marker
buf[4 + 30*n .. 12 + 30*n]  — 8 BCD bytes volume total (LSB first)
buf[12+ 30*n] — 0xFA price marker
buf[13+ 30*n .. 21 + 30*n]  — 8 BCD bytes price total (LSB first)
buf[21+ 30*n] — 0xF4 marker
buf[22+ 30*n .. 26 + 30*n]  — 4 bytes (sub-total or date, not decoded)
buf[26+ 30*n] — 0xF5 marker
buf[27+ 30*n .. 31 + 30*n]  — 4 bytes (not decoded)
```

For nozzle `n` (1-based), the parser uses:
- `vol_start  = 4 + 30 * (n - 1)`
- `price_start = 13 + 30 * (n - 1)`

**Verified from log** (`fill_10litre_from_start_to_end.log`, addr 2, nozzle 1):
- `volume_total_raw` = 26634966
- `price_total_raw`  = 82780267

---

## 9. Transaction lifecycle

```
PC polls addr every 200ms:

  Idle (0x61-0x6F)
    │
    │  customer lifts nozzle
    ▼
  NozzleLifted (0x71-0x7F)
    │  PC sends: ListenMode → GetNozzle (identifies which nozzle)
    │  PC emits: NozzleUp event to app
    │  App sends: Authorize command
    │
    ▼
  Authorized (0x81-0x8F)
    │  PC sends: Authorize single-byte command
    │
    ▼
  Delivering (0x91-0x9F)
    │  PC polls: GetDisplay every iteration → live amount to UI
    │
    ▼
  TransactionComplete (0xA1-0xBF)
    │  PC sends: GetTransaction → parse volume/amount/price
    │  PC sends: GetTotals      → log pump odometer
    │  PC emits: Done event to app, persists to DB
    │
    ▼
  Idle (next poll)
```

**Pre-authorization flow** (operator authorizes before nozzle lift):
- App queues an `Authorize` command
- When pump reaches `NozzleLifted`, PC skips the `NozzleUp` event and immediately sends Authorize
- Pump transitions directly to Authorized → Delivering

**ListenMode sequence** (required before GetNozzle or SetPrice):
1. PC sends `ListenMode` command (`addr + 32`)
2. Pump responds with a byte in `0xD1..0xDF` (confirms listen mode)
3. PC immediately sends the multi-byte command (GetNozzle or SetPrice)

---

## 10. Price scale

The pump internally stores prices as a **4-digit integer** (max 9999) encoded in BCD.  
**The pump display shows one fewer digit than the real price** — this is a hardware limitation because the Uzbek sum requires more digits than the pump register can hold.

| Real price (sum/L) | Pump register / display |
|---|---|
| 12500 | 1250 |
| 15500 | 1550 |
| 10800 | 1080 |

**Config stores the real price.** The `price` field in `site.config.json` nozzles holds the full value (e.g., 12500). The Gilbarco poll loop divides by 10 before calling `set_price()` to fit the pump register:

```
pump_register = config_price / 10
```

**Amounts from GetTransaction are also in pump scale.** The poll loop multiplies `amount_raw × 10` before storing to DB and emitting the Done event, so operators and reports always see the real sum.

**GetDisplay during delivery** is similarly scaled: `raw_amount × 10` = real dispensed sum.

This conversion is transparent to the app — it always sees and receives real prices and amounts.

---

## 11. Timing

Observed from logs:

| Operation | Observed delay |
|---|---|
| Status response | ~80 ms after command |
| ListenMode confirm | ~50 ms |
| GetNozzle response | ~50 ms after command |
| GetTransaction response | ~100 ms after command |
| GetTotals response | ~130 ms after command |
| Poll cycle (6 addresses) | ~1.2 s total |

Recommended `response_timeout_ms`: **500 ms** (safely covers all commands including GetTotals).

---

## 12. Captured scenarios

| File | Description |
|---|---|
| `docs/logs/gilbarco/idle.log` | Idle bus poll, all 6 addresses, format reference |
| `docs/logs/gilbarco/fill_10litre_from_start_to_end.log` | Complete single fill: Idle → NozzleLifted → Authorize → Delivering → Done. Used to verify GetTransaction and GetDisplay offsets. |
| `docs/logs/gilbarco/only_pc_side_with_nozzle_lift_and_start_fill_command.log` | PC-only capture (no dispenser responses). Confirms correct command sequences. |
| `docs/logs/gilbarco/5787/multifillv2.log` | Two simultaneous fills (addr 2 and 3). Used to verify GetNozzle nozzle-ID offset (buf[14]). |
| `docs/logs/gilbarco/5787/103000sum_filling.log` | Single fill totalling 103000 sum. Additional GetTransaction verification. |
