# AZS Manager — Shift Management Feature Prompt

This document adds shift management to the existing AZS Manager app.
Apply on top of the main build prompt and universal config prompt.
Read the entire document before writing any code.

---

## What shift management means at a fuel station

- A **shift** is a work period assigned to one operator
- Operators work 8-12 hour shifts, typically 2-3 shifts per day
- At shift change, the outgoing operator hands over to the incoming operator
- Each transaction is linked to the shift it happened during
- At end of shift, operator gets a report: how many fills, volume, revenue
- Management sees reports per shift, per operator, per day

---

## Three shift modes (configurable)

**`disabled`** — No shift tracking. All transactions go to a single default bucket.
Good for small single-operator stations.

**`manual`** — Operator explicitly starts and ends shifts. No time constraint.
Operator enters their name, starts shift. Works until they end it manually.

**`scheduled`** — Shifts follow a fixed daily schedule (e.g. 06:00-14:00, 14:00-22:00,
22:00-06:00). System warns when scheduled end time approaches. Operator still
manually confirms handover but schedule drives the timing.

---

## Config additions — shifts section

Add to `site.config.json`:

```json
{
  "shifts": {
    "mode": "scheduled",

    "scheduled": [
      { "name": "Morning",   "start": "06:00", "end": "14:00" },
      { "name": "Afternoon", "start": "14:00", "end": "22:00" },
      { "name": "Night",     "start": "22:00", "end": "06:00" }
    ],

    "require_operator_pin": false,

    "warn_before_end_minutes": 15,

    "allow_overlap_minutes": 30,

    "auto_close_on_service_restart": false
  }
}
```

Field descriptions:

| Field | Type | Description |
|---|---|---|
| `mode` | `"disabled"` / `"manual"` / `"scheduled"` | Shift tracking mode |
| `scheduled` | array | Shift time slots (only used when mode=scheduled) |
| `scheduled[].name` | string | Display name: "Morning", "Night" etc. |
| `scheduled[].start` | `"HH:MM"` | Scheduled start time (24h) |
| `scheduled[].end` | `"HH:MM"` | Scheduled end time (24h, can be next day) |
| `require_operator_pin` | bool | If true, PIN required to start/end shift |
| `warn_before_end_minutes` | int | Minutes before scheduled end to show warning |
| `allow_overlap_minutes` | int | Grace period — allow starting new shift before old one ends |
| `auto_close_on_service_restart` | bool | Auto-close open shifts when service restarts |

---

## crates/config/src/lib.rs — additions

Add to `SiteConfig`:

```rust
pub shifts: ShiftConfig,
```

```rust
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ShiftConfig {
    pub mode:                      ShiftMode,
    pub scheduled:                 Vec<ScheduledShift>,
    pub require_operator_pin:      bool,
    pub warn_before_end_minutes:   u32,
    pub allow_overlap_minutes:     u32,
    pub auto_close_on_restart:     bool,
}

impl Default for ShiftConfig {
    fn default() -> Self {
        Self {
            mode:                    ShiftMode::Disabled,
            scheduled:               vec![],
            require_operator_pin:    false,
            warn_before_end_minutes: 15,
            allow_overlap_minutes:   30,
            auto_close_on_restart:   false,
        }
    }
}

#[derive(Debug, Clone, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum ShiftMode {
    Disabled,
    Manual,
    Scheduled,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct ScheduledShift {
    pub name:  String,     // "Morning"
    pub start: String,     // "06:00"
    pub end:   String,     // "14:00"
}

impl ScheduledShift {
    /// Parse "HH:MM" into (hours, minutes)
    pub fn parse_time(s: &str) -> Option<(u32, u32)> {
        let parts: Vec<&str> = s.split(':').collect();
        if parts.len() != 2 { return None; }
        let h = parts[0].parse().ok()?;
        let m = parts[1].parse().ok()?;
        if h > 23 || m > 59 { return None; }
        Some((h, m))
    }

    /// Total minutes from midnight for this shift's start
    pub fn start_minutes(&self) -> Option<u32> {
        let (h, m) = Self::parse_time(&self.start)?;
        Some(h * 60 + m)
    }

    /// Total minutes from midnight for this shift's end
    pub fn end_minutes(&self) -> Option<u32> {
        let (h, m) = Self::parse_time(&self.end)?;
        Some(h * 60 + m)
    }
}

impl ShiftConfig {
    /// Find which scheduled slot covers a given time (minutes since midnight)
    pub fn current_slot(&self, minutes_since_midnight: u32) -> Option<&ScheduledShift> {
        for slot in &self.scheduled {
            let start = slot.start_minutes()?;
            let end   = slot.end_minutes()?;
            if start < end {
                // same-day shift (e.g. 06:00-14:00)
                if minutes_since_midnight >= start && minutes_since_midnight < end {
                    return Some(slot);
                }
            } else {
                // overnight shift (e.g. 22:00-06:00)
                if minutes_since_midnight >= start || minutes_since_midnight < end {
                    return Some(slot);
                }
            }
        }
        None
    }

    /// Minutes remaining until current slot ends
    pub fn minutes_until_slot_end(&self, minutes_since_midnight: u32) -> Option<u32> {
        let slot = self.current_slot(minutes_since_midnight)?;
        let end = slot.end_minutes()?;
        if end > minutes_since_midnight {
            Some(end - minutes_since_midnight)
        } else {
            // overnight shift — end is next day
            Some(1440 - minutes_since_midnight + end)
        }
    }
}
```

