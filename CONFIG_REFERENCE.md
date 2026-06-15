# site.config.json — Field Reference

Complete reference for every field in the site configuration file.
The service validates the config on startup and refuses to start if any required field is missing or invalid.

---

## Top-level structure

```json
{
  "site":              { ... },
  "service":           { ... },
  "connection":        { ... },
  "polling":           { ... },
  "products":          [ ... ],
  "fueling_positions": [ ... ],
  "sync":              { ... },
  "shifts":            { ... },   // optional, default: disabled
  "ui":                { ... },   // optional, all fields have defaults
  "tanks":             [ ... ],   // optional, manual tank levels
  "atg":               { ... }    // optional, Modbus tank gauge polling
}
```

---

## `site`

General information about the station. Shown in the UI header and included in transaction records.

| Field      | Type   | Required | Description |
|------------|--------|----------|-------------|
| `id`       | string | yes      | Unique station identifier, e.g. `"ung-001"` |
| `name`     | string | yes      | Human-readable station name shown in the UI |
| `timezone` | string | yes      | IANA timezone, e.g. `"Asia/Tashkent"`, `"UTC"` |
| `address`  | string | no       | Physical address. `null` or omit if not needed |

```json
"site": {
  "id": "ung-bostonliq",
  "name": "UNG Bostonliq",
  "timezone": "Asia/Tashkent",
  "address": "Tashkent, Yunusobod 12"
}
```

---

## `service`

HTTP service settings.

| Field             | Type    | Required | Description |
|-------------------|---------|----------|-------------|
| `port`            | integer | yes      | HTTP port the REST API listens on (e.g. `3001`) |
| `log_level`       | string  | yes      | Log verbosity: `"error"`, `"warn"`, `"info"`, `"debug"`, `"trace"` |
| `log_file`        | string  | yes      | Path to the log file, relative to the working directory |
| `db_path`         | string  | yes      | Path to the SQLite database file |
| `serial_log_file` | string  | no       | Path for raw serial frame log (TX/RX hex). `null` or omit to disable. Overridden by `AZS_SERIAL_LOG` env var |

```json
"service": {
  "port": 3001,
  "log_level": "info",
  "log_file": "service.log",
  "db_path": "transactions.db",
  "serial_log_file": null
}
```

---

## `connection`

Serial port connection to the dispensers.

| Field                 | Type    | Required | Description |
|-----------------------|---------|----------|-------------|
| `protocol`            | string  | yes      | Pump protocol (see values below) |
| `port`                | string  | yes      | Serial port path: `"COM3"` on Windows, `"/dev/ttyUSB0"` on Linux, `"/tmp/wayne-sim"` for simulator |
| `baud_rate`           | integer | yes      | Baud rate, e.g. `9600` |
| `parity`              | string  | yes      | `"none"`, `"odd"`, or `"even"` |
| `data_bits`           | integer | yes      | `5`–`8` |
| `stop_bits`           | integer | yes      | `1` or `2` |
| `response_timeout_ms` | integer | yes      | How long to wait for a pump reply before declaring a miss (milliseconds) |

**Protocol values:**

| Value             | Protocol |
|-------------------|----------|
| `"wayne_europump"` | Wayne Europump PCC485 (RS-485) |
| `"wayne_dart_v1"`  | Wayne Dart v1 |
| `"wayne_dart_v2"`  | Wayne Dart v2 |
| `"gilbarco"`       | Gilbarco |
| `"mock"`           | Software mock (testing only) |

**Typical values for Wayne Europump:**
```json
"connection": {
  "protocol": "wayne_europump",
  "port": "/dev/ttyUSB0",
  "baud_rate": 9600,
  "parity": "none",
  "data_bits": 8,
  "stop_bits": 1,
  "response_timeout_ms": 300
}
```

---

## `polling`

How the service polls pumps on the RS-485 bus.

| Field                    | Type    | Required | Default | Description |
|--------------------------|---------|----------|---------|-------------|
| `interval_ms`            | integer | yes      | —       | Time between polls per pump (milliseconds). Typical: `140`–`200` |
| `offline_threshold_polls`| integer | yes      | —       | Consecutive missed polls before a pump is declared offline. Typical: `3`–`32` |
| `reconnect_settle_rounds`| integer | yes      | —       | Polls to ignore after a pump comes back online (lets bus settle). `0` to disable |

