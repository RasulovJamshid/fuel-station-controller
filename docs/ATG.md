# ATG configuration and deployment

ATG monitoring is separate from dispenser protocols. Each physical tank has one
stable `tank_id`, a product, a capacity in litres, and an opening volume. Several
tanks may contain the same product. New editor entries default to 25,000 L; enter
the actual capacity of each tank.

## Configuration

```json
{
  "tanks": [
    {"tank_id":"tank-a","product_id":1,"label":"AI-92 A","capacity_l":25000,"current_l":0},
    {"tank_id":"tank-b","product_id":1,"label":"AI-92 B","capacity_l":18000,"current_l":0}
  ],
  "atg": {
    "enabled":true,
    "export_enabled":false,
    "poll_interval_secs":300,
    "modbus_timeout_secs":10,
    "stale_after_secs":600,
    "branches":[{
      "id":1,"external_station_id":122,
      "host":"192.168.1.10","port":502,"unit_id":1,
      "start_register":1000,"address_base":1,"register_count":24,
      "word_order":"ABCD","height_unit":"mm",
      "slots":[
        {"slot":1,"tank_id":"tank-a","product_id":1,"type":"AI-92"},
        {"slot":2,"tank_id":"tank-b","product_id":1,"type":"AI-92"}
      ]
    }]
  }
}
```

- Controller `id` is unique locally. `external_station_id` is the receiving API's
  station identity; several controllers can share it. Legacy configurations use
  controller `id` as the external station ID when none is supplied.
- Slots start at 1 and use 12 holding registers / six float32 values each:
  product height, water height, temperature, combined volume, product volume,
  water volume. Sparse slots are supported. This driver implements this layout;
  confirm it against the installed controller's register map.
- There is no four-slot cap. `register_count` must cover the highest configured
  slot, be a positive multiple of 12, and fit the Modbus address space. Reads are
  split into requests of at most 120 registers, with complete tanks in each.
- `word_order`: ABCD, CDAB, BADC, or DCBA. `height_unit`: `mm` or `m`.
  Local/cloud height values are converted to millimetres. External integration
  metadata retains the configured controller height unit; controllers combined
  into the same external fuel group must use the same unit.
- `tanks[].capacity_l` is authoritative. Linked slot capacity/max-volume overrides
  must agree; they can be omitted. External volume percentages derive from the
  physical tank capacities. Optional `maxima` supports additional measurement
  percentages and integration-only slots without local products.
- Poll interval: 1–86400 seconds; request timeout: 0.1–120 seconds. Freshness
  defaults to twice the poll interval, with a minimum of 30 seconds. An explicit
  `stale_after_secs` must be at least the poll interval and at most seven days.
- `enabled:false` retains settings and stops polling/export. `export_enabled:false`
  stops external reporting while keeping local readings and normal backend sync.
  Absent/null `atg` also disables monitoring.

The service freezes unambiguous legacy tank IDs into the configuration at startup.
Existing explicit IDs are preserved; legacy label-based identities are migrated
once. Ambiguous same-product mappings require explicit IDs. Renaming a label does
not rename a tank. Reusing an existing ID for a different physical tank mixes its
history and must be avoided.

## Administration and status

Desktop administration provides tank/controller/slot editing, controller testing,
subnet discovery, float ordering, height units, and external credentials. Discovery
uses the selected controller settings; an empty tank is a valid result. Manual
host/subnet selection works without an internet/default route. Reading a Modbus
window cannot distinguish an unused all-zero slot from an empty physical tank;
configure the actual installed probes explicitly.

`/admin/atg-config` (GET/POST) and `/admin/atg-discover` require an admin bearer
session. GET returns credential-presence flags, never saved tokens/passwords.
Omitted credential fields retain their values; empty strings clear individual
fields; `auth:null` clears stored authentication. Empty `api_url` is saved as empty.
Legacy environment overrides are listed in the desktop; `export_enabled:false`
also disables an environment-configured export destination.

Every configured tank remains visible, including tanks without active nozzles.
Status distinguishes waiting, fresh, stale, offline, and disabled. Reconciliation
requires fresh readings for every tank included in a measured product total.
Invalid/negative/non-finite measurements cannot become stock readings; zero volume
is valid. An incomplete external station/fuel group is withheld rather than sent
as a complete total. Volumes aggregate across all controllers in that group.

External HTTP delivery runs independently of polling. Pending payloads survive
restart in SQLite `atg_outbox`, retain their original destination, and retry with
backoff. Old-destination records remain pending if the URL changes; they are not
sent to the new destination. Pending counts/errors appear in ATG administration.
A permanently rejected record holds subsequent records for that destination to
preserve ordering: correct the destination/authentication or investigate its
reported error. Delivery is at least once; the recipient should deduplicate on
station, fuel type, and source timestamp after an ambiguous HTTP timeout.

The station tank catalog is authoritative for synced cloud tanks (labels, products,
capacities, monitoring, active membership). Cloud-only manual tanks remain editable.
Changing a station-managed tank should use station administration; web configuration
is a downloadable installation draft, as before, and does not push live changes.