Validate shift config in `SiteConfig::validate()`:

```rust
fn validate_shifts(&self) -> anyhow::Result<()> {
    if self.shifts.mode == ShiftMode::Scheduled {
        if self.shifts.scheduled.is_empty() {
            anyhow::bail!(
                "shifts.mode is 'scheduled' but shifts.scheduled is empty"
            );
        }
        for slot in &self.shifts.scheduled {
            if slot.name.is_empty() {
                anyhow::bail!("Scheduled shift has empty name");
            }
            if ScheduledShift::parse_time(&slot.start).is_none() {
                anyhow::bail!(
                    "Scheduled shift '{}' has invalid start time '{}'",
                    slot.name, slot.start
                );
            }
            if ScheduledShift::parse_time(&slot.end).is_none() {
                anyhow::bail!(
                    "Scheduled shift '{}' has invalid end time '{}'",
                    slot.name, slot.end
                );
            }
        }
    }
    Ok(())
}
```

---

## Database schema additions

Add to `migrations/001_init.sql`:

```sql
-- Operators (optional if PIN mode is enabled)
CREATE TABLE IF NOT EXISTS operators (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL UNIQUE,
    pin_hash   TEXT,                  -- bcrypt hash, null if no PIN
    active     INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL
);

-- Shifts
CREATE TABLE IF NOT EXISTS shifts (
    id                   TEXT PRIMARY KEY,
    operator_id          TEXT,         -- null if operator management disabled
    operator_name        TEXT NOT NULL,
    shift_name           TEXT,         -- "Morning", "Night", or null for manual
    scheduled_start      TEXT,         -- "06:00" if scheduled mode
    scheduled_end        TEXT,         -- "14:00" if scheduled mode
    started_at           INTEGER NOT NULL,
    ended_at             INTEGER,      -- null if still active
    total_transactions   INTEGER NOT NULL DEFAULT 0,
    total_volume         REAL    NOT NULL DEFAULT 0.0,
    total_amount         INTEGER NOT NULL DEFAULT 0,
    status               TEXT    NOT NULL DEFAULT 'ACTIVE',  -- ACTIVE | CLOSED
    notes                TEXT,
    FOREIGN KEY (operator_id) REFERENCES operators(id)
);

CREATE INDEX idx_shifts_status     ON shifts(status);
CREATE INDEX idx_shifts_started    ON shifts(started_at);
CREATE INDEX idx_shifts_operator   ON shifts(operator_id);

-- Add shift_id to transactions table
-- (ALTER TABLE if table already exists, otherwise add in CREATE TABLE)
ALTER TABLE transactions ADD COLUMN shift_id TEXT
    REFERENCES shifts(id);

-- Per-shift per-position totals (for fast reporting)
CREATE TABLE IF NOT EXISTS shift_position_totals (
    id                 TEXT PRIMARY KEY,
    shift_id           TEXT NOT NULL,
    fp_id              TEXT NOT NULL,
    label              TEXT NOT NULL,
    transactions_count INTEGER NOT NULL DEFAULT 0,
    total_volume       REAL    NOT NULL DEFAULT 0.0,
    total_amount       INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (shift_id) REFERENCES shifts(id)
);

CREATE INDEX idx_spt_shift ON shift_position_totals(shift_id);
```

---

## crates/types/src/lib.rs — shift types

Add to existing types file:

