# Prepare a new station from the dashboard

1. Create the destination station in **Dashboard → Stations** and open its details.
2. Choose **Configure station**. Company admins and super admins have access.
3. Start with the generated template, or select another station and **Copy into this draft** to reuse its setup.
4. Set the protocol and serial port, products, pump/nozzle addresses and prices, tanks, and ATG branches/slots. Expand **Service, sync & shifts** for the remaining settings.
5. Review the configuration, then choose **Save & download**. Validation errors identify settings that need correction.
6. Install the downloaded file as `site.config.json` on the new station before the first service start. The file includes the destination station's current API key and server URL.

Copying replaces the current draft. It keeps the destination station identity and sync credentials, clears ATG integration credentials, and resets starting tank volumes to zero. Check serial ports, database paths, ATG hosts, branch IDs, tank IDs, and volumes for the new installation. Protocol selection fills standard serial settings; hardware addresses and prices must still match the installed equipment.

The editor uses the existing versioned configuration storage and download endpoints. Existing JSON upload/download and station backups remain available. Fields not edited by the form are preserved, including product UUIDs and protocol/ATG extensions. Server validation checks the configuration structure, references, address uniqueness, protocol constraints, ATG slots, and shift schedules before saving a dashboard configuration. Station backup ingestion retains its existing behavior.

Saving on the dashboard does not apply changes to a running dispenser service. On first startup, the service seeds products and nozzle settings from the JSON file. Existing installations retain those settings in their local database; use local administration for those changes. Replacing their JSON file does not replace the local product/nozzle database. The dispenser engine, transaction handling, price synchronization, and startup precedence are unchanged.

Validation checks:

```sh
npm run test:config --workspace=apps/web
npm run test --workspace=apps/backend -- --runInBand
npm run build --workspace=apps/web
npm run build --workspace=apps/backend
cargo test -p site_config --offline
```
