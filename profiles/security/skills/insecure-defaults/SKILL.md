---
name: insecure-defaults
description: Sweep a codebase for insecure default configuration (fallback secrets, default credentials, fail-open switches, weak crypto, permissive access, debug leakage) and trace each candidate before reporting it. Use in step 3 of a security review.
license: CC-BY-SA-4.0 (adapted from Trail of Bits; see LICENSE and NOTICE.md)
---

# Insecure defaults

Finds configuration that is insecure by default, and traces each candidate to the security
decision it reaches before reporting it. Loaded from step 3 of the `security-review` skill; what
survives here becomes a candidate Finding there.

## Categories

Each category has a corpus: a `.md` file with **Report when** / **Skip when** rules and worked
vulnerable/secure pairs, and a `.json` file with seed grep patterns.

| Category | Example | Corpus |
|----------|---------|--------|
| Fallback secrets | `SECRET = env.get('KEY') or 'dev'` | [fallback-secrets.md](references/fallback-secrets.md), [.json](references/fallback-secrets.json) |
| Default credentials | seeded `admin` / `admin123` | [default-credentials.md](references/default-credentials.md), [.json](references/default-credentials.json) |
| Fail-open switches | `getenv('REQUIRE_AUTH', 'false')` | [fail-open-security.md](references/fail-open-security.md), [.json](references/fail-open-security.json) |
| Weak crypto | `hashlib.md5(password)` | [weak-crypto.md](references/weak-crypto.md), [.json](references/weak-crypto.json) |
| Permissive access | `ACL='public-read'`, `0o666`, CORS `*` | [permissive-access.md](references/permissive-access.md), [.json](references/permissive-access.json) |
| Debug leakage | `traceback.format_exc()` in a response | [debug-features.md](references/debug-features.md), [.json](references/debug-features.json) |

## Sweep

For each category, one at a time:

1. Read its `.md` and `.json`.
2. Grep the codebase with every seed pattern in the `.json`. The seeds are a floor, not the
   search: also derive patterns for the stack you found, such as the project's own config
   wrappers (`get_setting("X", "default")`), language idioms (`ENV.fetch`,
   `System.getProperty(k, d)`, `${VAR:-default}`) and manifest formats (`default =` in HCL, `ENV`
   in a Dockerfile).
3. Collect the matches as candidates without judging them yet.

Skip test fixtures, documentation and vendored third-party code, unless the caller's instructions
point the review at them.

## Verify

Candidates come in two shapes:

- **Configurable**: a lookup with a fallback. Only a bug if the app runs with it:
  `env.get('K', 'x')` does; `env['K']` crashes instead, so it is fine.
- **Unconditional**: no configuration anywhere, insecure as written. A missing env var is not
  grounds to refute one.

Start every candidate as refuted, and keep it only if it passes every step:

1. Is the file reachable in production?
2. Is the insecure value the one that runs? Configurable: does the code fail secure instead?
   Unconditional: this step cannot refute it.
3. Is the value actually insecure, by the category's **Report when** / **Skip when** rules?
4. Does it reach a security decision? Name the sink (the signing call, the auth check, the
   response).
5. Configurable only: does deployment always supply the variable? Look at the manifests,
   Dockerfiles, compose files and CI in the workspace. This step never refutes on its own: if
   every manifest sets it, lower the severity; if none does, or you cannot tell, treat the default
   as reachable.

An incomplete trace refutes the candidate.

## Severity

On the `security-review` scale: a known secret or credential that the app runs with in production
and that guards authentication, signing or encryption is `critical` or `high`; the same guarding
something less sensitive, or only reachable when a deployment forgets a variable that manifests
normally set, is `medium` or `low`.