```rust
// ── Shift types ───────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ShiftStatus {
    Active,
    Closed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Shift {
    pub id:                 String,
    pub operator_id:        Option<String>,
    pub operator_name:      String,
    pub shift_name:         Option<String>,   // "Morning" / "Night" / null
    pub scheduled_start:    Option<String>,   // "06:00"
    pub scheduled_end:      Option<String>,   // "14:00"
    pub started_at:         i64,              // unix ms
    pub ended_at:           Option<i64>,
    pub total_transactions: u32,
    pub total_volume:       f64,
    pub total_amount:       u64,
    pub status:             ShiftStatus,
    pub notes:              Option<String>,
    pub position_totals:    Vec<ShiftPositionTotal>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShiftPositionTotal {
    pub fp_id:              String,
    pub label:              String,
    pub transactions_count: u32,
    pub total_volume:       f64,
    pub total_amount:       u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Operator {
    pub id:         String,
    pub name:       String,
    pub has_pin:    bool,       // true if PIN is set (never send the hash)
    pub active:     bool,
    pub created_at: i64,
}

// ── Shift REST request types ──────────────────────────────────

#[derive(Debug, Deserialize)]
pub struct StartShiftCmd {
    pub operator_name: String,
    pub pin:           Option<String>,   // required if require_operator_pin=true
    pub notes:         Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct EndShiftCmd {
    pub shift_id: String,
    pub notes:    Option<String>,
}

#[derive(Debug, Deserialize)]
pub struct HandoverCmd {
    pub outgoing_shift_id:    String,
    pub incoming_operator:    String,
    pub incoming_pin:         Option<String>,
    pub notes:                Option<String>,
}

// ── WsEvent additions ─────────────────────────────────────────

// Add these variants to the existing WsEvent enum:
//
//   #[serde(rename = "shift.started")]
//   ShiftStarted(Shift),
//
//   #[serde(rename = "shift.ended")]
//   ShiftEnded(Shift),
//
//   #[serde(rename = "shift.handover")]
//   ShiftHandover { outgoing: Shift, incoming: Shift },
//
//   #[serde(rename = "shift.warning")]
//   ShiftEndWarning { shift_id: String, minutes_remaining: u32 },

// ── SiteSnapshot addition ─────────────────────────────────────

// Add to existing SiteSnapshot struct:
//   pub shift_mode:     String,          // "disabled" / "manual" / "scheduled"
//   pub shift_schedule: Vec<ShiftSlot>,  // empty if not scheduled
//   pub require_pin:    bool,

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ShiftSlot {
    pub name:  String,
    pub start: String,
    pub end:   String,
}

// ── Transaction — add shift_id field ─────────────────────────

// Add to existing Transaction struct:
//   pub shift_id:       Option<String>,
//   pub operator_name:  Option<String>,
```

---

## Service additions — shift manager

Create `services/dispenser-service/src/shifts/mod.rs`:

