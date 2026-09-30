# No user concept: the caller chooses the Scan id, one shared token

ai-scanner has no users, owners or tenants. The caller picks the Scan id (`POST /api/scan/<id>`, constrained format) and retrieves by the same id. All endpoints require a single shared bearer token from config. Anyone holding the token and a Scan id can read that Scan's Report.

We chose this because the callers are other systems that already have their own identifiers and access control, and a PoC should not own identity.

## Consequences

- A `POST` to an existing id returns `409`. There is no silent idempotency, because the uploaded Source Archive may differ. A caller who wants to redo a Scan sends `DELETE` and then `POST`.
- `DELETE` stops a running Scan and removes everything. The id becomes free again, exactly as when retention expires (365 days, then `404`).
- Callers must choose ids that are not guessable if other holders of the token should not read their Reports.