Lower `interval_ms` = more responsive UI but more bus load.
Higher `offline_threshold_polls` = more tolerance for noise but slower offline detection.

```json
"polling": {
  "interval_ms": 200,
  "offline_threshold_polls": 3,
  "reconnect_settle_rounds": 3
}
```

---

## `products`

Global product catalog. Every nozzle references a product from this list by `id`.

| Field   | Type    | Required | Description |
|---------|---------|----------|-------------|
| `id`    | integer | yes      | Unique product ID (1–255). Referenced by nozzles |
| `name`  | string  | yes      | Product name shown in the UI: `"AI-92"`, `"Diesel"` |
| `color` | string  | yes      | Hex color for the UI card: `"#2196F3"` |
| `unit`  | string  | yes      | Unit of measure: `"litre"` |

IDs must be unique. Names must not be empty.

```json
"products": [
  { "id": 3, "name": "AI-92",  "color": "#2196F3", "unit": "litre" },
  { "id": 4, "name": "AI-95",  "color": "#FF9800", "unit": "litre" },
  { "id": 5, "name": "AI-98",  "color": "#E91E63", "unit": "litre" },
  { "id": 6, "name": "Diesel", "color": "#795548", "unit": "litre" },
  { "id": 7, "name": "LPG",    "color": "#9C27B0", "unit": "litre" }
]
```

---

## `fueling_positions`

One entry per dispenser side. Each position maps to one RS-485 address.

### Position fields

| Field          | Type    | Required | Description |
|----------------|---------|----------|-------------|
| `id`           | string  | yes      | Unique identifier: `"FP1"`, `"FP2"`. Used in API calls |
| `label`        | string  | yes      | Display name: `"Dispenser 1 Side A"` |
| `address_byte` | integer | yes      | Raw RS-485 address byte. Wayne Europump: `80`–`87` (0x50–0x57). Must be unique among active positions |
| `active`       | boolean | yes      | `false` = position exists in config but is not polled |
| `nozzles`      | array   | yes      | List of nozzles on this position |

### Nozzle fields

| Field                | Type    | Required | Default | Description |
|----------------------|---------|----------|---------|-------------|
| `index`              | integer | yes      | —       | Nozzle number on this position (1-based, 1–4) |
| `product_id`         | integer | yes      | —       | Reference to a `products[].id` |
| `price`              | integer | yes      | —       | Price per litre in sum (minor units). Active nozzles must have `price > 0` |
| `active`             | boolean | yes      | —       | `false` = nozzle is installed but not in service |
| `wayne_code`         | integer | no       | `0`     | Wayne hose byte on lift (≥ 0x10). Used to identify which physical hose was lifted when a position has multiple nozzles. `0` = auto-detect by index |
| `wayne_product_code` | integer | no       | `0`     | Wayne product byte in the data frame (`03 04 01 [PP] 00 [HH]`). Needed when multiple hoses share the same grade. `0` = match by `wayne_code` only |

```json
"fueling_positions": [
  {
    "id": "FP1",
    "label": "Dispenser 1 Side A",
    "address_byte": 80,
    "active": true,
    "nozzles": [
      { "index": 1, "product_id": 3, "price": 10500, "active": true },
      { "index": 2, "product_id": 4, "price": 12000, "active": true }
    ]
  },
  {
    "id": "FP2",
    "label": "Dispenser 1 Side B",
    "address_byte": 81,
    "active": true,
    "nozzles": [
      { "index": 1, "product_id": 3, "price": 10500, "active": true,
        "wayne_code": 18, "wayne_product_code": 3 },
      { "index": 2, "product_id": 6, "price": 9800, "active": true,
        "wayne_code": 17, "wayne_product_code": 6 }
    ]
  }
]
```

**Wayne address mapping (Europump):**

| Address byte | Hex  | Dispenser / Side |
|-------------|------|------------------|
| 80          | 0x50 | Dispenser 1 Side A |
| 81          | 0x51 | Dispenser 1 Side B |
| 82          | 0x52 | Dispenser 2 Side A |
| 83          | 0x53 | Dispenser 2 Side B |
| 84          | 0x54 | Dispenser 3 Side A |
| 85          | 0x55 | Dispenser 3 Side B |
| 86          | 0x56 | Dispenser 4 Side A |
| 87          | 0x57 | Dispenser 4 Side B |

