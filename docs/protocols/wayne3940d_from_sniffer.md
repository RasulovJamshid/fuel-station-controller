# Wayne RS232 Fuel Dispenser Protocol

Reverse-engineered from live RS232 captures between a Wayne/Dresser fuel dispenser
and its forecourt controller. All findings are empirical — no official spec available.

---

## Bus Topology

```
Forecourt Controller (master)  ←──RS232──→  Dispenser (slave)
         CH1                                      CH2
```

- Multi-drop RS232, addresses 0x50–0x53 (up to 4 pump positions per bus)
- Master (CH1) polls every address cyclically; only addressed slave responds
- Half-duplex request/response pattern
- Baud rate observed: 9600 (standard Wayne dispenser default)

---

## Frame Format

### Short frame — 3 bytes

```
┌────────┬────────┬──────┐
│  ADDR  │  CMD   │ 0xFA │
└────────┴────────┴──────┘
```

- No CRC on short frames
- Used for poll, idle-ack, and data-ACK

### Long frame — variable length

```
┌────────┬────────┬─────────────┬────────┬────────┬──────┬──────┐
│  ADDR  │  SEQ   │  PAYLOAD... │ CRC_LO │ CRC_HI │ 0x03 │ 0xFA │
└────────┴────────┴─────────────┴────────┴────────┴──────┴──────┘
```

- CRC covers all bytes from ADDR through last payload byte (see CRC section)
- 0x03 = ETX marker, 0xFA = end-of-frame
- Payload contains one or more sub-records (see Sub-Records section)

### Field definitions

| Field   | Size    | Description                                    |
|---------|---------|------------------------------------------------|
| ADDR    | 1 byte  | Pump address 0x50–0x53 (P0–P3)                 |
| CMD/SEQ | 1 byte  | Command code or sequence counter               |
| PAYLOAD | N bytes | One or more sub-records (TLV-structured)        |
| CRC_LO  | 1 byte  | Low byte of CRC-16/ARC result                  |
| CRC_HI  | 1 byte  | High byte of CRC-16/ARC result                 |
| 0x03    | 1 byte  | ETX — end of text marker                       |
| 0xFA    | 1 byte  | EOF — end of frame marker                      |

---

## Command Reference

### Short frame commands (CMD byte)

| CMD  | Direction  | Name      | Description                                         |
|------|------------|-----------|-----------------------------------------------------|
| 0x20 | CH1 → CH2  | POLL      | Status poll — master queries this address           |
| 0x70 | CH2 → CH1  | IDLE      | Idle/ready — slave has nothing to report            |
| 0xC0 | Both       | ACK       | Data acknowledge — confirms receipt of a data frame |

### Long frame sequence bytes (SEQ byte)

| SEQ       | Direction  | Name        | Description                                              |
|-----------|------------|-------------|----------------------------------------------------------|
| 0x30      | CH1 → CH2  | DISP_STATUS | Master command to dispenser; contains `01 01 [cmd]`      |
| 0x31–0x3F | CH2 → CH1  | SEQ_DATA    | Sequential dispenser data; counter wraps 0x31→0x3F→0x31 |
| 0x65      | CH1 → CH2  | REQ_TOTALS  | Request electronic totals (PROTOCOL-DERIVED)             |

**Sequence counter behaviour:**
- Starts at 0x31, increments each frame: 31 → 32 → … → 3F → 31 → …
- 0x30 is reserved for DISP_STATUS commands; never appears in the counter cycle
- Skipped numbers during mid-fill stop indicate suppressed frames

### DISP_STATUS command codes (SEQ 0x30, CH1 → CH2)

The `01 01 XX` sub-record inside a `0x30` frame carries a **command code** from the
forecourt controller to the dispenser. These are distinct from the state codes that
the dispenser reports inside SEQ_DATA (0x31–0x3F) frames.

| Code | Name      | Verification   | Description                                            |
|------|-----------|----------------|--------------------------------------------------------|
| 0x04 | GET_DISP  | LOG-VERIFIED   | Request a live display update (sent during filling)    |
| 0x05 | GO_IDLE   | LOG-VERIFIED   | Set dispenser to idle / ready state                    |
| 0x06 | AUTHORISE | PROTOCOL-DERIVED | Authorise the dispenser to begin dispensing          |
| 0x08 | HALT      | LOG-VERIFIED   | Stop dispensing immediately                            |