```rust
use std::sync::{Arc, RwLock};
use crate::db::ShiftDb;
use azs_types::*;
use azs_config::ShiftMode;

/// Manages the active shift. Shared between poll loop and API handlers.
pub struct ShiftManager {
    active_shift: Arc<RwLock<Option<Shift>>>,
    db:           ShiftDb,
    mode:         ShiftMode,
}

impl ShiftManager {
    pub fn new(db: ShiftDb, mode: ShiftMode) -> Self {
        Self {
            active_shift: Arc::new(RwLock::new(None)),
            db,
            mode,
        }
    }

    /// Called on service startup — restore active shift from DB
    pub async fn restore_from_db(&self) -> anyhow::Result<()> {
        if let Some(shift) = self.db.load_active_shift().await? {
            *self.active_shift.write().unwrap() = Some(shift);
            tracing::info!("Restored active shift from database");
        }
        Ok(())
    }

    /// Get current active shift (None if no shift or mode=disabled)
    pub fn current(&self) -> Option<Shift> {
        match self.mode {
            ShiftMode::Disabled => None,
            _ => self.active_shift.read().unwrap().clone(),
        }
    }

    /// Get current shift ID for linking to transactions
    pub fn current_id(&self) -> Option<String> {
        self.current().map(|s| s.id)
    }

    /// Start a new shift
    pub async fn start(
        &self,
        cmd: StartShiftCmd,
        cfg: &azs_config::ShiftConfig,
    ) -> anyhow::Result<Shift> {

        // cannot start if one is already active
        if self.current().is_some() {
            anyhow::bail!(
                "Cannot start new shift: shift already active. \
                 Use handover or end the current shift first."
            );
        }

        // verify PIN if required
        if cfg.require_operator_pin {
            self.verify_pin(&cmd.operator_name, cmd.pin.as_deref())?;
        }

        // determine shift name from schedule
        let shift_name = match self.mode {
            ShiftMode::Scheduled => {
                let now_minutes = current_minutes_since_midnight();
                cfg.current_slot(now_minutes).map(|s| s.name.clone())
            }
            _ => None,
        };

        let scheduled_start = shift_name.as_ref().and_then(|name| {
            cfg.scheduled.iter()
                .find(|s| &s.name == name)
                .map(|s| s.start.clone())
        });
        let scheduled_end = shift_name.as_ref().and_then(|name| {
            cfg.scheduled.iter()
                .find(|s| &s.name == name)
                .map(|s| s.end.clone())
        });

        let shift = Shift {
            id:                 uuid::Uuid::new_v4().to_string(),
            operator_id:        None,
            operator_name:      cmd.operator_name,
            shift_name,
            scheduled_start,
            scheduled_end,
            started_at:         now_ms(),
            ended_at:           None,
            total_transactions: 0,
            total_volume:       0.0,
            total_amount:       0,
            status:             ShiftStatus::Active,
            notes:              cmd.notes,
            position_totals:    vec![],
        };

        self.db.insert_shift(&shift).await?;
        *self.active_shift.write().unwrap() = Some(shift.clone());
        tracing::info!(
            "Shift started: operator='{}' id={}",
            shift.operator_name, shift.id
        );
        Ok(shift)
    }

    /// End current shift
    pub async fn end(&self, cmd: EndShiftCmd) -> anyhow::Result<Shift> {
        let mut current = self.current()
            .ok_or_else(|| anyhow::anyhow!("No active shift"))?;

        if current.id != cmd.shift_id {
            anyhow::bail!("shift_id does not match active shift");
        }

        current.ended_at = Some(now_ms());
        current.status   = ShiftStatus::Closed;
        if let Some(notes) = cmd.notes {
            current.notes = Some(notes);
        }

        self.db.close_shift(&current).await?;
        *self.active_shift.write().unwrap() = None;

        tracing::info!(
            "Shift ended: operator='{}' id={} txns={} vol={:.2}L amt={}",
            current.operator_name, current.id,
            current.total_transactions, current.total_volume, current.total_amount
        );
        Ok(current)
    }

    /// Atomic handover — end current shift, start new one
    pub async fn handover(
        &self,
        cmd: HandoverCmd,
        cfg: &azs_config::ShiftConfig,
    ) -> anyhow::Result<(Shift, Shift)> {

        let outgoing = self.end(EndShiftCmd {
            shift_id: cmd.outgoing_shift_id,
            notes:    cmd.notes,
        }).await?;

        let incoming = self.start(StartShiftCmd {
            operator_name: cmd.incoming_operator,
            pin:           cmd.incoming_pin,
            notes:         None,
        }, cfg).await?;

        Ok((outgoing, incoming))
    }

    /// Called by poll loop when a transaction completes
    pub async fn record_transaction(
        &self,
        fp_id: &str,
        label: &str,
        volume: f64,
        amount: u64,
    ) -> anyhow::Result<()> {
        let shift_id = match self.current_id() {
            Some(id) => id,
            None     => return Ok(()), // mode=disabled or no shift active
        };

        self.db.add_transaction_to_shift(
            &shift_id, fp_id, label, volume, amount
        ).await?;

        // update in-memory totals
        let mut lock = self.active_shift.write().unwrap();
        if let Some(shift) = lock.as_mut() {
            shift.total_transactions += 1;
            shift.total_volume       += volume;
            shift.total_amount       += amount;

            let pos = shift.position_totals.iter_mut()
                .find(|p| p.fp_id == fp_id);
            if let Some(pos) = pos {
                pos.transactions_count += 1;
                pos.total_volume       += volume;
                pos.total_amount       += amount;
            } else {
                shift.position_totals.push(ShiftPositionTotal {
                    fp_id:              fp_id.to_string(),
                    label:              label.to_string(),
                    transactions_count: 1,
                    total_volume:       volume,
                    total_amount:       amount,
                });
            }
        }
        Ok(())
    }

    fn verify_pin(&self, _name: &str, _pin: Option<&str>) -> anyhow::Result<()> {
        // TODO: implement PIN verification against operators table
        // For now: always pass
        Ok(())
    }
}

fn now_ms() -> i64 {
    chrono::Utc::now().timestamp_millis()
}

fn current_minutes_since_midnight() -> u32 {
    let now = chrono::Local::now();
    now.hour() * 60 + now.minute()
}
```

---

## REST API additions — routes.rs

```rust
// Add these routes to the existing router:

.route("/shifts/current",   get(get_current_shift))
.route("/shifts/start",     post(start_shift))
.route("/shifts/end",       post(end_shift))
.route("/shifts/handover",  post(handover_shift))
.route("/shifts",           get(list_shifts))
.route("/shifts/:id",       get(get_shift))
.route("/shifts/:id/report",get(shift_report))
.route("/operators",        get(list_operators))
.route("/operators",        post(create_operator))
```

```rust
// GET /shifts/current
async fn get_current_shift(
    State(app): State<AppState>
) -> Json<Option<Shift>> {
    Json(app.shifts.current())
}

// POST /shifts/start
async fn start_shift(
    State(app): State<AppState>,
    Json(cmd): Json<StartShiftCmd>,
) -> Result<Json<Shift>, AppError> {
    let shift = app.shifts.start(cmd, &app.config.shifts).await?;
    // broadcast WsEvent::ShiftStarted
    let _ = app.events.send(WsEvent::ShiftStarted(shift.clone()));
    Ok(Json(shift))
}

// POST /shifts/end
async fn end_shift(
    State(app): State<AppState>,
    Json(cmd): Json<EndShiftCmd>,
) -> Result<Json<Shift>, AppError> {
    let shift = app.shifts.end(cmd).await?;
    let _ = app.events.send(WsEvent::ShiftEnded(shift.clone()));
    Ok(Json(shift))
}

// POST /shifts/handover
async fn handover_shift(
    State(app): State<AppState>,
    Json(cmd): Json<HandoverCmd>,
) -> Result<Json<serde_json::Value>, AppError> {
    let (outgoing, incoming) = app.shifts.handover(cmd, &app.config.shifts).await?;
    let _ = app.events.send(WsEvent::ShiftHandover {
        outgoing: outgoing.clone(),
        incoming: incoming.clone(),
    });
    Ok(Json(serde_json::json!({
        "outgoing": outgoing,
        "incoming": incoming,
    })))
}

// GET /shifts?status=ACTIVE&limit=20&offset=0
async fn list_shifts(
    State(app): State<AppState>,
    Query(params): Query<ShiftListParams>,
) -> Json<Vec<Shift>> {
    Json(app.db.list_shifts(params).await.unwrap_or_default())
}

// GET /shifts/:id/report
async fn shift_report(
    State(app): State<AppState>,
    Path(id): Path<String>,
) -> Result<Json<Shift>, AppError> {
    app.db.get_shift_with_totals(&id).await
        .map(Json)
        .ok_or(AppError::NotFound)
}
```

