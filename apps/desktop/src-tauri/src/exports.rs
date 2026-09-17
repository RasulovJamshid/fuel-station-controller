use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::Manager;

fn save_in_directory(directory: &Path, filename: &str, data: &[u8]) -> Result<PathBuf, String> {
    let stem = filename
        .strip_suffix(".xlsx")
        .filter(|stem| {
            !stem.is_empty()
                && stem.len() <= 100
                && stem
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
        .ok_or("Invalid Excel export filename")?;
    std::fs::create_dir_all(directory).map_err(|e| e.to_string())?;
    for index in 0..1000 {
        let name = if index == 0 {
            filename.to_owned()
        } else {
            format!("{stem}-{index}.xlsx")
        };
        let path = directory.join(name);
        match std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
        {
            Ok(mut file) => {
                if let Err(error) = file.write_all(data).and_then(|_| file.sync_all()) {
                    drop(file);
                    let _ = std::fs::remove_file(&path);
                    return Err(error.to_string());
                }
                return Ok(path);
            }
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    Err("Could not create a unique Excel export filename".into())
}

#[tauri::command]
pub async fn save_excel_export(
    app: tauri::AppHandle,
    filename: String,
    data: Vec<u8>,
) -> Result<String, String> {
    let directory = app
        .path()
        .download_dir()
        .or_else(|_| app.path().home_dir().map(|home| home.join("Downloads")))
        .map_err(|e| e.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        save_in_directory(&directory, &filename, &data)
            .map(|path| path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_paths_and_non_excel_files() {
        for name in [
            "../report.xlsx",
            "dir/report.xlsx",
            "C:\\report.xlsx",
            "report.csv",
            ".xlsx",
        ] {
            assert!(save_in_directory(Path::new("unused"), name, b"data").is_err());
        }
    }

    #[test]
    fn preserves_existing_exports() {
        let unique = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory =
            std::env::temp_dir().join(format!("azs-export-{}-{unique}", std::process::id()));
        let first = save_in_directory(&directory, "report.xlsx", b"first").unwrap();
        let second = save_in_directory(&directory, "report.xlsx", b"second").unwrap();
        assert_ne!(first, second);
        assert_eq!(std::fs::read(first).unwrap(), b"first");
        assert_eq!(std::fs::read(second).unwrap(), b"second");
        std::fs::remove_dir_all(directory).unwrap();
    }
}