Actual address depends on DIP switch configuration on the pump controller.

---

## `sync`

Push transaction records to a remote backend after completion.

| Field                    | Type    | Required | Default | Description |
|--------------------------|---------|----------|---------|-------------|
| `enabled`                | boolean | yes      | —       | `false` = sync disabled, all other fields ignored |
| `backend_url`            | string  | yes      | —       | HTTP endpoint to POST records to |
| `api_key`                | string  | yes      | —       | Authorization header value |
| `retry_interval_secs`    | integer | no       | `30`    | How often the sync worker pushes queued records |
| `batch_size`             | integer | no       | `100`   | Max records per HTTP batch |
| `max_retries`            | integer | no       | `10`    | Records failing this many times are skipped permanently |
| `price_pull_interval_hours` | integer | no  | `12`    | How often to pull price updates from the server (hours). `0` = startup only |

```json
"sync": {
  "enabled": true,
  "backend_url": "https://api.ung.uz/v1/transactions",
  "api_key": "Bearer eyJ...",
  "retry_interval_secs": 30,
  "batch_size": 100
}
```

---

## `shifts` *(optional)*

Shift management. Controls whether operators must start a shift before authorizing dispensers.

| Field                    | Type    | Default    | Description |
|--------------------------|---------|------------|-------------|
| `mode`                   | string  | `"disabled"` | `"disabled"`, `"manual"`, or `"scheduled"` |
| `scheduled`              | array   | `[]`       | Shift schedule (only used when `mode = "scheduled"`) |
| `require_operator_pin`   | boolean | `false`    | Operators must enter a PIN to start a shift |
| `warn_before_end_minutes`| integer | `15`       | Show warning banner N minutes before a scheduled shift ends |
| `allow_overlap_minutes`  | integer | `30`       | Grace period allowing a new shift to start while previous is still open |
| `auto_close_on_restart`  | boolean | `false`    | Automatically close any open shift when the service restarts |

**Mode values:**

| Mode          | Behavior |
|---------------|----------|
| `"disabled"`  | No shift tracking. Operators can authorize at any time |
| `"manual"`    | Operator manually starts and ends each shift |
| `"scheduled"` | Shifts start/end automatically by clock. `scheduled` list required |

**Scheduled shift fields:**

| Field   | Type   | Description |
|---------|--------|-------------|
| `name`  | string | Shift name, e.g. `"Morning"`, `"Night"` |
| `start` | string | Start time in `"HH:MM"` format |
| `end`   | string | End time in `"HH:MM"` format. Midnight crossover supported |

```json
"shifts": {
  "mode": "scheduled",
  "scheduled": [
    { "name": "Morning", "start": "08:00", "end": "16:00" },
    { "name": "Evening", "start": "16:00", "end": "00:00" },
    { "name": "Night",   "start": "00:00", "end": "08:00" }
  ],
  "require_operator_pin": true,
  "warn_before_end_minutes": 15,
  "allow_overlap_minutes": 30,
  "auto_close_on_restart": false
}
```

---

## `ui` *(optional)*

Controls operator-facing behaviour in the desktop application.

| Field                      | Type    | Default      | Description |
|----------------------------|---------|--------------|-------------|
| `default_auth_mode`        | string  | `"reactive"` | Authorization flow (see below) |
| `preauth_timeout_seconds`  | integer | `300`        | Seconds before an unanswered pre-authorization is automatically cancelled. `0` = disabled |
| `use_decel_window_on_stop` | boolean | `false`      | Keep sending BUSY ~10 s after a stop so the pump can be re-authorized without resetting its counter |
| `use_stop_mode`            | boolean | `false`      | Changes Stop button behavior (see table below) |
| `use_cancel_mode`          | boolean | `false`      | Shows a Cancel button instead of Stop/Pause. Intended for simulator configs only (see below) |

**`default_auth_mode` values:**