---

## Shift warning timer

In `services/dispenser-service/src/shifts/` add a background task that
fires `ShiftEndWarning` events before the scheduled end time.

```rust
pub fn spawn_warning_task(
    shift_manager: Arc<ShiftManager>,
    events:        broadcast::Sender<WsEvent>,
    cfg:           Arc<SiteConfig>,
) {
    if cfg.shifts.mode != ShiftMode::Scheduled { return; }
    let warn_mins = cfg.shifts.warn_before_end_minutes;

    tokio::spawn(async move {
        let mut interval = tokio::time::interval(Duration::from_secs(60));
        loop {
            interval.tick().await;

            let now_min = current_minutes_since_midnight();
            if let Some(remaining) = cfg.shifts.minutes_until_slot_end(now_min) {
                if remaining == warn_mins {
                    if let Some(shift) = shift_manager.current() {
                        let _ = events.send(WsEvent::ShiftEndWarning {
                            shift_id:          shift.id,
                            minutes_remaining: remaining,
                        });
                        tracing::info!(
                            "Shift end warning: {} minutes remaining",
                            remaining
                        );
                    }
                }
            }
        }
    });
}
```

---

## Desktop UI additions

### New components

```
src/components/
├── shift/
│   ├── ShiftBadge.tsx         ← shows current operator name + shift in header
│   ├── ShiftStartModal.tsx    ← modal to enter operator name (+ PIN)
│   ├── ShiftEndModal.tsx      ← modal to end shift with optional notes
│   ├── ShiftHandoverModal.tsx ← modal for handover (outgoing + incoming)
│   ├── ShiftWarningBanner.tsx ← banner: "Shift ends in 15 minutes"
│   └── ShiftReportPanel.tsx  ← shift summary with per-position totals
```

### ShiftBadge.tsx (shown in header)

```tsx
interface ShiftBadgeProps {
  shift: Shift | null;
  mode:  'disabled' | 'manual' | 'scheduled';
  onStartShift: () => void;
  onEndShift:   () => void;
  onHandover:   () => void;
}

export function ShiftBadge({ shift, mode, onStartShift, onEndShift, onHandover }) {
  if (mode === 'disabled') return null;

  if (!shift) {
    return (
      <button
        onClick={onStartShift}
        className="flex items-center gap-2 px-3 py-1.5
                   border border-amber-500/30 rounded-md
                   text-amber-400 text-sm hover:bg-amber-500/10"
      >
        <span className="w-2 h-2 rounded-full bg-amber-400" />
        No active shift — Start
      </button>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span className="w-2 h-2 rounded-full bg-green-400" />
      <span className="text-sm text-gray-300">
        {shift.operator_name}
        {shift.shift_name && (
          <span className="text-gray-500 ml-1">· {shift.shift_name}</span>
        )}
      </span>
      <button onClick={onHandover}
        className="text-xs text-gray-500 hover:text-gray-300 px-2">
        Handover
      </button>
      <button onClick={onEndShift}
        className="text-xs text-red-400 hover:text-red-300 px-2">
        End shift
      </button>
    </div>
  );
}
```

### ShiftStartModal.tsx

```tsx
export function ShiftStartModal({ open, onClose, onConfirm, requirePin }) {
  const [name, setName] = useState('');
  const [pin,  setPin]  = useState('');

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#1a1a2e] border border-white/10 rounded-xl p-6 w-80 gap-4 flex flex-col">
        <h2 className="text-white font-medium text-lg">Start Shift</h2>

        <div>
          <label className="text-xs text-gray-400 mb-1 block">
            Operator name
          </label>
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded-lg
                       px-3 py-2 text-white text-sm focus:outline-none
                       focus:border-white/30"
            placeholder="Enter your name"
            autoFocus
          />
        </div>

        {requirePin && (
          <div>
            <label className="text-xs text-gray-400 mb-1 block">PIN</label>
            <input
              type="password"
              value={pin}
              onChange={e => setPin(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-lg
                         px-3 py-2 text-white text-sm focus:outline-none
                         focus:border-white/30"
              placeholder="••••"
            />
          </div>
        )}

        <div className="flex gap-3 mt-2">
          <button onClick={onClose}
            className="flex-1 py-2 rounded-lg border border-white/10
                       text-gray-400 text-sm hover:bg-white/5">
            Cancel
          </button>
          <button
            onClick={() => onConfirm({ operator_name: name, pin: pin || undefined })}
            disabled={!name.trim()}
            className="flex-1 py-2 rounded-lg bg-green-500/20 border
                       border-green-500/40 text-green-400 text-sm
                       hover:bg-green-500/30 disabled:opacity-40"
          >
            Start shift
          </button>
        </div>
      </div>
    </div>
  );
}
```