---

## Sub-Records (payload building blocks)

Payloads are composed of TLV-structured sub-records. Multiple sub-records
can appear in the same payload in any order.

### `01 01 XX` — Command / State Marker

| Byte | Value | Meaning                                    |
|------|-------|--------------------------------------------|
| [0]  | 0x01  | Record type: command or state              |
| [1]  | 0x01  | Length: 1                                  |
| [2]  | 0xXX  | Code — meaning depends on which frame type |

The XX byte has **different meanings** depending on the surrounding frame:

- In **SEQ 0x30** frames (master → dispenser): XX is a **command code** — see
  the DISP_STATUS command table above.
- In **SEQ 0x31–0x3F** frames (dispenser → master): XX is a **state code**:

**State Code Mapping (SEQ_DATA frames, CH2 → CH1):**

| Code | Name  | Description                                                         |
|------|-------|---------------------------------------------------------------------|
| 0x00 | NULL  | No active state — seen only in reconnect flush frames               |
| 0x01 | DONE  | Transaction complete; returning to idle polling                     |
| 0x02 | TRANS | Brief transition state between two operational states               |
| 0x04 | DISP  | Fuel actively being dispensed                                       |
| 0x05 | IDLE  | Dispenser idle and ready for next transaction                       |
| 0x06 | MULTI | Multi-product boundary (end of one grade, next starting)            |

---

### `02 08 [vol×4] [price×4]` — Fill Data

| Bytes  | Field    | Encoding           | Resolution   |
|--------|----------|--------------------|--------------|
| [0]    | 0x02     | Record type: fill  | —            |
| [1]    | 0x08     | Length: 8          | —            |
| [2–5]  | Volume   | 4-byte packed BCD  | 0.01 L/count |
| [6–9]  | Price    | 4-byte packed BCD  | 1 UZS/count  |

**BCD encoding:** each nibble is one decimal digit.
Example: `00 01 25 50` → digits 0,0,0,1,2,5,5,0 → 12550

**Example decode:**
```
02 08  00 00 05 00  00 05 25 00
             ↑vol              ↑price
vol  = BCD(00 00 05 00) = 500  → 500 × 0.01 = 5.00 L
price= BCD(00 05 25 00) = 52500 → 52,500 UZS
```

Price per litre at test site: **10,500 UZS/L** (ratio price ÷ vol_in_L is constant per session)

**Data ranges:** 4-byte BCD holds up to 8 decimal digits (max 99,999,999), giving a
maximum volume of **999,999.99 L** and a maximum price of **99,999,999 currency units**.
At UZS denomination (1 UZS/count) the wire format handles prices well above 1,000,000 UZS.
The Python reference `cmd_set_price` caps at 9,999 — a software limit for European
cent-denomination sites, not a protocol constraint.

---

### `03 04 XX …` — Type-03 Record (two sub-types)

Both variants share type `0x03` and length `0x04`. The byte at position [2]
(sub-type) determines which variant it is.

#### Sub-type `0x01` — Product / Hose ID

| Bytes  | Field       | Description                              |
|--------|-------------|------------------------------------------|
| [0]    | 0x03        | Record type                              |
| [1]    | 0x04        | Length: 4                                |
| [2]    | 0x01        | Sub-type: product/hose                   |
| [3]    | PP          | Product / grade code                     |
| [4]    | 0x00        | Reserved                                 |
| [5]    | HH          | Nozzle / hose identifier                 |

**Observed product codes:**

| PP   | HH   | Observed in                           |
|------|------|---------------------------------------|
| 0x05 | 0x12 | Product 1 (regular grade, hose side A)|
| 0x43 | 0x11 | Product 2 (premium grade, hose side B)|

> PP and HH are dispenser-configuration-dependent. The mapping above is from a
> specific test unit and may differ elsewhere.

#### Sub-type `0x00` — Unit Price (in auth block and reconnect flush)

| Bytes  | Field       | Description                                      |
|--------|-------------|--------------------------------------------------|
| [0]    | 0x03        | Record type                                      |
| [1]    | 0x04        | Length: 4                                        |
| [2]    | 0x00        | Sub-type: price                                  |
| [3–5]  | Price       | 3-byte packed BCD unit price, resolution 1 unit  |

Example: `03 04 00 09 99 00` → price = BCD(00, 09, 99, 00) = 99,900 UZS/unit.

