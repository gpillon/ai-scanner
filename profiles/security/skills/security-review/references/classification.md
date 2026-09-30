# Classification: category, CWE, OWASP

Give each Finding a `category`, `cwe` and `owasp` taken from this table: it is the only reference
you need, so do not search the skills or the workspace for others. When no row fits, choose the
closest CWE you know for certain; when you are unsure, omit `cwe` rather than guess.

OWASP is the OWASP Top 10 2021, written as in the table.

| `category` | `cwe` | `owasp` |
|---|---|---|
| `sql_injection` | CWE-89 | A03:2021 Injection |
| `nosql_injection` | CWE-943 | A03:2021 Injection |
| `command_injection` | CWE-78 | A03:2021 Injection |
| `code_injection` (`eval`, dynamic code) | CWE-95 | A03:2021 Injection |
| `template_injection` | CWE-1336 | A03:2021 Injection |
| `ldap_injection` | CWE-90 | A03:2021 Injection |
| `xpath_injection` | CWE-643 | A03:2021 Injection |
| `header_injection` | CWE-113 | A03:2021 Injection |
| `xss` | CWE-79 | A03:2021 Injection |
| `path_traversal` | CWE-22 | A01:2021 Broken Access Control |
| `idor` | CWE-639 | A01:2021 Broken Access Control |
| `missing_authorization` | CWE-862 | A01:2021 Broken Access Control |
| `missing_authentication` | CWE-306 | A07:2021 Identification and Authentication Failures |
| `privilege_escalation` | CWE-269 | A01:2021 Broken Access Control |
| `mass_assignment` | CWE-915 | A08:2021 Software and Data Integrity Failures |
| `csrf` | CWE-352 | A01:2021 Broken Access Control |
| `open_redirect` | CWE-601 | A01:2021 Broken Access Control |
| `ssrf` | CWE-918 | A10:2021 Server-Side Request Forgery |
| `jwt_weakness` | CWE-347 | A02:2021 Cryptographic Failures |
| `session_fixation` | CWE-384 | A07:2021 Identification and Authentication Failures |
| `hardcoded_secret` | CWE-798 | A07:2021 Identification and Authentication Failures |
| `insecure_default` (fallback secret, fail-open switch) | CWE-1188 | A05:2021 Security Misconfiguration |
| `default_credentials` | CWE-1392 | A07:2021 Identification and Authentication Failures |
| `debug_enabled` | CWE-489 | A05:2021 Security Misconfiguration |
| `permissive_cors` | CWE-942 | A05:2021 Security Misconfiguration |
| `sensitive_data_exposure` (logs, errors, responses) | CWE-200 | A04:2021 Insecure Design |
| `insecure_deserialization` | CWE-502 | A08:2021 Software and Data Integrity Failures |
| `xxe` | CWE-611 | A05:2021 Security Misconfiguration |
| `unsafe_file_upload` | CWE-434 | A04:2021 Insecure Design |
| `weak_crypto` | CWE-327 | A02:2021 Cryptographic Failures |
| `weak_randomness` | CWE-338 | A02:2021 Cryptographic Failures |
| `weak_password_hashing` | CWE-916 | A02:2021 Cryptographic Failures |
| `disabled_tls_verification` | CWE-295 | A02:2021 Cryptographic Failures |
| `race_condition` | CWE-362 | A04:2021 Insecure Design |
| `missing_rate_limiting` | CWE-770 | A04:2021 Insecure Design |
| `vulnerable_dependency` | CWE-1395 | A06:2021 Vulnerable and Outdated Components |
| `outdated_dependency` | CWE-1104 | A06:2021 Vulnerable and Outdated Components |
