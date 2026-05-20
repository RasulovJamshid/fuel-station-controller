//! In-memory admin sessions and PIN verification.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, Result};
use sqlx::SqlitePool;
use tokio::sync::RwLock;
use uuid::Uuid;

const SESSION_TTL: Duration = Duration::from_secs(3600);
const PIN_HASH_KEY: &str = "admin_pin_hash";
const PIN_MUST_CHANGE_KEY: &str = "admin_pin_must_change";

struct Session {
    expires: Instant,
    subject: String,
}

#[derive(Clone)]
pub struct AdminSessions {
    inner: Arc<RwLock<HashMap<String, Session>>>,
}

impl AdminSessions {
    pub fn new() -> Self {
        Self {
            inner: Arc::new(RwLock::new(HashMap::new())),
        }
    }

    pub async fn create(&self, subject: impl Into<String>) -> (String, u64) {
        let token = Uuid::new_v4().to_string();
        let expires = Instant::now() + SESSION_TTL;
        self.inner.write().await.insert(
            token.clone(),
            Session {
                expires,
                subject: subject.into(),
            },
        );
        (token, SESSION_TTL.as_secs())
    }

    pub async fn validate(&self, token: &str) -> Result<String> {
        let mut map = self.inner.write().await;
        map.retain(|_, s| s.expires > Instant::now());
        let Some(s) = map.get(token) else {
            return Err(anyhow!("invalid or expired admin token"));
        };
        if s.expires <= Instant::now() {
            map.remove(token);
            return Err(anyhow!("admin session expired"));
        }
        Ok(s.subject.clone())
    }
}

pub async fn ensure_admin_defaults(pool: &SqlitePool) -> Result<()> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT value FROM admin_config WHERE key = ?")
            .bind(PIN_HASH_KEY)
            .fetch_optional(pool)
            .await?;
    if row.is_some() {
        return Ok(());
    }
    let hash = hash_pin("0000")?;
    let now = chrono::Utc::now().timestamp_millis();
    sqlx::query(
        "INSERT INTO admin_config (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)",
    )
    .bind(PIN_HASH_KEY)
    .bind(&hash)
    .bind(now)
    .bind("system")
    .execute(pool)
    .await?;
    sqlx::query(
        "INSERT INTO admin_config (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)",
    )
    .bind(PIN_MUST_CHANGE_KEY)
    .bind("1")
    .bind(now)
    .bind("system")
    .execute(pool)
    .await?;
    tracing::info!("initialized default admin PIN (0000) — change on first login");
    Ok(())
}

pub async fn must_change_pin(pool: &SqlitePool) -> Result<bool> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT value FROM admin_config WHERE key = ?")
            .bind(PIN_MUST_CHANGE_KEY)
            .fetch_optional(pool)
            .await?;
    Ok(row.map(|(v,)| v == "1" || v.eq_ignore_ascii_case("true")).unwrap_or(false))
}

pub async fn verify_admin_pin(pool: &SqlitePool, pin: &str) -> Result<bool> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT value FROM admin_config WHERE key = ?")
            .bind(PIN_HASH_KEY)
            .fetch_optional(pool)
            .await?;
    let Some((hash,)) = row else {
        return Ok(false);
    };
    Ok(bcrypt::verify(pin, &hash).unwrap_or(false))
}

pub async fn set_admin_pin(
    pool: &SqlitePool,
    new_pin: &str,
    updated_by: &str,
    clear_must_change: bool,
) -> Result<()> {
    if new_pin.len() < 4 {
        return Err(anyhow!("PIN must be at least 4 characters"));
    }
    let hash = hash_pin(new_pin)?;
    let now = chrono::Utc::now().timestamp_millis();
    sqlx::query(
        r#"INSERT INTO admin_config (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by"#,
    )
    .bind(PIN_HASH_KEY)
    .bind(&hash)
    .bind(now)
    .bind(updated_by)
    .execute(pool)
    .await?;
    if clear_must_change {
        sqlx::query(
            r#"INSERT INTO admin_config (key, value, updated_at, updated_by) VALUES (?, '0', ?, ?)
               ON CONFLICT(key) DO UPDATE SET value = '0', updated_at = excluded.updated_at, updated_by = excluded.updated_by"#,
        )
        .bind(PIN_MUST_CHANGE_KEY)
        .bind(now)
        .bind(updated_by)
        .execute(pool)
        .await?;
    }
    Ok(())
}

fn hash_pin(pin: &str) -> Result<String> {
    bcrypt::hash(pin, bcrypt::DEFAULT_COST).map_err(|e| anyhow!("bcrypt: {e}"))
}
