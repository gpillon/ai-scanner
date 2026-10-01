# Scan Profiles are server-owned; callers cannot supply skills

Callers select a Scan Profile by name (starting with `security`). The skills, prompts and Report expectations behind a profile live in this repo, versioned with the server. Callers can add only a model choice from the Model Pool, a Report language, and short free-text instructions, which are injected into a delimited section of the prompt.

Refined by ADR-0008: callers may also add Skill Packs, which an admin imported, on top of the profile's skills. They still cannot supply skills of their own.

## Considered Options

- Accepting skills uploaded alongside the Source Archive was rejected. It turns the API into an arbitrary agent-execution service, makes Reports irreproducible, and exposes skills (an implementation detail) as API surface, which blocks changing skills or switching agent (opencode, pi) without breaking callers.
