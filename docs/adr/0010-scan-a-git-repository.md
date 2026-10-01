# A Scan can read its code from a Git repository

Callers whose code lives in Git should not have to zip it. `POST /api/scan/<id>` therefore also takes `repoUrl`, with an optional `ref` (branch or tag; the default branch otherwise) and credentials for a private repository. `POST /api/git/refs` lists a repository's branches and tags for the UI to offer.

The server fetches the one commit during the POST, before the Scan exists, so a repository that cannot be read leaves nothing behind. It stores the checked-out tree with the Scan. The supervisor copies that tree into the workspace where it would otherwise extract a zip. The Scan records the URL, ref and commit, and the Report shows them in place of the archive's hash.

The Source Repository is as untrusted as a Source Archive (ADR-0003), and fetching it makes the server reach out on a caller's behalf. So `git` runs hardened:

- **Nothing of the server's own Git setup.** There is no credential helper (it could hold the server owner's logins), no system or user configuration, no prompts, no templates and no submodules.
- **https only.** `http` is allowed only with `SCANNER_GIT_ALLOW_HTTP`, and never with credentials, except to loopback in tests.
- **Limits.** One commit deep, with a time limit and a low-speed limit, and the extraction limits on the tree.
- **Credentials only in memory.** They travel as an HTTP header set through the environment of the one git command. They are never in its arguments, a file, the URL, the database or a log, and URLs that carry credentials are refused.
- **Nothing executable lands.** Symlinks are checked out as plain files holding their target, as the zip path does, so neither the agent nor the server's report builder follows one out of the tree. `.git` is removed. A ref that looks like an option is refused.
- **Some destinations are refused.** Loopback, link-local (cloud metadata) and unspecified addresses are refused after resolving the host, on a best-effort basis since git resolves again. `SCANNER_GIT_HOSTS` restricts the allowed hosts. Private network ranges stay allowed by default, because an internal Git server is the main reason to need private repositories. Holders of the caller token can therefore make the server fetch from the internal network: set `SCANNER_GIT_HOSTS` where that matters.

Git LFS objects are not fetched; their pointer files are what the agent reads.

## Considered Options

- Fetching asynchronously, in a new Scan state, was rejected for now. The credentials would have to outlive the request, and a one-commit fetch takes seconds. The POST waits at most `SCANNER_GIT_TIMEOUT_SECONDS`; the chart's Route timeout allows for it.
- Re-zipping the checkout to reuse the archive path was rejected. It needs a zip writer, and it would add a step that changes nothing about the trust in the code.
- Storing credentials to fetch again later (for a retry, say) was rejected: the checkout is kept for the Scan's whole life instead.

## Consequences

- Amended by ADR-0014: a Saved Repository stores its token, sealed under `SCANNER_SECRET_KEY`, so that Scan Schedules can fetch private repositories. Credentials given with `repoUrl` are still never stored.