The decoder skips this sub-type (sub-type ≠ 0x01 check). It appears inside the
master's auth block during arming and in reconnect flush frames where no product
was active.

---

## Full Transaction Flow

### IDLE (no transaction)

```
CH1 → CH2:  50 20 FA          [P0] POLL
CH2 → CH1:  50 70 FA          [P0] IDLE
CH1 → CH2:  51 20 FA          [P1] POLL
CH2 → CH1:  51 70 FA          [P1] IDLE
CH1 → CH2:  52 20 FA          [P2] POLL
CH2 → CH1:  52 70 FA          [P2] IDLE
CH1 → CH2:  53 20 FA          [P3] POLL
CH2 → CH1:  53 70 FA          [P3] IDLE
            (cycle repeats)
```

### ARMING (transaction initiated)

```
CH1 → CH2:  52 20 FA          [P2] POLL
CH2 → CH1:  52 3A 03 04 01 05 00 12 [CRC] 03 FA
                               [P2] SEQ=3A  PRD:05/NZ:12   ← mode: arming
CH1 → CH2:  52 30 01 01 04 01 01 05 [CRC] 03 FA
                               [P2] DISP GET_DISP GO_IDLE  ← compound ack
CH2 → CH1:  52 C0 FA          [P2] ACK
CH1 → CH2:  52 C0 FA          [P2] ACK

CH2 → CH1:  52 3B [preset vol + price + product] [CRC] 03 FA
                               [P2] SEQ=3B  vol=9.52L price=100000 PRD:05/NZ:12
CH1 → CH2:  52 30 [auth block — see below] [CRC] 03 FA
                               [P2] DISP GO_IDLE           ← auth/config delivered
```

**Authorization block (long `0x30` payload):**

The master's response during arming carries a multi-record configuration payload
that delivers the current unit price to the dispenser. It is always sent during
the arming handshake — there is no separate price-change command.

```
01 01 05                    GO_IDLE command
02 04 01 02 03 04           type=02 len=4 — transaction context
05 0C [12 bytes]            type=05 len=12 — channel/product config
03 04 00 [PP PP PP]         type=03 len=4 — unit price (3 BCD bytes)
01 01 06                    AUTHORISE command
```

Example auth block with price `09 99 00` (= 9990 UZS/unit):
```
53 30 01 01 05 02 04 01 02 03 04 05 0C 01 50 00 01 05 00 01 24 00 01 43
     30 03 04 00 09 99 00 01 01 06 F7 63 03 FA
```

### FILLING (fuel flowing)

```
CH2 → CH1:  52 3C 02 08 00 00 00 06 00 00 06 30 [CRC] 03 FA
                               [P2] SEQ=3C  vol=0.06L price=630 PRD:05/NZ:12
CH1 → CH2:  52 C0 FA          [P2] ACK
...
CH2 → CH1:  52 3E 02 08 00 00 05 00 00 05 25 00 [CRC] 03 FA
                               [P2] SEQ=3E  vol=5.00L price=52500 PRD:05/NZ:12
CH1 → CH2:  52 C0 FA          [P2] ACK
CH1 → CH2:  52 30 01 01 04 [CRC] 03 FA   ← periodic display request
                               [P2] DISP GET_DISP
```

### STOP (fill complete)

```
CH2 → CH1:  52 3A [status + last fill data + 01 01 05] [CRC] 03 FA
                               [P2] SEQ=3A  vol=5.00L price=52500 PRD:05/NZ:12 IDLE
CH1 → CH2:  52 30 01 01 05 [CRC] 03 FA
                               [P2] DISP GO_IDLE          ← master sets dispenser idle
CH2 → CH1:  52 3B 01 01 01 [CRC] 03 FA
                               [P2] SEQ=3B  DONE          ← transaction complete
            (returns to pure POLL/IDLE cycling)
```

### MULTI-PRODUCT (two grades from one side)

