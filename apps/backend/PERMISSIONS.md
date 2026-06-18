# Backend Permissions

Roles:

- `SUPER_ADMIN`: all companies and all operational actions.
- `COMPANY_ADMIN`: all stations and operational data inside their company.
- `STATION_MANAGER`: assigned stations only; may view operational data and edit assigned-station prices/reservoirs.
- `ACCOUNTANT`: assigned stations only; read/report/export access, no operational edits.

| Area | SUPER_ADMIN | COMPANY_ADMIN | STATION_MANAGER | ACCOUNTANT |
|---|---:|---:|---:|---:|
| Companies | all | own company read | no | no |
| Users | all | own company | no | no |
| Stations | all | own company | assigned only | assigned only |
| Dashboard | all | company | assigned only | assigned only |
| Transactions | all | company | assigned only | assigned only |
| Shifts | all | company | assigned only | assigned only |
| Reports/exports | all | company | assigned only | assigned only |
| Reservoirs | all | company | assigned read/edit | assigned read only |
| Prices | all | company | assigned read/edit | assigned read only |
| Alert rules/integrations | all | company | no | no |
| Station sync API | station API key | station API key | station API key | station API key |

Implementation notes:

- Station-scoped HTTP endpoints must call `resolveStationIds()` before querying data.
- Admin roles still resolve requested station IDs through the database, so a company admin cannot request a station outside their company.
- Background export jobs carry the already-resolved station IDs from the request.