| Value       | Behavior |
|-------------|----------|
| `"reactive"` | Operator authorizes after the customer lifts the nozzle |
| `"preauth"`  | Operator pre-authorizes while the pump is idle; customer lifts nozzle to start |

**Stop button behavior (`use_stop_mode` vs `use_cancel_mode`):**

| Config                          | Button label | Fuel stops on click? | Transaction finalized when |
|---------------------------------|--------------|----------------------|----------------------------|
| both `false` (default)          | **Pause**    | Yes                  | Operator clicks "Resume" or "Close Transaction" |
| `use_stop_mode: true`           | **Stop**     | Yes                  | Customer holsters the nozzle (freshest meter reading) |
| `use_cancel_mode: true`         | **Cancel**   | Yes                  | Immediately on button click |
| both `true`                     | **Cancel**   | Yes                  | Immediately on button click, `stop_source = APP_FINAL` |

**Recommendation:**
- Real pumps → `use_stop_mode: true`. Fuel stops immediately; transaction records the final meter reading at holster time.
- Simulator (no physical nozzle) → `use_cancel_mode: true`. Closes the transaction in one click since there is no holster event.

```json
"ui": {
  "default_auth_mode": "preauth",
  "preauth_timeout_seconds": 300,
  "use_stop_mode": true
}
```

---

## `tanks` *(optional)*

Manual tank level display. If ATG is configured and reporting, ATG readings override these values.

| Field        | Type    | Required | Description |
|--------------|---------|----------|-------------|
| `product_id` | integer | yes      | Reference to `products[].id` |
| `label`      | string  | yes      | Display label in the tank panel |
| `capacity_l` | float   | yes      | Total tank capacity in litres |
| `current_l`  | float   | yes      | Current fuel level in litres. Updated by the admin panel |

```json
"tanks": [
  { "product_id": 3, "label": "AI-92",  "capacity_l": 20000.0, "current_l": 12000.0 },
  { "product_id": 4, "label": "AI-95",  "capacity_l": 20000.0, "current_l": 8500.0 },
  { "product_id": 6, "label": "Diesel", "capacity_l": 20000.0, "current_l": 6400.0 }
]
```

---

## `atg` *(optional)*

Automatic Tank Gauge polling via Modbus TCP. When configured, live tank levels are read from the gauge hardware and shown in the tank panel instead of the manual `tanks` values.

Omit or set to `null` to disable.

### Top-level ATG fields

| Field                 | Type   | Default | Description |
|-----------------------|--------|---------|-------------|
| `poll_interval_secs`  | integer | `300`  | How often to poll all branches (seconds). Minimum practical value: `60` |
| `modbus_timeout_secs` | float  | `10.0`  | Modbus TCP connect + read timeout |
| `api_url`             | string | `""`    | Optional HTTP endpoint to POST tank level data to after each poll |
| `auth`                | object | `null`  | Auth credentials for the API POST (see below) |
| `branches`            | array  | `[]`    | List of Modbus TCP branch devices to poll |

### `atg.auth` fields

| Field       | Type   | Description |
|-------------|--------|-------------|
| `api_token` | string | Static Bearer token. Takes priority over username/password |
| `username`  | string | Login username (used if `api_token` is empty) |
| `password`  | string | Login password |
| `login_url` | string | Login endpoint. Derived from `api_url` if empty |

### `atg.branches[]` fields

| Field            | Type    | Default | Description |
|------------------|---------|---------|-------------|
| `id`             | integer | —       | Branch ID used in the API payload |
| `name`           | string  | `""`    | Human-readable branch name |
| `host`           | string  | —       | IP address or hostname of the Modbus TCP device |
| `port`           | integer | `502`   | Modbus TCP port |
| `unit_id`        | integer | `1`     | Modbus unit/slave ID |
| `start_register` | integer | `1000`  | ModScan-style register address of the first register |
| `address_base`   | integer | `1`     | Offset to convert start_register to 0-based PDU address. Usually `1` |
| `register_count` | integer | `12`    | Number of 16-bit registers to read. Must be a multiple of 12 (12 per tank slot, max 48 = 4 slots) |
| `slots`          | array   | —       | Tank slot definitions |

### `atg.branches[].slots[]` fields