```
            (Product 1 fill completes as above, ends with MULTI marker)
CH2 → CH1:  52 3A [last fill + 03 04 01 05 00 02 + 01 01 06] [CRC] 03 FA
                               [P2] SEQ=3A  vol=5.00L price=52500 PRD:05/NZ:12 MULTI
CH1 → CH2:  52 30 01 01 05 [CRC] 03 FA
                               [P2] DISP GO_IDLE
CH2 → CH1:  52 3C 03 04 01 43 00 11 [CRC] 03 FA
                               [P2] SEQ=3C  PRD:43/NZ:11  ← product 2 armed
            (Product 2 fill proceeds as normal)
CH2 → CH1:  52 3D [last fill + 01 01 01] [CRC] 03 FA
                               [P2] SEQ=3D  vol=5.00L price=52500 PRD:43/NZ:11 DONE
```

### RECONNECT (bus cable restored after hard disconnect)

When the sniffer cable on the CH2 side is cut and reconnected, the master
continues polling throughout (CH1 is unaffected). On reconnect all dispensers
immediately send a **state flush** — one SEQ_DATA frame per position carrying
their current status (typically zero fill + state code). The master ACKs each.

```
            (CH2 cable reconnected)
CH1 → CH2:  50 20 FA          [P0] POLL
CH2 → CH1:  50 36 02 08 [zeros] 03 04 00 00 00 00 01 01 00 [CRC] 03 FA
                               [P0] SEQ=36  vol=0.00L price=0 NULL
CH1 → CH2:  50 C0 FA          [P0] ACK
CH1 → CH2:  51 20 FA          [P1] POLL
CH2 → CH1:  51 3A 02 08 [zeros] 03 04 00 00 00 00 01 01 00 [CRC] 03 FA
                               [P1] SEQ=3A  vol=0.00L price=0 NULL
CH1 → CH2:  51 C0 FA          [P1] ACK
CH1 → CH2:  52 20 FA          [P2] POLL
CH2 → CH1:  52 32 02 08 [zeros] 03 04 00 00 00 00 01 01 05 [CRC] 03 FA
                               [P2] SEQ=32  vol=0.00L price=0 IDLE
CH1 → CH2:  52 C0 FA          [P2] ACK
            (one or two more flush frames per active position, then POLL/IDLE)
```

**State code `0x00` (NULL):** Seen only in reconnect flush frames on positions
with no recent transaction. Means the dispenser has no meaningful state to
report — distinct from `0x05` (IDLE) which is a confirmed ready state.

**Null product record `03 04 00 00 00 00`:** Accompanies NULL state in flush
frames. Sub-type byte is `0x00` (not `0x01`), so the product/hose fields are
not populated — the decoder skips this record correctly.

---

### PRICE CHANGE (zero-volume transaction)

There is **no dedicated price-change command**. The unit price is always delivered
inside the authorization block that the master sends during the arming handshake.
To update the price the operator:

1. Sets the new price in the forecourt controller app.
2. Lifts the nozzle — triggers a normal arming sequence on the bus.
3. The master's auth-block response carries the new price in the type-03 sub-record.
4. The dispenser reads and stores the new price from that block.
5. Operator replaces the nozzle without dispensing → zero-volume DONE.

```
CH1 → CH2:  52 20 FA          [P2] POLL
CH2 → CH1:  52 36 03 04 01 43 00 11 [CRC] 03 FA
                               [P2] SEQ=36  PRD:43/NZ:11  ← nozzle lifted, arming
CH1 → CH2:  52 30 01 01 04 01 01 05 [CRC] 03 FA
                               [P2] DISP GET_DISP GO_IDLE ← compound ack
CH2 → CH1:  52 C0 FA          [P2] ACK
CH1 → CH2:  52 C0 FA          [P2] ACK
CH2 → CH1:  52 37 02 08 00 00 00 00 00 00 00 00 03 04 01 43 00 11 01 01 01 [CRC] 03 FA
                               [P2] SEQ=37  vol=0.00L price=0 PRD:43/NZ:11 DONE
            (returns to POLL/IDLE — dispenser has new price)
```

> The full auth block with price data is exchanged during a second arming
> round (SEQ 3B/3C onwards) in a longer transaction. The zero-volume DONE
> confirms the price update was received.

---

### GHOST FILL (nozzle lifted and replaced with no fuel dispensed)

Operator lifts the nozzle but replaces it before any fuel flows. The arming
handshake still runs to completion; the dispenser sends fill frames with vol=0
and price=0 throughout. There is no DONE frame — the transaction ends with the
dispenser returning to IDLE.

