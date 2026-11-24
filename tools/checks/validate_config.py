"""Exercise the installer's read-only CLI against the real service binary."""
import copy
import json
import pathlib
import subprocess
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
BINARY = pathlib.Path(sys.argv[1]).resolve() if len(sys.argv) > 1 else ROOT / "target/debug/dispenser-service"


def main():
    original = json.loads((ROOT / "services/dispenser-service/site.mock.json").read_text())
    with tempfile.TemporaryDirectory(prefix="azs-validate-") as directory:
        root = pathlib.Path(directory)
        config = root / "station config.json"
        database = root / "must-not-create.db"
        original["service"]["db_path"] = str(database)
        original["service"]["serial_log_file"] = str(root / "must-not-create.log")
        original["private_extension"] = "INSTALLER-MUST-NOT-PRINT-THIS"
        # Legacy identity normalization must happen in memory only.
        original["tanks"] = [{"label": "Unnamed product tank", "capacity_l": 10000, "current_l": 0}]
        config.write_text(json.dumps(original), encoding="utf-8")
        before = config.read_bytes()
        for args in (["validate-config", "--config", str(config)], ["--config", str(config), "validate-config"]):
            result = subprocess.run([str(BINARY), *args], cwd=root, capture_output=True, text=True, timeout=15)
            assert result.returncode == 0, result.stderr
            metadata = json.loads(result.stdout)
            assert metadata["site"] == original["site"]["id"]
            assert metadata["db_path"] == str(database)
            assert metadata["port"] == original["service"]["port"]
            assert "INSTALLER-MUST-NOT-PRINT-THIS" not in result.stdout + result.stderr
            assert config.read_bytes() == before, "Validator modified the config"
            assert list(root.iterdir()) == [config], "Validator created database/log files"

        invalid = copy.deepcopy(original)
        invalid["fueling_positions"][0]["nozzles"].append(invalid["fueling_positions"][0]["nozzles"][0].copy())
        config.write_text(json.dumps(invalid), encoding="utf-8")
        before = config.read_bytes()
        result = subprocess.run([str(BINARY), "validate-config", "--config", str(config)], cwd=root, capture_output=True, text=True, timeout=15)
        assert result.returncode != 0, "Invalid duplicate nozzle config was accepted"
        assert config.read_bytes() == before
        assert not database.exists()
        print("PASS read-only validation, legacy tank normalization, both CLI argument orders, credential omission, invalid config rejection")


if __name__ == "__main__":
    main()