## Stock accounting

Deliveries require `tank_id` when a product has multiple tanks. Stock records and
readings retain physical tank IDs. Product-level reconciliation remains the default:
all tanks for a product are combined and product sales are subtracted once.

For per-tank reconciliation, pass `tank_id` to `/wetstock/preview` or
`/wetstock/reconcile`. If the product has multiple tanks, configure the tank's
`nozzle_sources` as `[{"fp_id":"FP1","nozzle_index":1}]`. Each nozzle can belong
to only one tank. Manifold/shared supplies with no defensible per-tank allocation
must use the combined product balance. Keep supply mappings fixed within an
accounting period; close/review balances when physically changing supply routing.
Historical product-only deliveries that cannot be assigned to one tank block
per-tank reconciliation rather than silently disappearing from its balance.

Backend `/reservoirs/stock-records` exposes synced delivery/reconciliation history
for accessible stations, with optional `stationId` and `tankId` filters.
Local `/deliveries` and `/wetstock/reconciliations` accept an optional `tank_id`
filter; omitting it retains the complete product history.

## Existing stations that cannot be upgraded

The backend can be upgraded while those stations keep their existing service,
desktop and configuration. No station access, configuration edits, new API keys,
or catalog messages are required for legacy reading ingestion.

- Original `reservoir_reading` messages remain accepted. A product ID can be
  omitted when older clients do not send it; existing tank metadata supplies it,
  with the original zero fallback for a newly discovered tank. Numeric timestamps
  and ISO date strings are supported. Height values retain their submitted units;
  the server cannot infer or correct a legacy controller's physical unit setting.
- Existing tank IDs, labels and capacities are preserved. Newly discovered tanks
  remain editable in the dashboard, with product names resolved from station
  nozzles when absent. Only an explicit `tank_catalog` from an upgraded service
  transfers metadata ownership to the station. Legacy sites do not receive a
  guessed stale interval in the dashboard; the last received reading is shown.
- Old delivery/reconciliation messages without `tank_id` remain accepted.
- Sync acknowledgements include identical `accepted`/`rejected` arrays at the
  root and inside `data`, supporting both generations of station decoders.
  The station price endpoint returns the original bare array, which both old
  and current station decoders accept. Other API envelopes are unchanged.
- The public `tank.reading` webhook retains `tankId`, `reservoirId`,
  `volumeLitres`, `fillPercent`, `levelMm`, and `readingAt` for every station.
- Station configuration backups are accepted and returned without imposing the
  new binary's physical-tank validation or rewriting legacy ATG settings.

Stricter startup validation applies only if a station binary is subsequently
upgraded; a central backend deployment cannot trigger it in an unchanged app.
Stations can be upgraded separately when access becomes available.

The server can process only records a client transmits. Historical data already
discarded by an older backend, or local records whose old client has exhausted its
retry limit, cannot be recovered by this backend change alone. New messages and
records still being retried use the compatible response formats above.

## Rollout and verification

1. Back up the backend database and station configuration/database.
2. Deploy the backend migration `20261006000000_atg_physical_tanks` and backend
   handlers **before** upgrading station services. Regenerate Prisma Client.
   The migration consolidates duplicate reservoir/timestamp samples before adding
   their unique index; review migration duration on large histories.
3. For accessible stations being upgraded, upgrade the station service and desktop
   together. Other stations may continue using their existing apps. Local migration 013 creates
   the export outbox and physical tank columns. Startup requeues historical stock
   records once; the new backend repairs records previously acknowledged without
   being stored. Unambiguous legacy delivery tank IDs are backfilled.
4. Confirm actual tank capacities, product/probe mappings, register layout, float
   order and height units. Test controllers and compare volumes to their displays.
   The saved AZT examples now align their capacities with their existing 25,000 L
   ATG settings. Their external fuel labels still require installation-specific
   confirmation; aliases cannot safely be inferred from product names.
5. Verify unplug/reconnect, empty tank, export outage/recovery, and restart using
   the installed hardware before production acceptance.

Software verification without hardware:

```sh
cargo test -p atg -p site_config
cargo test -p dispenser-service wetstock_queries
npm --workspace=@azs/backend test -- --runInBand stock-sync.spec.ts service-config.validation.spec.ts sync.service.spec.ts
npm --workspace=@azs/backend run build
node tools/checks/legacy_atg_backend.cjs
cargo build -p dispenser-service
python3 tools/checks/atg_service.py
```

The Python check starts only localhost simulators and a temporary service/database,
verifying 12 same-product tanks, batched CDAB reads, metre conversion, empty tanks,
admin authentication, failed export isolation, offline reconciliation, delivery
identity, disable/re-enable, credential clearing and restart replay. It does not
contact physical devices or external APIs.

The backend compatibility check exercises real localhost HTTP routes, station API
key authentication, DTO validation, old/new acknowledgement parsing and price
responses with stubbed persistence. Backend tests separately cover transactional
storage, dashboard edits, legacy backups, webhook payloads and mixed-version sites.