```
CH1 → CH2:  52 20 FA          [P2] POLL
CH2 → CH1:  52 35 03 04 01 05 00 12 [CRC] 03 FA
                               [P2] SEQ=35  PRD:05/NZ:12   ← nozzle lifted
CH1 → CH2:  52 30 01 01 04 01 01 05 [CRC] 03 FA
                               [P2] DISP GET_DISP GO_IDLE  ← arming ack
CH2 → CH1:  52 36 02 08 00 00 00 00 00 00 00 00 03 04 01 05 00 12 [CRC] 03 FA
                               [P2] SEQ=36  vol=0.00L price=0       ← no fuel
CH1 → CH2:  52 30 [auth block with AUTHORISE] [CRC] 03 FA
                               [P2] DISP GO_IDLE AUTHORISE
...
CH2 → CH1:  52 39 02 08 00 00 00 00 00 00 00 00 [CRC] 03 FA
                               [P2] SEQ=39  vol=0.00L price=0       ← still zero
CH2 → CH1:  52 3A 01 01 05 [CRC] 03 FA
                               [P2] SEQ=3A  IDLE                    ← nozzle replaced
CH1 → CH2:  52 30 01 01 05 [CRC] 03 FA
                               [P2] DISP GO_IDLE
CH1 → CH2:  52 30 01 01 08 01 01 05 01 01 04 [CRC] 03 FA
                               [P2] DISP HALT GO_IDLE GET_DISP      ← compound abort
            (returns to POLL/IDLE)
```

**Distinguishing from price change:** ghost fill has no DONE frame; price change
always ends with a zero-volume DONE. Externally both involve a nozzle lift
with zero fuel — only the DONE frame tells them apart on the wire.

---

### MID-FILL STOP (HALT sent by controller during active fill)

When the forecourt controller stops dispensing mid-fill (e.g., operator cancels
from the app or a preset is hit), the master broadcasts HALT to **all** pump
positions, not just the active one.

```
CH2 → CH1:  52 35 02 08 00 00 01 95 00 02 04 75 [CRC] 03 FA
                               [P2] SEQ=35  vol=1.95L price=20475   ← filling
CH1 → CH2:  52 31 01 01 08 [CRC] 03 FA
                               [P2] SEQ=31  [01 01 08]              ← HALT (unusual SEQ byte)
CH1 → CH2:  52 30 01 01 08 [CRC] 03 FA
                               [P2] DISP HALT                       ← HALT (normal)
CH1 → CH2:  53 31 01 01 08 [CRC] 03 FA   ← HALT also sent to P3
CH1 → CH2:  53 30 01 01 08 [CRC] 03 FA
CH1 → CH2:  50 31 01 01 08 [CRC] 03 FA   ← HALT also sent to P0
CH1 → CH2:  50 30 01 01 08 [CRC] 03 FA
CH1 → CH2:  51 31 01 01 08 [CRC] 03 FA   ← HALT also sent to P1
CH1 → CH2:  51 30 01 01 08 [CRC] 03 FA
CH2 → CH1:  52 38 02 08 00 00 01 95 00 02 04 75 03 04 01 05 00 12 [CRC] 03 FA
                               [P2] SEQ=38  vol=1.95L price=20475   ← frozen (skipped 36,37)
...
CH2 → CH1:  52 3B 03 04 01 05 00 12 [fill 1.95L] 01 01 05 [CRC] 03 FA
                               [P2] SEQ=3B  vol=1.95L price=20475 IDLE
CH1 → CH2:  52 30 01 01 05 [CRC] 03 FA
                               [P2] DISP GO_IDLE
CH2 → CH1:  52 3D 01 01 01 [CRC] 03 FA
                               [P2] SEQ=3D  DONE
```

**Key observations:**
- HALT is broadcast as a pair of frames per position: first a SEQ=0x31 long frame,
  then a SEQ=0x30 (DISP_STATUS) frame. The SEQ=0x31 frame direction is atypical
  (master occupying a dispenser-side sequence byte) but observed consistently.
- HALT is sent to every address (P0–P3), not only the active fill.
- The fill volume **freezes** at the instant of HALT; subsequent frames repeat it.
- The SEQ counter may **skip numbers** immediately after HALT (e.g., was at 35,
  next frame is 38 — frames 36 and 37 were suppressed).
- Transaction still ends with a proper DONE after HALT.

---

## CRC Algorithm

**CRC-16/ARC** — verified against 17 frames with 100% hit rate.

