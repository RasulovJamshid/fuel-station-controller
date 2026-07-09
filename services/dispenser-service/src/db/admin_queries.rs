use anyhow::Result;
use site_config::{NozzleConfig, ProductConfig};
use sqlx::SqlitePool;
use std::collections::HashMap;
use types::{AdminConfigEntry, CreateOperatorCmd, Operator, PriceChange};

#[allow(dead_code)]
pub async fn get_config_value(pool: &SqlitePool, key: &str) -> Result<Option<String>> {
    let row: Option<(String,)> = sqlx::query_as("SELECT value FROM admin_config WHERE key = ?")
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
    let rows: Vec<(String, String, i64, String)> =
        sqlx::query_as("SELECT key, value, updated_at, updated_by FROM admin_config ORDER BY key")
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
            |(
                id,
                fp_id,
                nozzle,
                product_id,
                product_name,
                old_price,
                new_price,
                changed_at,
                changed_by,
            )| {
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

pub async fn insert_operator(pool: &SqlitePool, cmd: &CreateOperatorCmd) -> Result<Operator> {
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
    let row: Option<OpRow> =
        sqlx::query_as("SELECT id, name, pin_hash, active, created_at FROM operators WHERE id = ?")
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

pub async fn save_products_to_db(
    pool: &SqlitePool,
    products: &[ProductConfig],
    updated_by: &str,
) -> Result<()> {
    let now = chrono::Utc::now().timestamp_millis();
    tracing::info!("save_products_to_db: acquiring transaction");
    let mut tx = pool.begin().await?;
    tracing::info!("save_products_to_db: deleting old rows");
    sqlx::query("DELETE FROM products")
        .execute(&mut *tx)
        .await?;
    for p in products {
        sqlx::query(
            "INSERT INTO products (id, uuid, name, color, unit, updated_at, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(p.id as i64)
        .bind(&p.uuid)
        .bind(&p.name)
        .bind(&p.color)
        .bind(&p.unit)
        .bind(now)
        .bind(updated_by)
        .execute(&mut *tx)
        .await?;
    }
    tracing::info!("save_products_to_db: committing");
    tx.commit().await?;
    tracing::info!("save_products_to_db: done");
    Ok(())
}

pub async fn load_products_from_db(pool: &SqlitePool) -> Result<Vec<ProductConfig>> {
    let rows: Vec<(i64, String, String, String, String)> =
        sqlx::query_as("SELECT id, uuid, name, color, unit FROM products ORDER BY id")
            .fetch_all(pool)
            .await?;
    Ok(rows
        .into_iter()
        .map(|(id, uuid, name, color, unit)| ProductConfig {
            id: id as u8,
            uuid: if uuid.is_empty() {
                uuid::Uuid::new_v4().to_string()
            } else {
                uuid
            },
            name,
            color,
            unit,
        })
        .collect())
}

pub async fn save_fp_nozzles_to_db(
    pool: &SqlitePool,
    fp_id: &str,
    nozzles: &[NozzleConfig],
    updated_by: &str,
) -> Result<()> {
    let now = chrono::Utc::now().timestamp_millis();
    let mut tx = pool.begin().await?;
    sqlx::query("DELETE FROM fp_nozzles WHERE fp_id = ?")
        .bind(fp_id)
        .execute(&mut *tx)
        .await?;
    for n in nozzles {
        sqlx::query(
            "INSERT INTO fp_nozzles \
             (fp_id, nozzle_index, product_id, price, active, wayne_code, wayne_product_code, updated_at, updated_by) \
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(fp_id)
        .bind(n.index as i64)
        .bind(n.product_id as i64)
        .bind(n.price as i64)
        .bind(if n.active { 1i64 } else { 0 })
        .bind(n.wayne_code as i64)
        .bind(n.wayne_product_code as i64)
        .bind(now)
        .bind(updated_by)
        .execute(&mut *tx)
        .await?;
    }
    tx.commit().await?;
    Ok(())
}

pub async fn load_fp_nozzles_from_db(
    pool: &SqlitePool,
) -> Result<HashMap<String, Vec<NozzleConfig>>> {
    #[derive(sqlx::FromRow)]
    struct Row {
        fp_id: String,
        nozzle_index: i64,
        product_id: i64,
        price: i64,
        active: i64,
        wayne_code: i64,
        wayne_product_code: i64,
    }
    let rows: Vec<Row> = sqlx::query_as(
        "SELECT fp_id, nozzle_index, product_id, price, active, wayne_code, wayne_product_code \
         FROM fp_nozzles ORDER BY fp_id, nozzle_index",
    )
    .fetch_all(pool)
    .await?;
    let mut map: HashMap<String, Vec<NozzleConfig>> = HashMap::new();
    for r in rows {
        map.entry(r.fp_id).or_default().push(NozzleConfig {
            index: r.nozzle_index as u8,
            product_id: r.product_id as u8,
            price: r.price as u32,
            active: r.active != 0,
            // azt_address is persisted in the JSON site config, not this DB
            // catalog table; the poll loop reads it from there.
            azt_address: 0,
            wayne_code: r.wayne_code as u8,
            wayne_product_code: r.wayne_product_code as u8,
        });
    }
    Ok(map)
}

pub async fn update_nozzle_price_in_db(
    pool: &SqlitePool,
    fp_id: &str,
    nozzle_index: u8,
    price: u32,
    updated_by: &str,
) -> Result<()> {
    let now = chrono::Utc::now().timestamp_millis();
    sqlx::query(
        "UPDATE fp_nozzles SET price = ?, updated_at = ?, updated_by = ? \
         WHERE fp_id = ? AND nozzle_index = ?",
    )
    .bind(price as i64)
    .bind(now)
    .bind(updated_by)
    .bind(fp_id)
    .bind(nozzle_index as i64)
    .execute(pool)
    .await?;
    Ok(())
}
