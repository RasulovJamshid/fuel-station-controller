use anyhow::{Context, Result};
use site_config::SiteConfig;
use std::path::{Path, PathBuf};

pub fn load(path: Option<PathBuf>) -> Result<(SiteConfig, PathBuf)> {
    let p = path.unwrap_or_else(|| PathBuf::from("site.config.json"));
    let p = if p.is_absolute() {
        p
    } else {
        std::env::current_dir()
            .context("current working directory")?
            .join(p)
    };
    let s = p.to_str().context("config path is not valid UTF-8")?;
    let cfg = SiteConfig::load(s).with_context(|| format!("loading {}", p.display()))?;
    Ok((cfg, p))
}

pub fn save(cfg: &SiteConfig, path: &Path) -> Result<()> {
    let s = path.to_str().context("config path is not valid UTF-8")?;
    cfg.save(s)
        .with_context(|| format!("saving {}", path.display()))
}

/// Freeze legacy identities without discarding unknown configuration extensions.
pub fn persist_tank_ids(cfg: &SiteConfig, path: &Path) -> Result<()> {
    let mut value: serde_json::Value = serde_json::from_str(&std::fs::read_to_string(path)?)?;
    let original = value.clone();
    if let Some(tanks) = value.get_mut("tanks").and_then(|v| v.as_array_mut()) {
        for (raw, tank) in tanks.iter_mut().zip(&cfg.tanks) {
            if raw
                .get("tank_id")
                .and_then(|v| v.as_str())
                .is_none_or(str::is_empty)
            {
                raw["tank_id"] = serde_json::json!(tank.id());
            }
        }
    }
    if let (Some(branches), Some(atg)) = (
        value
            .get_mut("atg")
            .and_then(|v| v.get_mut("branches"))
            .and_then(|v| v.as_array_mut()),
        &cfg.atg,
    ) {
        for (raw, branch) in branches.iter_mut().zip(&atg.branches) {
            if let Some(slots) = raw.get_mut("slots").and_then(|v| v.as_array_mut()) {
                for (raw, slot) in slots.iter_mut().zip(&branch.slots) {
                    if raw.get("tank_id").is_none_or(|v| v.is_null()) {
                        raw["tank_id"] = serde_json::json!(slot.tank_id);
                    }
                }
            }
        }
    }
    if original != value {
        site_config::write_atomic(path, serde_json::to_string_pretty(&value)?.as_bytes())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn freezes_legacy_ids_without_losing_unknown_fields() {
        let path = std::env::temp_dir().join(format!("atg-config-{}.json", uuid::Uuid::new_v4()));
        let mut value: serde_json::Value =
            serde_json::from_str(include_str!("../site.mock.json")).unwrap();
        let pid = value["products"][0]["id"].clone();
        value["tanks"] = serde_json::json!([{"product_id":pid,"label":"Original","capacity_l":25000,"current_l":0}]);
        value["atg"] = serde_json::json!({"branches":[{"id":1,"host":"localhost","slots":[{"slot":1,"product_id":pid,"label":"legacy-id","type":"AI-92"}]}]});
        value["extension"] = serde_json::json!({"preserved":true});
        std::fs::write(&path, serde_json::to_vec(&value).unwrap()).unwrap();
        let cfg = SiteConfig::load(path.to_str().unwrap()).unwrap();
        persist_tank_ids(&cfg, &path).unwrap();
        let migrated: serde_json::Value =
            serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap();
        assert_eq!(migrated["extension"]["preserved"], true);
        assert_eq!(migrated["tanks"][0]["tank_id"], "legacy-id");
        assert_eq!(
            migrated["atg"]["branches"][0]["slots"][0]["tank_id"],
            "legacy-id"
        );
        std::fs::remove_file(path).unwrap();
    }
}
