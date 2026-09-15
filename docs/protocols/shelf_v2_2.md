# Shelf V2.2: captured gas and liquid-fuel behavior

## Evidence

The earlier captures in `docs/logs/shelf/` mainly show idle polling. The capture
`.azs-run/seriallog_20260914_101449.txt` covers 2026-09-14 10:23:47–10:26:00 and
contains one completed volume-preset sale. B>A carries requests; A>B carries
dispenser responses. Reassembling each direction independently produces 13,743
complete frames with valid CRCs. The proxy reports two startup forwarding write
timeouts, so logged bytes do not always prove successful forwarding.

At 10:25:01.589 the app authorizes address 21 with:

```text
2D 15 CC 0E 05 00 00 E8 03 00 50 2D 8E B4
```

`E8 03 00` is 1,000 hundredths (10.00 volume units); `50 2D` is the
little-endian price 11,600. The identical request is retried with index CC.
At 10:25:26.111 the final reply is:

```text
2D 15 17 11 93 05 A1 E8 03 00 20 C5 01 50 2D B1 CF
```

This reports 10.00 volume units, 116,000 amount and 11,600 price. The totalizer
increases by 10.00 too. With a petrol product these are litres and sum/litre.
The bytes themselves do not identify the fuel or measurement unit.

## Implemented behavior

- Price encoding and validation accept the unsigned two-byte range, through
  65,535. **11,600 is capture-confirmed; 65,535 is an encoding ceiling, not a
  verified physical dispenser limit.** Zero remains invalid for authorization.
- Each fueling position groups one side. Each nozzle's `shelf_address` selects
  its bus address, and `index` identifies its physical gun bit, 1–5. Legacy
  single-gun positions may omit `shelf_address` to use `address_byte`. Individual bits D1–D5 take precedence
  over aggregate D0. This prevents all positions showing a nozzle lift when a
  controller shares one bitmap across its addresses.
- During address 21's delivery, addresses 20 and 22 send extended `0x85`
  replies with active-address byte 21 and its live volume. The runtime ignores
  another gun's readings and preserves the queried gun's reservation/state.
  `0x85` is therefore not unconditionally an end-of-fill indication.
- Volume remains divided by 100; preset labels use the configured product unit.
  Shelf petrol requires a minimum of 2.00 litres in both API authorization
  routes and the protocol runtime. Money presets must cover at least two litres
  at the selected price. Gas retains its existing wire limits.
- Products whose unit is `l`, `litre`, `liter`, `litres`, `liters`, `л` or `литр`
  use the captured liquid-fuel flow: no startup price writes, no pressure
  polling, and volume/full presets carry their price directly in command `0x05`.
  Unit matching ignores case and surrounding whitespace.
- Liquid-fuel amount presets temporarily use `0x05` with volume steps computed
  by integer division `amount * 100 / price`. This rounds down to 0.01 litre;
  requests below two litres or beyond the wire limits are rejected. The original
  money preset remains in the UI and transaction metadata, while final volume
  and amount come from the completed sale. For example, 30,000 sum at 11,600/L
  requests 2.58 L (29,928 sum). The full-fill ceiling remains 999,999 sum.
- Other units retain the existing gas price/pressure exchanges and native
  `0x09` money command. Explicit price updates retain command `0x03`.
- Final `0x93` data supplies sale volume, amount and price. The runtime saves
  the transaction and reads totalizer `0x15`. The replay checks that only the
  selected gun gets a transaction. Done and the completed readings remain while
  the nozzle is lifted; an idle reply confirming nozzle return clears the lane
  to Idle without deleting the saved sale or totalizer readings.

Lifetime volume counters (`0x15` / `0xA0`, §20) are read for every configured
gun after startup/config reload, one gun per side per rotation. Failed reads
remain pending with a retry delay; reserved or active sides are deferred. The
desktop exposes the Shelf totalizer page before readings arrive and requests
a refresh when opened. This counter supplies volume only, so the Shelf
totalizer view shows a dash for lifetime money rather than a fabricated zero.

The working app also requests `0x16` after `0x93` and receives a 47-byte `0xA1`
counter reply. It reuses the final-sale index for that request. We do not infer a
mandatory handshake or change index handling from this single occurrence; the
runtime continues using the existing `0x93` plus totalizer close path.

## Software preauthorization and Cancel

Full fill currently uses an operator-selected ceiling of **999,999 sum**,
converted down to a volume preset and sent using `0x05`. At the configured
prices, the caps are AI-95: 58.82 L, AI-92: 86.20 L, and DT: 62.49 L.

Shelf now holds preauthorization in the service and sends no dose command while
waiting. A fresh idle status identifying the selected lifted gun triggers the
wire authorization. Other gun bits or another active address cannot trigger it.
The same path checks reactive orders against a fresh status before starting.

