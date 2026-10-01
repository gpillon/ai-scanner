# No user concept: the caller chooses the Scan id, one shared token

ai-scanner has no users, owners or tenants. The caller picks the Scan id (`POST /api/scan/<id>`, constrained format) and retrieves by the same id. All endpoints require a single shared bearer token from config. Anyone holding the token and a Scan id can read that Scan's Report.

We chose this because the callers are other systems that already have their own identifiers and access control, and a PoC should not own identity.

## Consequences

- Amended by ADR-0006: an optional admin token also exists, for managing the Model Pool. Callers still share one token.
- Amended by ADR-0014: the Scans of a private Saved Repository are read with the admin token only, as they quote its code.

- A `POST` to an existing id returns `409`. There is no silent idempotency, because the uploaded Source Archive may differ. A caller who wants to redo a Scan sends `DELETE` and then `POST`.
- `DELETE` stops a running Scan and removes everything. The id becomes free again, exactly as when retention expires (365 days, then `404`).
- ~~Callers must choose ids that are not guessable if other holders of the token should not read their Reports.~~ Superseded: `GET /api/scans` lists every Scan to anyone holding the token, so the token alone grants access to every Report. We accepted this so that the web UI can show all Scans. Callers who need their Reports kept apart need separate deployments (or a real identity model, which this ADR still rules out).