### ShiftHandoverModal.tsx

```tsx
export function ShiftHandoverModal({ open, outgoingShift, onClose, onConfirm, requirePin }) {
  const [incomingName, setIncomingName] = useState('');
  const [incomingPin,  setIncomingPin]  = useState('');
  const [notes,        setNotes]        = useState('');

  if (!open || !outgoingShift) return null;

  return (
    <div className="fixed inset-0 bg-black/60 flex items-center justify-center z-50">
      <div className="bg-[#1a1a2e] border border-white/10 rounded-xl p-6 w-96 flex flex-col gap-4">
        <h2 className="text-white font-medium text-lg">Shift Handover</h2>

        {/* Outgoing summary */}
        <div className="bg-white/5 rounded-lg p-3 border border-white/10">
          <div className="text-xs text-gray-400 mb-2">Outgoing shift summary</div>
          <div className="text-sm text-white font-medium">
            {outgoingShift.operator_name}
            {outgoingShift.shift_name &&
              <span className="text-gray-400 ml-2">{outgoingShift.shift_name}</span>}
          </div>
          <div className="grid grid-cols-3 gap-2 mt-2">
            <div>
              <div className="text-xs text-gray-500">Transactions</div>
              <div className="text-sm text-white font-mono">
                {outgoingShift.total_transactions}
              </div>
            </div>
            <div>
              <div className="text-xs text-gray-500">Volume</div>
              <div className="text-sm text-white font-mono">
                {outgoingShift.total_volume.toFixed(2)}L
              </div>
            </div>
            <div>
              <div className="text-xs text-gray-500">Revenue</div>
              <div className="text-sm text-white font-mono">
                {outgoingShift.total_amount.toLocaleString()}
              </div>
            </div>
          </div>
        </div>

        {/* Incoming operator */}
        <div>
          <label className="text-xs text-gray-400 mb-1 block">
            Incoming operator
          </label>
          <input
            value={incomingName}
            onChange={e => setIncomingName(e.target.value)}
            className="w-full bg-white/5 border border-white/10 rounded-lg
                       px-3 py-2 text-white text-sm focus:outline-none
                       focus:border-white/30"
            placeholder="Incoming operator name"
            autoFocus
          />
        </div>

        {requirePin && (
          <div>
            <label className="text-xs text-gray-400 mb-1 block">
              Incoming operator PIN
            </label>
            <input
              type="password"
              value={incomingPin}
              onChange={e => setIncomingPin(e.target.value)}
              className="w-full bg-white/5 border border-white/10 rounded-lg
                         px-3 py-2 text-white text-sm"
              placeholder="••••"
            />
          </div>
        )}

        <div>
          <label className="text-xs text-gray-400 mb-1 block">
            Notes (optional)
          </label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            rows={2}
            className="w-full bg-white/5 border border-white/10 rounded-lg
                       px-3 py-2 text-white text-sm resize-none"
            placeholder="Any handover notes..."
          />
        </div>

        <div className="flex gap-3">
          <button onClick={onClose}
            className="flex-1 py-2 rounded-lg border border-white/10
                       text-gray-400 text-sm hover:bg-white/5">
            Cancel
          </button>
          <button
            onClick={() => onConfirm({
              outgoing_shift_id: outgoingShift.id,
              incoming_operator: incomingName,
              incoming_pin:      incomingPin || undefined,
              notes:             notes || undefined,
            })}
            disabled={!incomingName.trim()}
            className="flex-1 py-2 rounded-lg bg-blue-500/20 border
                       border-blue-500/40 text-blue-400 text-sm
                       hover:bg-blue-500/30 disabled:opacity-40"
          >
            Confirm handover
          </button>
        </div>
      </div>
    </div>
  );
}
```

### ShiftWarningBanner.tsx

```tsx
export function ShiftWarningBanner({ minutesRemaining, onHandover, onEndShift }) {
  if (!minutesRemaining) return null;
  return (
    <div className="bg-amber-500/10 border border-amber-500/30 rounded-lg
                    px-4 py-2 flex items-center justify-between">
      <div className="flex items-center gap-2 text-amber-400 text-sm">
        <span className="animate-pulse">⚠</span>
        Shift ends in {minutesRemaining} minutes
      </div>
      <div className="flex gap-2">
        <button onClick={onHandover}
          className="text-xs px-3 py-1 rounded border border-amber-500/40
                     text-amber-400 hover:bg-amber-500/20">
          Handover now
        </button>
        <button onClick={onEndShift}
          className="text-xs px-3 py-1 rounded border border-red-500/40
                     text-red-400 hover:bg-red-500/20">
          End shift
        </button>
      </div>
    </div>
  );
}
```