| Parameter  | Value                              |
|------------|------------------------------------|
| Polynomial | 0x8005 (reflected: 0xA001)         |
| Init       | 0x0000                             |
| RefIn      | true                               |
| RefOut     | true                               |
| XorOut     | 0x0000                             |
| Coverage   | ADDR byte through last payload byte|
| Byte order | Little-endian (lo first, hi second)|

### C Implementation

```c
uint16_t crc16_arc(const uint8_t* data, uint16_t len) {
    uint16_t crc = 0x0000;
    for (uint16_t i = 0; i < len; i++) {
        crc ^= data[i];
        for (int j = 0; j < 8; j++) {
            if (crc & 0x0001)
                crc = (crc >> 1) ^ 0xA001;
            else
                crc >>= 1;
        }
    }
    return crc;  // store as: frame[n] = crc & 0xFF; frame[n+1] = crc >> 8;
}
```

### Python Implementation

```python
def crc16_arc(data: bytes) -> int:
    crc = 0x0000
    for b in data:
        crc ^= b
        for _ in range(8):
            if crc & 1:
                crc = (crc >> 1) ^ 0xA001
            else:
                crc >>= 1
    return crc  # lo byte first in frame

# Verify frame:
frame = bytes.fromhex("523A020800000006000006 30AA61".replace(" ", ""))
data   = frame[:-4]          # all bytes before CRC_LO CRC_HI 03 FA
result = crc16_arc(data)
assert (result & 0xFF) == 0xAA and (result >> 8) == 0x61  # passes
```

---

## Address Mapping

| ADDR | Position | Description                 |
|------|----------|-----------------------------|
| 0x50 | P0       | Pump/dispenser position 0   |
| 0x51 | P1       | Pump/dispenser position 1   |
| 0x52 | P2       | Pump/dispenser position 2   |
| 0x53 | P3       | Pump/dispenser position 3   |

In multi-side installations, different sides of the same physical dispenser
may use different addresses (e.g., P2 and P3 for left/right sides).

---

## Known Frame Examples

### Poll cycle (IDLE state)

```
52 20 FA                                    P2 POLL
52 70 FA                                    P2 IDLE
```

### Arming frame (product 1)

```
52 39 03 04 01 05 00 12 4D E5 03 FA
│  │  └─────────────┘ └──────┘
│  │  03 04 01 05 00 12       product sub-record  PP=05 HH=12
│  SEQ=0x39
ADDR=0x52 (P2)
CRC = 4D E5  ✓ (CRC-16/ARC of bytes 52..12)
```

### Fill data frame

```
52 3C 02 08 00 00 04 92 00 05 16 60 03 04 01 05 00 12 00 54 03 FA
│  │  └──────────────────────────┘ └─────────────┘ └──────┘
│  SEQ=0x3C
│         02 08 fill record:
│              vol   = BCD(00 00 04 92) = 492 → 4.92 L
│              price = BCD(00 05 16 60) = 51660 → 51,660 UZS
│                            03 04 01 05 00 12 → PRD:05/NZ:12
CRC = 00 54  (little-endian)
```

### End-of-fill frame (composite)

```
52 3A 02 08 00 00 05 00 00 05 25 00 03 04 01 05 00 02 01 01 06 46 65 03 FA
         └──────────────────────────┘ └─────────────┘ └──────┘ └──────┘
         fill: vol=5.00L price=52500  PRD:05/HH:02   MULTI   CRC=46 65
```

### Master command — GET_DISP (sent during filling)

```
52 30 01 01 04 E7 5F 03 FA
│  │  └──────┘ └──────┘
│  SEQ=0x30 (DISP_STATUS)
│  01 01 04 → command = GET_DISP (request live display)
CRC = E7 5F  ✓
```

### Master command — GO_IDLE

```
52 30 01 01 05 26 9F 03 FA
         └──────┘
         01 01 05 → command = GO_IDLE
```

### Master command — HALT (stop dispensing)

```
52 30 01 01 08 [CRC_LO] [CRC_HI] 03 FA
         └──────┘
         01 01 08 → command = HALT
```

---

## Line Noise / Bus Quality

On initial bus reconnect or under poor electrical conditions, valid Wayne frames
may be prefixed with one or two garbage bytes. These bytes are always outside the
valid address range (> 0x5F) so they can be stripped without ambiguity.

**Pattern observed in `waynesnifer_3_disconnect_conect_bad_frame.log`:**