Before any authorization write, Cancel removes the local reservation, with no
serial Stop and no transaction row. HTTP cancellation sets an interlock under
the runtime lock before queuing the command, so a later lift cannot start it.
At the first authorization write the service records transaction ownership. A
missing/rejected start reply triggers terminal Stop, with ownership retained.
Cancel after that boundary sends `0x0C` and keeps the lane Finalizing until
`0x93` confirms final readings. Stop replies and duplicate Cancel never erase
the transaction. Failed database commits retain the final reading for retry.
Pause/Continue is not exposed. Reservations expire inside the Shelf loop before
start; the generic timeout task is disabled for Shelf to avoid stale cancellations.
Unsent reservations are in memory and do not survive a service restart.

The original `.ref/SHELF_2_2.pdf`, Appendix 1 (page 35), also documents hardware
queuing while holstered with a five-minute timeout. Software queuing is our
selected operator workflow. Section 11 identifies `0x0B` as Pause and section 12
identifies `0x0C` as Stop. The old app's preauth-cancel capture contains Pause;
it does not validate direct terminal Stop on this hardware.

## Configuration

`services/dispenser-service/site.config.shelf-petrol.json` contains all 18
captured addresses: three dispensers, each with two sides and three guns.
`shifts.mode` is `manual`: an operator opens/closes the shift, without a required
PIN. `ui.default_auth_mode` is `preauth`, product units are `litre`, and debug plus
serial logging are enabled. Each side is one fueling position/card with three
nozzles. Its `address_byte` is the runtime key; `nozzles[].shelf_address` routes polling and commands to
the individual gun. A side owns at most one reservation or transaction.
Idle polling discovers the lifted gun; a selected or active gun retains the
side until holstering, completion/dismissal, or cancellation. Price writes and
totalizer reads still use each individual gun address.

| Dispenser / side | Nozzle 1: AI-95 | Nozzle 2: AI-92 | Nozzle 3: DT |
|---|---:|---:|---:|
| 1 / A | 10 | 11 | 12 |
| 1 / B | 15 | 16 | 17 |
| 2 / A | 20 | 21 | 22 |
| 2 / B | 25 | 26 | 27 |
| 3 / A | 30 | 31 | 32 |
| 3 / B | 35 | 36 | 37 |
| Price, sum/litre | 17,000 | 11,600 | 16,000 |

Fuel order and prices were confirmed by the operator. `nozzles[].index` is the
physical gun number 1–3, not always 1. Set `connection.port` for the installation
(the example retains `/dev/ttyUSB0`). Select this config when starting the
service; editing it does not replace an already running service's configuration.

## Additional September 14 captures

`seriallog_PRICE_CHANGE.txt` confirms `0x03` price writes of 11,700 and 11,600
with successful replies. `seriallog_ALL_NOZZLE_LIFT.txt` confirms shared bitmaps
03/05/09 across the six groups above. The money-preset capture programs 243,000
sum as 20.94 litres using `0x05`, ending at 242,904 sum. Our documented `0x09`
money path remains separate and has not been hardware-verified by that capture.
The continue/cancel mid-fill files contain many skipped sniffer records, so
missing commands in those files do not prove that no command was sent.

## Next captures, in priority order

Use the working application for reference captures. Log both directions, begin
at least 10 seconds before each action, and continue at least 15 seconds after
the dispenser becomes idle. Note the action time, physical gun/product, bus
address if known, and displayed preset, price, volume and amount. Separate files
or timestamped notes make operator actions distinguishable from automatic polls.

1. **Cancel before delivery.** Preauthorize while holstered, then cancel. Repeat
   with the nozzle lifted but no fuel delivered. After cancellation, holster,
   lift again and start a new order to check whether the previous preset remains.
2. **Cancel during delivery.** Start a normal preset, cancel after a nonzero
   volume, then holster. Record the final volume/amount and a following order.
   Capture the dispenser's own stop control separately from the app's Cancel.
3. **Individual nozzle mapping.** Lift and holster every gun on one controller,
   one at a time, without authorization. Record the physical gun labels/products.
   Then capture a normal fill on a different gun from address 21. This tests
   shared bitmaps, active-address reporting and final-sale ownership.
4. **Money preset and full tank.** Record a money-preset completion and a full
   fill finished by holstering. Include the final physical readings, especially
   if they change after fuel flow stops. A small normal volume preset is useful
   for checking the dispenser firmware's own minimum; the service permits
   positive quantities at 0.01-unit resolution.
5. **Price change.** Change between two normal operating prices while idle,
   record the physical display, then create and complete an order. This tests
   explicit `0x03` updates versus the price embedded in `0x05`; do not infer the
   dispenser maximum from the two-byte field width.
6. **Idle reconnect after a sale.** Close/reopen the working app with all guns
   holstered after a completed sale. This shows startup counter reads, packet
   indices and whether the previous sale is replayed. Preserve any naturally
   occurring communication-loss capture too.

The list above describes verification scenarios; several now have captures as
noted above. The remaining priority for this implementation is a hardware trial
of software reservation, Cancel before lift, and direct terminal Cancel after
authorization/during delivery. Replay tests do not substitute for that trial.

A first-attempt explicit authorization rejection (`0xFF`) clears the pending
order without Stop or AmountInfo recovery: no new sale started, and `0x04`
would return the retained previous sale. Missing replies or refusals after
retries retain sale ownership because an earlier start may have been accepted.
