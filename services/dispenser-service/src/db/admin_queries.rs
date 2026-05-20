use anyhow::Result;
use sqlx::SqlitePool;
use types::{AdminConfigEntry, CreateOperatorCmd, Operator, PriceChange};

#[allow(dead_code)]
pub async fn get_config_value(pool: &SqlitePool, key: &str) -> Result<Option<String>> {
    let row: Option<(String,)> =
        sqlx::query_as("SELECT value FROM admin_config WHERE key = ?")
            .bind(key)
            .fetch_optional(pool)
            .await?;
    Ok(row.map(|(v,)| v))
}

pub async fn set_config_value(
    pool: &SqlitePool,
    key: &str,
    value: &str,
    updated_by: &str,
) -> Result<()> {
    let now = chrono::Utc::now().timestamp_millis();
    sqlx::query(
        r#"INSERT INTO admin_config (key, value, updated_at, updated_by) VALUES (?, ?, ?, ?)
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by"#,
    )
    .bind(key)
    .bind(value)
    .bind(now)
    .bind(updated_by)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_admin_config(pool: &SqlitePool) -> Result<Vec<AdminConfigEntry>> {
    let rows: Vec<(String, String, i64, String)> = sqlx::query_as(
        "SELECT key, value, updated_at, updated_by FROM admin_config ORDER BY key",
    )
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(|(key, value, updated_at, updated_by)| AdminConfigEntry {
            key,
            value,
            updated_at,
            updated_by,
        })
        .collect())
}

pub async fn insert_price_change(
    pool: &SqlitePool,
    fp_id: &str,
    nozzle_index: u8,
    product_id: u8,
    product_name: &str,
    old_price: u32,
    new_price: u32,
    changed_by: &str,
) -> Result<()> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp_millis();
    sqlx::query(
        r#"INSERT INTO price_history
           (id, fp_id, nozzle, product_id, product_name, old_price, new_price, changed_at, changed_by)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"#,
    )
    .bind(&id)
    .bind(fp_id)
    .bind(nozzle_index as i64)
    .bind(product_id as i64)
    .bind(product_name)
    .bind(old_price as i64)
    .bind(new_price as i64)
    .bind(now)
    .bind(changed_by)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn list_price_history(pool: &SqlitePool, limit: i64) -> Result<Vec<PriceChange>> {
    let rows: Vec<(
        String,
        String,
        i64,
        i64,
        String,
        i64,
        i64,
        i64,
        String,
    )> = sqlx::query_as(
        r#"SELECT id, fp_id, nozzle, product_id, product_name, old_price, new_price, changed_at, changed_by
           FROM price_history ORDER BY changed_at DESC LIMIT ?"#,
    )
    .bind(limit)
    .fetch_all(pool)
    .await?;
    Ok(rows
        .into_iter()
        .map(
            |(id, fp_id, nozzle, product_id, product_name, old_price, new_price, changed_at, changed_by)| {
                PriceChange {
                    id,
                    fp_id,
                    nozzle_index: nozzle as u8,
                    product_id: product_id as u8,
                    product_name,
                    old_price: old_price as u32,
                    new_price: new_price as u32,
                    changed_at,
                    changed_by,
                }
            },
        )
        .collect())
}

pub async fn insert_operator(
    pool: &SqlitePool,
    cmd: &CreateOperatorCmd,
) -> Result<Operator> {
    let id = uuid::Uuid::new_v4().to_string();
    let now = chrono::Utc::now().timestamp_millis();
    let name = cmd.name.trim().to_string();
    let pin_hash = cmd
        .pin
        .as_ref()
        .filter(|p| !p.trim().is_empty())
        .map(|p| bcrypt::hash(p.trim(), bcrypt::DEFAULT_COST))
        .transpose()
        .map_err(|e| anyhow::anyhow!("bcrypt: {e}"))?;
    let has_pin = pin_hash.is_some();
    sqlx::query(
        r#"INSERT INTO operators (id, name, pin_hash, active, created_at) VALUES (?, ?, ?, 1, ?)"#,
    )
    .bind(&id)
    .bind(&name)
    .bind(pin_hash)
    .bind(now)
    .execute(pool)
    .await?;
    Ok(Operator {
        id,
        name,
        has_pin,
        active: true,
        created_at: now,
    })
}

pub async fn update_operator(
    pool: &SqlitePool,
    id: &str,
    active: Option<bool>,
    pin: Option<&str>,
) -> Result<Option<Operator>> {
    if let Some(a) = active {
        sqlx::query("UPDATE operators SET active = ? WHERE id = ?")
            .bind(if a { 1i64 } else { 0 })
            .bind(id)
            .execute(pool)
            .await?;
    }
    if let Some(p) = pin {
        if !p.trim().is_empty() {
            let hash = bcrypt::hash(p.trim(), bcrypt::DEFAULT_COST)
                .map_err(|e| anyhow::anyhow!("bcrypt: {e}"))?;
            sqlx::query("UPDATE operators SET pin_hash = ? WHERE id = ?")
                .bind(hash)
                .bind(id)
                .execute(pool)
                .await?;
        }
    }
    #[derive(sqlx::FromRow)]
    struct OpRow {
        id: String,
        name: String,
        pin_hash: Option<String>,
        active: i64,
        created_at: i64,
    }
    let row: Option<OpRow> = sqlx::query_as(
        "SELECT id, name, pin_hash, active, created_at FROM operators WHERE id = ?",
    )
    .bind(id)
    .fetch_optional(pool)
    .await?;
    Ok(row.map(|r| Operator {
        id: r.id,
        name: r.name,
        has_pin: r.pin_hash.is_some(),
        active: r.active != 0,
        created_at: r.created_at,
    }))
}

pub async fn delete_operator(pool: &SqlitePool, id: &str) -> Result<bool> {
    let r = sqlx::query("UPDATE operators SET active = 0 WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;
    Ok(r.rows_affected() > 0)
}