```
Raw bytes on CH2:  B8 52 70 FA          ← 1 noise byte + valid [P2] IDLE
Raw bytes on CH2:  FF FF 50 70 FA       ← 2 noise bytes + valid [P0] IDLE
Raw bytes on CH2:  DC 53 70 FA          ← 1 noise byte + valid [P3] IDLE
```

Observed noise byte values: `0x98`, `0xB8`, `0xB9`, `0xBA`, `0xBB`, `0xBC`,
`0xBE`, `0xDC`, `0xEE`, `0xF8`, `0xFC`, `0xFE`, `0xFF` — all ≥ 0x60, so they
can never be confused with a valid pump address (0x50–0x5F).

**Decoder behaviour:**

- `decoder_europump` (index 3): strips the noise prefix, decodes the underlying
  frame normally, and appends `+NOISE` to the output line.
  Example: `B8 52 70 FA` → `[P2] IDLE +NOISE`

- `decoder_unipump` (index 2): does not implement noise recovery; outputs
  `WAYNE: bad frame` for any frame whose first byte is outside 0x50–0x5F.

On a persistently noisy bus, select decoder index 3 explicitly — auto-detect
(index 4) uses `decoder_europump`'s CRC-validating probe and will reject noisy
frames before falling through to the raw decoder.

---

## Decoder Implementation

Two decoders implement this protocol in `src/decoders/`:

| Index | Name           | File                   | Notes                                |
|-------|----------------|------------------------|--------------------------------------|
| 2     | Wayne RS232    | `decoder_unipump.cpp`  | Empirically derived from captures    |
| 3     | Wayne Europump | `decoder_europump.cpp` | Reference-validated; noise-tolerant  |
| 4     | Auto-detect    | `decoder_runner.cpp`   | Probes Europump first, then Wayne    |

Both decoders parse identical frame structures and sub-records. The key difference
is in the SEQ 0x30 (DISP_STATUS) branch: `decoder_unipump` uses a single lookup
table for all `01 01 XX` values, so master command codes in 0x30 frames are labelled
with dispenser state names (e.g., command 0x04 / GET_DISP appears as "DISP").
`decoder_europump` uses separate tables and correctly distinguishes master command
codes (GET_DISP, GO_IDLE, AUTHORISE, HALT) from dispenser state codes (DONE, TRANS,
DISP, IDLE, MULTI, NULL).

**`decoder_europump` output format (index 3):**

```
[P2] POLL                              ← short poll (master)
[P2] IDLE                              ← short ready (dispenser)
[P2] ACK                               ← data acknowledge
[P2] DISP GET_DISP                     ← master requests display update
[P2] DISP GET_DISP GO_IDLE             ← compound master commands in one frame
[P2] DISP GO_IDLE                      ← master sets dispenser idle
[P2] DISP HALT                         ← master stops dispensing
[P2] DISP AUTHORISE                    ← master authorises dispensing (PROTOCOL-DERIVED)
[P2] SEQ=3C vol=4.92L price=51660 PRD:05/NZ:12
[P2] SEQ=3A vol=5.00L price=52500 PRD:05/NZ:12 MULTI
[P2] SEQ=3B DONE
[P2] SEQ=3C PRD:43/NZ:11               ← arming, product 2
[P2] SEQ=3D vol=5.00L price=52500 PRD:43/NZ:11 DONE
[P2] REQ_TOTALS                        ← request electronic totals (PROTOCOL-DERIVED)
[P2] DISP GET_DISP !CRC                ← frame with bad checksum
[P2] IDLE +NOISE                       ← short frame with noise prefix stripped
```

**`decoder_unipump` differences (index 2):** short frames, SEQ frames, and
fill/product/state sub-records produce identical output. The 0x30 branch differs:

```
[P2] DISP DISP                         ← 01 01 04 (actually GET_DISP)
[P2] DISP IDLE                         ← 01 01 05 (actually GO_IDLE)
[P2] DISP MULTI                        ← 01 01 06 (actually AUTHORISE)
[P2] DISP ?                            ← 01 01 08 (actually HALT)
```

**Auto-detect (index 4):** probes `decoder_europump` first (address + structure +
CRC), then `decoder_unipump`. Frames with corrupt checksums or noise prefixes will
not auto-detect — select index 3 explicitly on noisy buses.
