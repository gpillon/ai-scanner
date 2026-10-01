# The Model Pool lives in the database, managed by an admin

The Model Pool used to be `SCANNER_MODELS`, read once at startup. It is now two tables. **Providers** hold the kind, base URL and API key of an LLM API. **Models** hold a Provider, the model's name there, whether it is enabled, and which one is the Default Model. An admin manages both from the UI or the `/api/admin` routes, and the server can ask a Provider's API which models it offers.

Managing the pool decides two things for every Scan: where its source code is sent, and where the sandbox may connect. So it needs a role of its own, not the shared caller token (ADR-0002):

- **Admin token.** `SCANNER_ADMIN_TOKEN` opens the admin routes as well as the Scan API. The shared token gets 403 there. Without an admin token, administration is disabled.
- **Keys at rest.** API keys are sealed with AES-256-GCM under `SCANNER_SECRET_KEY`, bound to their Provider row, and never returned by the API. The database sits on the same volume as uploaded code, so keys must not be stored in clear. A key that cannot be decrypted (the secret changed) fails the Scans that need it, not the server.
- **Egress at runtime.** The egress proxy rereads its allow list from a file the server rewrites before every Attempt, mounted read-only. Pool changes therefore take effect without restarting the proxy, which would cut off running Attempts. Agents share a network with the proxy, so a control endpoint on it was ruled out: an agent could have opened its own egress. A missing file allows nothing.
- **Running Scans are kept safe.** A disabled model is no longer offered, but Scans already using it still run. The allow list covers every model, disabled ones included. A model with queued or running Scans cannot be removed.
- **Seeding.** `SCANNER_MODELS` seeds the pool on the very first start only, recorded in the database. Models an admin removed do not come back at the next restart, and later edits to the variable are ignored.

## Considered Options

- Keeping the pool in configuration was rejected: every change needed a restart, and model discovery had nowhere to put its results.
- Storing only the name of an environment variable holding each key was rejected: adding a Provider from the UI would still have needed a change to the server's environment. It remains possible for seeded Providers (`apiKeyEnv`).
- One shared token for administration too was rejected: any caller could have pointed Scans, and the sandbox's egress, at a host of their choosing.