### ShiftReportPanel.tsx

```tsx
export function ShiftReportPanel({ shift }: { shift: Shift }) {
  const durationMs  = (shift.ended_at ?? Date.now()) - shift.started_at;
  const durationHrs = (durationMs / 3_600_000).toFixed(1);

  return (
    <div className="bg-[#1a1a2e] border border-white/10 rounded-xl p-5">
      <div className="flex items-center justify-between mb-4">
        <div>
          <div className="text-white font-medium">{shift.operator_name}</div>
          <div className="text-gray-400 text-sm">
            {shift.shift_name ?? 'Manual shift'} · {durationHrs}h
          </div>
        </div>
        <div className={`text-xs px-2 py-1 rounded border
          ${shift.status === 'ACTIVE'
            ? 'border-green-500/40 text-green-400 bg-green-500/10'
            : 'border-gray-500/40 text-gray-400 bg-white/5'}`}>
          {shift.status}
        </div>
      </div>

      {/* Totals */}
      <div className="grid grid-cols-3 gap-3 mb-4">
        <div className="bg-white/5 rounded-lg p-3">
          <div className="text-xs text-gray-400 mb-1">Transactions</div>
          <div className="text-xl font-mono text-white">
            {shift.total_transactions}
          </div>
        </div>
        <div className="bg-white/5 rounded-lg p-3">
          <div className="text-xs text-gray-400 mb-1">Volume</div>
          <div className="text-xl font-mono text-white">
            {shift.total_volume.toFixed(2)}L
          </div>
        </div>
        <div className="bg-white/5 rounded-lg p-3">
          <div className="text-xs text-gray-400 mb-1">Revenue</div>
          <div className="text-xl font-mono text-white">
            {(shift.total_amount / 1_000_000).toFixed(2)}M
          </div>
        </div>
      </div>

      {/* Per-position breakdown */}
      {shift.position_totals.length > 0 && (
        <div>
          <div className="text-xs text-gray-400 mb-2 uppercase tracking-wider">
            Per dispenser
          </div>
          <div className="space-y-1">
            {shift.position_totals.map(pt => (
              <div key={pt.fp_id}
                className="flex items-center justify-between
                           bg-white/5 rounded px-3 py-2">
                <span className="text-sm text-gray-300">{pt.label}</span>
                <div className="flex gap-4 text-xs font-mono">
                  <span className="text-gray-400">
                    {pt.transactions_count} fills
                  </span>
                  <span className="text-white">
                    {pt.total_volume.toFixed(2)}L
                  </span>
                  <span className="text-gray-300">
                    {pt.total_amount.toLocaleString()} sum
                  </span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
```

---

## useShift hook

```typescript
// src/hooks/useShift.ts

import { invoke } from '@tauri-apps/api/core'
import { listen }  from '@tauri-apps/api/event'
import { useState, useEffect } from 'react'
import type { Shift, StartShiftCmd, EndShiftCmd, HandoverCmd } from '../types/api'

export function useShift() {
  const [currentShift,      setCurrentShift]      = useState<Shift | null>(null)
  const [warningMinutes,    setWarningMinutes]    = useState<number | null>(null)
  const [showStartModal,    setShowStartModal]    = useState(false)
  const [showEndModal,      setShowEndModal]      = useState(false)
  const [showHandoverModal, setShowHandoverModal] = useState(false)

  useEffect(() => {
    // load current shift on startup
    invoke<Shift | null>('get_current_shift')
      .then(setCurrentShift)

    // listen for shift events
    const unlisten = listen<string>('dispenser_event', e => {
      const ev = JSON.parse(e.payload)

      if (ev.event === 'shift.started') {
        setCurrentShift(ev.data)
        setWarningMinutes(null)
      }
      if (ev.event === 'shift.ended') {
        setCurrentShift(null)
        setWarningMinutes(null)
      }
      if (ev.event === 'shift.handover') {
        setCurrentShift(ev.data.incoming)
        setWarningMinutes(null)
      }
      if (ev.event === 'shift.warning') {
        setWarningMinutes(ev.data.minutes_remaining)
      }
    })

    return () => { unlisten.then(f => f()) }
  }, [])

  const startShift = async (cmd: StartShiftCmd) => {
    const shift = await invoke<Shift>('start_shift', { cmd })
    setCurrentShift(shift)
    setShowStartModal(false)
  }

  const endShift = async (cmd: EndShiftCmd) => {
    await invoke('end_shift', { cmd })
    setCurrentShift(null)
    setShowEndModal(false)
  }

  const handover = async (cmd: HandoverCmd) => {
    const result = await invoke<{ outgoing: Shift; incoming: Shift }>(
      'handover_shift', { cmd }
    )
    setCurrentShift(result.incoming)
    setShowHandoverModal(false)
    return result
  }

  return {
    currentShift,
    warningMinutes,
    showStartModal,    setShowStartModal,
    showEndModal,      setShowEndModal,
    showHandoverModal, setShowHandoverModal,
    startShift,
    endShift,
    handover,
  }
}
```

