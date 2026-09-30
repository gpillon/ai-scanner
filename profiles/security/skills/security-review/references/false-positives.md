# False-positive filtering

Apply these rules to every candidate Finding in step 6. You do not need to reproduce a
vulnerability: read the code to decide whether it is real.

## Hard exclusions

Do not report candidates matching these patterns:

1. Denial of Service (DoS) vulnerabilities or resource exhaustion attacks.
2. Rate limiting concerns or service overload scenarios.
3. Memory consumption or CPU exhaustion issues.
4. Lack of input validation on non-security-critical fields without proven security impact.
5. Input sanitization concerns for GitHub Action workflows unless they are clearly triggerable via
   untrusted input.
6. A lack of hardening measures. Code is not expected to implement all security best practices;
   only flag concrete vulnerabilities (hardening advice may appear as `info` at most).
7. Race conditions or timing attacks that are theoretical rather than practical issues. Only
   report a race condition if it is concretely problematic.
8. Memory safety issues such as buffer overflows or use-after-free vulnerabilities in Rust or any
   other memory-safe language.
9. Files that are only unit tests or only used as part of running tests.
10. Log spoofing concerns. Outputting un-sanitized user input to logs is not a vulnerability.
11. SSRF vulnerabilities that only control the path. SSRF is only a concern if it can control the
    host or protocol.
12. Including user-controlled content in AI system prompts is not a vulnerability.
13. Regex injection. Injecting untrusted content into a regex is not a vulnerability.
14. Regex DoS concerns.
15. Insecure documentation. Do not report findings in documentation files such as Markdown files.
16. A lack of audit logs is not a vulnerability.

Committed secrets and risky or outdated dependencies are **not** excluded: this review reports
them (steps 2 and 3 of the method).

## Precedents

1. Logging high-value secrets in plaintext is a vulnerability. Logging URLs is assumed to be safe.
2. UUIDs can be assumed to be unguessable and do not need to be validated.
3. Environment variables and CLI flags are trusted values: an attack that relies on controlling
   one is invalid. (A *fallback* used when one is missing is a different matter: see the
   `insecure-defaults` skill.)
4. Resource management issues such as memory or file descriptor leaks are not valid.
5. Subtle or low-impact web vulnerabilities such as tabnabbing, XS-Leaks, prototype pollution and
   open redirects should not be reported unless they are extremely high confidence.
6. React and Angular are generally secure against XSS. Do not report XSS in React or Angular
   components or tsx files unless they use `dangerouslySetInnerHTML`, `bypassSecurityTrustHtml`
   or similar methods.
7. Most vulnerabilities in GitHub Action workflows are not exploitable in practice. Before
   reporting one, make sure it is concrete and has a very specific attack path.
8. A lack of permission checking or authentication in client-side JS/TS code is not a
   vulnerability: the server is responsible for it. The same applies to all flows that send
   untrusted data to the backend.
9. Only include `medium` Findings if they are obvious and concrete issues.
10. Most vulnerabilities in IPython notebooks (`*.ipynb`) are not exploitable in practice. Report
    one only with a very specific attack path where untrusted input can trigger it.
11. Logging non-PII data is not a vulnerability even if the data may be sensitive. Only report
    logging that exposes secrets, passwords or personally identifiable information.
12. Command injection in shell scripts is generally not exploitable in practice, since shell
    scripts rarely run with untrusted input. Report it only with a concrete attack path for
    untrusted input.
13. Even if something is only exploitable from the local network, it can still be `high`.

## Signal quality

For each remaining candidate, ask:

1. Is there a concrete, exploitable vulnerability with a clear attack path?
2. Does it represent a real security risk rather than theoretical best practice?
3. Are there specific code locations and a way to reach them?
4. Would a security team act on it?

Rate your confidence from 1 to 10. Report only candidates at 8 or above as `high` confidence and
7 as `medium`; drop the rest.
