# Tatsuno dispenser protocol research

Research date: 2026-09-29. Scope: communication options, relevance to Uzbekistan
and Central Asia, and implications for this repository. This is a research note;
it is not a verified wire specification or an implemented driver.

For an Uzbekistan-focused integration, investigate **Tatsuno PDE first**. This is
a provisional engineering priority based on documented supply and support, with
limited confidence about actual prevalence. No reliable public comparison of
installed PDE and SS-LAN dispensers in Uzbekistan was found. Availability,
manufacturer sales coverage, and equipment listings do not establish market
share. The evidence below is also insufficient to rank protocols across all of
Central Asia.

Tatsuno Europe explicitly assigns sales coverage for Uzbekistan, Kazakhstan, and
Turkmenistan. This establishes a regional support route for identifying equipment
and requesting protocol documentation. [Manufacturer contacts](https://www.tatsuno-europe.com/_en/contacts/).

An Uzbekistan-facing AZS Komplekt catalog lists Tatsuno Rus LPG dispensers and
hosts a BMP 2000 OCEAN manual describing PDE electronics, with an alternative
controller option. The catalog displays a Russian contact number: treat this as
evidence of an offer targeting the market, not proof of local installations.
[Supplier catalog](https://www.azsk74.uz/toplivorazdatochnye-kolonki/gazorazdatochnye_kolonki.html?SHOWALL_1=1),
[manufacturer manual hosted by the supplier, p. 4](https://www.azsk74.uz/upload/iblock/27b/rukovodstvo-po-ekspluatatsii-trk-vmr-2000os.pdf#page=4).

In Kazakhstan, Petrol Tech Snab advertises supply, installation, commissioning,
and maintenance of Tatsuno Rus dispensers. This is another regional supply and
service signal, without an installed-base count.
[Supplier's equipment page](https://petrol-ts.kz/toplivorazdatochnie-kolonki/).

There is no single protocol selected by the Tatsuno brand name:

| Equipment/interface family | What the sources establish | Integration consequence |
| --- | --- | --- |
| Tatsuno Europe / former Benč | OCEAN documentation specifies PDE over RS-485 as standard. | Start by identifying the actual calculator and external interface. |
| Tatsuno Rus BMP 2000 | The manufacturer's manual describes PDE electronics and an optional ТСБТ-БУ controller. | Record board and firmware details; the cabinet model alone is insufficient. |
| Tatsuno Japan SS-LAN | Technotrade documents Tatsuno SS-LAN at 19,200 baud through an RS-485 pump channel. | Plan a separate protocol implementation from PDE. |
| Converted interfaces | OCEAN documentation allows converters to other protocols, including PUMA LAN, ER4, IFSF-LON, and Tatsuno Party Line. | Identify the interface exposed to the station controller. |
| PDEX / PDEX5 | Manufacturer-hosted type documentation identifies these as calculator families that can communicate using PDE or other protocols. | A board label is useful identification, but does not fully specify the wire protocol. |

Sources: [OCEAN installation manual, pp. 39–40](https://www.tatsuno-europe.com/files/ckeditor/ke%20stazeni-en/ocean_install/IN024-EN_OceanInstructionsRev06c.pdf#page=39),
[Tatsuno Rus BMP 2000 manual, revision 8.4, p. 7](https://tatsuno.ru/upload/iblock/956/2023.07_RE-8.4_VMR-2000.pdf#page=7),
[Technotrade PTS technical guide](https://www.technotrade.ua/downloads_en/file249392696708.pdf),
[calculator descriptions, p. 4](https://www.tatsuno-europe.com/files/ckeditor/ke%20stazeni-en/MID/TCM141_07-4491add13_ENG.pdf#page=4).

The Japanese manufacturer also explicitly identifies SS-LAN as RS-485 and
describes POS operations including price setting, presets, and totalizer reads.
That establishes available functions, but does not disclose their command bytes.
[Tatsuno SS system brochure](https://tatsuno-corporation.com/jp/wp-content/uploads/sites/2/2024/07/AQ10bB-SS-System.pdf).

The most useful PDE specification lead is the exact document title cited by
Topaz's own service software page:

> Communication protocol for use between the controlling computer and a dispenser counter PDE

The cited author is BG Elektronik and the year is 1999. Request the applicable
revision and any extensions for the actual dispenser firmware; a historical
reference does not prove compatibility with every current calculator.
[Topaz manufacturer page](https://www.topazelectro.ru/product/azs/program/service_po/nastroika_topaz106k).

The serial settings need verification on the target equipment. An older
Technotrade guide lists **9,600 / 19,200 baud for Tatsuno Benč PDE**, and
**19,200 for Tatsuno SS-LAN**. Its later PTS-U3 guide specifies 19,200 for the
illustrated PDE connection. These are useful starting points, not universal
settings. This research did not establish parity, data bits, and stop bits for
the unknown target dispenser.
[Older PTS guide](https://www.technotrade.ua/downloads_en/file249392696708.pdf),
[PTS-U3 guide](https://www.technotrade.ua/downloads_en/file315403376031.pdf).

The OCEAN manual distinguishes communication errors E17 (including a late host
acknowledgment) and E18 (communication loss). A future runtime therefore needs
verified acknowledgment and timeout behavior, beyond a parser that merely reads
meter values. The manual is an installation and operating reference, not a
complete packet specification.
[OCEAN error table, p. 67](https://www.tatsuno-europe.com/files/ckeditor/ke%20stazeni-en/ocean_install/IN024-EN_OceanInstructionsRev06c.pdf#page=67).

No complete, manufacturer-verified command specification for the target hardware
was obtained. In particular, the following remain open:

| Area | Information needed before implementing commands |
| --- | --- |
| Framing | Delimiters, lengths, escaping, checksum algorithm and coverage |
| Addressing | Mapping between dispenser, side, product, nozzle, and wire address |
| Startup | Initialization sequence and any startup acknowledgment requirements |
| Polling | Status commands, acknowledgment rules, timing, retries, offline behavior |
| Authorization | Price, amount/volume preset, full-tank mode, accepted/rejected state |
| Control | Stop, cancel, and whether resume is supported |
| Meter values | Field widths, encoding, decimal scaling, rounding, overflow |
| Completion | Final sale retrieval, acknowledgment, release, duplicate handling |
| Recovery | Power failure, reconnect, retained sale, and totalizer behavior |

Search results containing packet examples or another manufacturer's SS-LAN
document are insufficient to establish Tatsuno application-command compatibility.
Do not copy those bytes into a production driver without a matching specification
and captured exchanges from the target firmware.

For this repository, inspection found no Tatsuno protocol variant or runtime.
The existing serial configuration supports configurable baud rate, parity, data
bits, and stop bits. A native integration fits the current architecture:

1. Add a distinct codec crate, initially for the verified family, such as
   `crates/tatsuno-pde`; keep SS-LAN separate if it is subsequently required.
2. Register the protocol in `crates/config/src/lib.rs` and add its runtime under
   `services/dispenser-service/src/engine/protocols/`.
3. Dispatch it through `services/dispenser-service/src/engine/poll_loop.rs`, and
   update configuration validation, schema, and configuration editors together.
4. Follow the runtime contract in `protocols/mod.rs`: own protocol timing, use
   `shared::mark_missed`, and close sales through `shared::commit_sale` or the
   documented persistence path.
5. Use captured exchanges with `shared::FakeSerial` to verify framing and actual
   transaction behavior, including duplicate replies and interrupted sales.

These are proposed implementation steps derived from the local code, not work
completed by this research. A generic `tatsuno` option would hide the distinction
between incompatible interfaces.

To resolve the remaining uncertainty, collect the full dispenser model, country
of manufacture, calculator/controller board, firmware version, interface or
converter label, and current station-controller protocol setting from a few
representative target stations. For regional prioritization, count fueling
positions by confirmed protocol rather than counting online advertisements.

Then obtain the matching protocol specification and timestamped bidirectional
captures of startup, idle polling, nozzle lift/return, amount and volume presets,
full-tank authorization, dispensing, stop, final readings, totalizers, and
reconnection. Record the displayed price, volume, amount, side, and nozzle with
each scenario. Capture an existing working exchange before designing new command
sequences; do not introduce a second active master onto an operating bus.

Tatsuno Europe's current contact page lists technical support at
`support@tatsuno.eu` and identifies the commercial contact responsible for
Uzbekistan. A documentation request should include the hardware identifiers and
ask specifically for PDE framing, command tables, test vectors, timing, and
firmware-specific extensions. [Official contact page](https://www.tatsuno-europe.com/_en/contacts/).
