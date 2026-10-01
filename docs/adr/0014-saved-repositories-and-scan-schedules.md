# Saved Repositories and Scan Schedules

Callers scan the same repositories again and again, and want some of them scanned on a timetable without anyone pressing a button. Two things now live in the database, next to the Scans:

- A **Saved Repository** is a Source Repository kept under a name: its URL, the branch or tag Scans check out unless they say otherwise, and credentials when it is private. `POST /api/scan/<id>` takes `repository=<name>` in place of a zip or `repoUrl`, with an optional `ref` over the repository's own. The Scan records the name in its `source`.
- A **Scan Schedule** names a Saved Repository and the rest of a Scan's choices (profile, model, language, instructions, Skill Packs, Attempt timeout), and when to start Scans: every N hours, daily at a time, or at a time on chosen weekdays. The time is wall-clock time in an IANA time zone chosen with the schedule, so `02:00 Europe/Rome` stays 02:00 across daylight saving. A time skipped by the clock change runs as many minutes after the jump as it was past its start (02:30 on a day that jumps from 02:00 to 03:00 runs at 03:30); a time that happens twice runs the first time.

Public repositories and their schedules are open to the caller token, like Scans: there is no owner (ADR-0002). Private ones are the admin's, below.

## Credentials are stored: this amends ADR-0010

ADR-0010 kept Git credentials in memory for one fetch and rejected storing them. A schedule that scans a private repository at night has nobody to type a token, so a Saved Repository stores its token, as Provider API keys are stored (ADR-0006):

- Sealed with AES-256-GCM under `SCANNER_SECRET_KEY` and bound to the repository's id, so a sealed value copied to another row does not open. Without the key, public repositories can be saved but tokens cannot.
- Never sent back: the API says only whether a token is set, and its last four characters when it is long enough to spare them.
- Opened only for the git command of one fetch, and handed to it the way ADR-0010 already does: an HTTP header through the environment, never the URL, the arguments, a file or a log.

**A private repository (one with a stored token) is the admin's.** Only the admin token (ADR-0006) stores a token, and only it scans such a repository, lists its branches, changes or removes it, and creates, changes, runs or removes its schedules: the caller token gets `403`. Callers still see it listed, without its token. So the stored token never fetches anything for a caller; it does fetch for the schedules an admin set up, which the server runs by itself.

**The Scans of a private repository are the admin's too.** Their Report and Findings quote its code, so a Scan fetched with a stored token is marked `private` in its `source`: the caller token does not see it in `GET /api/scans`, and gets `403` on its status, events, Artifacts and deletion. This amends ADR-0002 for these Scans only. It also covers a schedule a caller made for a public repository that an admin later stores a token on: the caller's instructions then steer an agent over private code, but the caller cannot read what it writes.

So that the token cannot be sent elsewhere, a Saved Repository with a stored token moves to another host only with a new token or with the stored one removed. `SCANNER_GIT_HOSTS` remains the bound on where fetches go at all. ADR-0010's other rules (https only, refused hosts, limits, nothing executable) apply unchanged to every fetch.

Credentials given per Scan with `repoUrl` are still never stored.

## How schedules run

- The server looks for due schedules every 30 seconds, and once at start. A due schedule first moves its next run on, then submits a Scan through the same path as a caller's POST, so every check, the fetch and the queue are the same.
- **A server that was down starts one Scan, not one per missed run**, then carries on from the current time.
- **A run is skipped while the schedule's previous Scan has not finished**, so a slow model does not pile Scans up behind it. The skip is recorded as the schedule's `lastError`.
- A run that fails (the repository cannot be read, the model left the pool) records why in `lastError`; the schedule keeps its timing and tries again at its next run.
- Scans are named `<schedule>-<yyyymmdd>-<hhmmss>` (UTC). They are ordinary Scans: retention (365 days) and deletion work as for any other.
- `POST /api/schedules/<id>/run` starts a Scan at once without moving the next run. So does any edit that leaves the timing and `enabled` as they were; a new timing, or enabling it again, counts from now.
- A Saved Repository used by a schedule cannot be removed; removing a schedule leaves its Scans.

## Considered Options

- **Cron expressions** were rejected for now. Three cadences cover the requests we have, give a form without a syntax to learn, and need no cron dependency; a `cron` cadence can be added beside them.
- **Times in UTC only** were rejected: a nightly Scan would drift by an hour twice a year where people live by daylight saving.
- **Asking for credentials at each scheduled run** cannot work, and storing them outside the database (a Kubernetes Secret per repository, say) would tie the feature to one Runner.
- **Keeping only the last N Scans of a schedule** is left for later: retention already bounds them.