| Field          | Type    | Required | Description |
|----------------|---------|----------|-------------|
| `slot`         | integer | yes      | 1-based slot number on the gauge (1–4) |
| `tank_id`      | string  | no       | Backend reservoir `tankId` for sync. Defaults to `product_id` when omitted |
| `type`         | string  | yes      | Fuel type label used in the API payload, e.g. `"AI-92"` |
| `product_id`   | integer | no       | Links this slot to a product in the catalog. When set, live readings update the matching tank display |
| `label`        | string  | no       | Display label. Falls back to `type` when absent |
| `capacity_l`   | float   | no       | Physical tank capacity. Falls back to matching `tanks[].capacity_l` or `maxima.product_volume` |
| `maxima`       | object  | no       | Per-parameter capacity values for percent calculation in the API POST. Key `"product_volume"` → max litres |

```json
"atg": {
  "poll_interval_secs": 300,
  "modbus_timeout_secs": 10.0,
  "api_url": "https://ps.ung.uz/api/integration/fuel-levels",
  "auth": {
    "api_token": "Bearer eyJ..."
  },
  "branches": [
    {
      "id": 1,
      "name": "Main tank farm",
      "host": "192.168.1.100",
      "port": 6400,
      "unit_id": 1,
      "start_register": 1000,
      "address_base": 1,
      "register_count": 48,
      "slots": [
        { "slot": 1, "type": "AI-92",  "product_id": 3, "capacity_l": 20000 },
        { "slot": 2, "type": "AI-95",  "product_id": 4, "capacity_l": 20000 },
        { "slot": 3, "type": "AI-98",  "product_id": 5, "capacity_l": 10000 },
        { "slot": 4, "type": "Diesel", "product_id": 6, "capacity_l": 20000 }
      ]
    }
  ]
}
```

---

## Validation rules

The service rejects the config at startup if any of these are violated:

- `connection.port` must not be empty
- `connection.baud_rate` must be > 0
- `connection.response_timeout_ms` must be > 0
- `connection.data_bits` must be 5–8
- `connection.stop_bits` must be 1 or 2
- `products` must not be empty
- All `products[].id` values must be unique
- All `products[].name` values must not be empty
- `fueling_positions` must not be empty
- All `fueling_positions[].id` values must be unique and non-empty
- All `fueling_positions[].label` values must be non-empty
- Active positions must have unique `address_byte` values
- Active positions must have at least one nozzle
- All `nozzle.index` values must be ≥ 1 (1-based)
- Nozzle indices within a position must be unique
- All `nozzle.product_id` values must reference an existing product
- Active nozzles must have `price > 0`
- When `shifts.mode = "scheduled"`, `shifts.scheduled` must not be empty and all times must be valid `HH:MM`

---

## Complete minimal example

```json
{
  "site": {
    "id": "site-001",
    "name": "My Station",
    "timezone": "Asia/Tashkent"
  },
  "service": {
    "port": 3001,
    "log_level": "info",
    "log_file": "service.log",
    "db_path": "transactions.db"
  },
  "connection": {
    "protocol": "wayne_europump",
    "port": "/dev/ttyUSB0",
    "baud_rate": 9600,
    "parity": "none",
    "data_bits": 8,
    "stop_bits": 1,
    "response_timeout_ms": 300
  },
  "polling": {
    "interval_ms": 200,
    "offline_threshold_polls": 3,
    "reconnect_settle_rounds": 3
  },
  "products": [
    { "id": 3, "name": "AI-92",  "color": "#2196F3", "unit": "litre" },
    { "id": 6, "name": "Diesel", "color": "#795548", "unit": "litre" }
  ],
  "fueling_positions": [
    {
      "id": "FP1", "label": "Dispenser 1 Side A",
      "address_byte": 80, "active": true,
      "nozzles": [
        { "index": 1, "product_id": 3, "price": 10500, "active": true }
      ]
    },
    {
      "id": "FP2", "label": "Dispenser 1 Side B",
      "address_byte": 81, "active": true,
      "nozzles": [
        { "index": 1, "product_id": 6, "price": 9800, "active": true }
      ]
    }
  ],
  "sync": {
    "enabled": false,
    "backend_url": "",
    "api_key": ""
  },
  "ui": {
    "default_auth_mode": "preauth",
    "use_stop_mode": true
  }
}
```