---

## Tauri commands to add (apps/desktop/src-tauri/src/commands.rs)

```rust
#[tauri::command]
pub async fn get_current_shift(
    client: State<'_, ServiceClient>
) -> Result<Option<Shift>, String> {
    client.get("/shifts/current").await
}

#[tauri::command]
pub async fn start_shift(
    cmd:    StartShiftCmd,
    client: State<'_, ServiceClient>
) -> Result<Shift, String> {
    client.post("/shifts/start", &cmd).await
}

#[tauri::command]
pub async fn end_shift(
    cmd:    EndShiftCmd,
    client: State<'_, ServiceClient>
) -> Result<Shift, String> {
    client.post("/shifts/end", &cmd).await
}

#[tauri::command]
pub async fn handover_shift(
    cmd:    HandoverCmd,
    client: State<'_, ServiceClient>
) -> Result<serde_json::Value, String> {
    client.post("/shifts/handover", &cmd).await
}

#[tauri::command]
pub async fn list_shifts(
    limit:  Option<i64>,
    offset: Option<i64>,
    client: State<'_, ServiceClient>
) -> Result<Vec<Shift>, String> {
    let url = format!("/shifts?limit={}&offset={}",
        limit.unwrap_or(20), offset.unwrap_or(0));
    client.get(&url).await
}

#[tauri::command]
pub async fn get_shift_report(
    id:     String,
    client: State<'_, ServiceClient>
) -> Result<Shift, String> {
    client.get(&format!("/shifts/{}/report", id)).await
}
```

---

## Complete REST API for shifts

```
GET  /shifts/current
     → Shift | null

POST /shifts/start
     body: { operator_name, pin?, notes? }
     → Shift

POST /shifts/end
     body: { shift_id, notes? }
     → Shift (closed)

POST /shifts/handover
     body: { outgoing_shift_id, incoming_operator, incoming_pin?, notes? }
     → { outgoing: Shift, incoming: Shift }

GET  /shifts
     ?status=ACTIVE|CLOSED
     &limit=20&offset=0
     → [Shift]

GET  /shifts/:id
     → Shift

GET  /shifts/:id/report
     → Shift with full position_totals

GET  /operators
     → [Operator]

POST /operators
     body: { name, pin? }
     → Operator
```

---

## Config templates update

Add `shifts` section to all config templates:

**wayne-4fp.json (manual mode):**
```json
"shifts": {
    "mode": "manual",
    "scheduled": [],
    "require_operator_pin": false,
    "warn_before_end_minutes": 15,
    "allow_overlap_minutes": 30,
    "auto_close_on_restart": false
}
```

**wayne-8fp.json (3 scheduled shifts):**
```json
"shifts": {
    "mode": "scheduled",
    "scheduled": [
        { "name": "Morning",   "start": "06:00", "end": "14:00" },
        { "name": "Afternoon", "start": "14:00", "end": "22:00" },
        { "name": "Night",     "start": "22:00", "end": "06:00" }
    ],
    "require_operator_pin": false,
    "warn_before_end_minutes": 15,
    "allow_overlap_minutes": 30,
    "auto_close_on_restart": false
}
```

---

## Build checklist

- [ ] `ShiftConfig` loads from all three config templates (disabled/manual/scheduled)
- [ ] Validation rejects scheduled mode with empty schedule
- [ ] Validation rejects invalid time formats ("25:00", "6:0")
- [ ] `current_slot()` returns correct slot for given time-of-day
- [ ] `current_slot()` handles overnight shifts (22:00-06:00) correctly
- [ ] Service restores active shift from DB on startup
- [ ] `POST /shifts/start` creates shift and returns it
- [ ] `POST /shifts/start` fails if shift already active
- [ ] `POST /shifts/handover` atomically closes old + opens new
- [ ] Completed transaction has correct `shift_id` in DB
- [ ] `GET /shifts/:id/report` returns correct per-position totals
- [ ] Warning event fires `warn_before_end_minutes` before scheduled end
- [ ] Desktop `ShiftBadge` shows operator name in header
- [ ] `ShiftStartModal` opens when badge is clicked (no active shift)
- [ ] `ShiftHandoverModal` shows outgoing summary correctly
- [ ] `ShiftReportPanel` renders totals and per-position breakdown
- [ ] `useShift` hook updates state on all WsEvent types

---

*Apply this prompt after UNIVERSAL_CONFIG_PROMPT.md and before testing.*
*The config crate changes (ShiftConfig) must be implemented first.*