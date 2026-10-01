# Model options set per model by the admin, mapped per provider kind

How a model runs, first whether it thinks before answering and how much, matters as much as which model it is. Thinking makes a review slower and more expensive, and on a local model it can be most of the time an Attempt takes; some models think by default, some do not.

That is a property of the model, not of a Scan: it is set once, with the model, by whoever manages the Model Pool (ADR-0006). So each model of the pool has **model options**, starting with `thinking` (`on` or `off`) and, with `on`, `thinkingLevel` (`low`, `medium`, `high`, `xhigh` or `max`). An option left out is the model's own behaviour, and nothing is sent for it. The admin sets them when adding a model (`POST /api/admin/models`) or later (`PATCH /api/admin/models/<id>`), where a `thinking` given replaces the level too and `null` goes back to the model's own behaviour; `GET /api/admin/models` returns them, with the options each model's Provider takes. Callers only choose the model: `POST /api/scan/<id>` takes no model options.

Each provider says it differently, so the Model Pool, which knows the Provider's kind, maps them (`src/models/model-options.ts`) to opencode model `options`. The Runners place those under the model in opencode's configuration, where opencode merges them over its own and hands them to the provider's AI SDK package; the agent layer stays generic and never sees a thinking setting. What opencode 1.18.34 sends, checked against a capture server:

| Kind | `off` | `on` | level |
|---|---|---|---|
| `openai-compatible` | `chat_template_kwargs: {enable_thinking: false}` | `chat_template_kwargs: {enable_thinking: true}` | `reasoning_effort` |
| `openai` | `reasoning.effort: none` | the model's default effort | `reasoning.effort` |
| `anthropic` | `thinking: {type: disabled}` | `thinking: {type: adaptive}` | `output_config.effort` |

`chat_template_kwargs` is how vLLM and SGLang switch the thinking of Qwen3 and alike: IGNIS (`qwen3.8-27b`) answers without reasoning with it off. Other kinds take no thinking options: setting them on such a model is refused with `400`, as is a level without thinking on.

opencode's `run --variant` was not used: its variants are opencode's own table, empty for many models (every `qwen` one among them), while model `options` reach the request as given.

## Consequences

- Like the rest of the pool, a change applies from the next Attempt, of running Scans too: the supervisor resolves the model, with its options, for every Attempt. A Scan records only its model, not the options it ran with.
- Whether a model honours a setting is the provider's to say. One that refuses it fails the Attempt with the provider's message: the latest Claude models cannot turn thinking off, Claude models before 4.6 take a token budget rather than adaptive thinking, Claude models before Opus 4.7 have no `xhigh`, OpenAI has no `max`, and older OpenAI reasoning models do not take effort `none`. The server checks only what it can know, the provider kind; the level is sent as given.
- A server without thinking levels, as vLLM serving Qwen3, ignores `reasoning_effort`: the level then changes nothing.
- The warm-up (ADR-0009) does not send the model options: a setting the provider refuses shows at the first Attempt, not before it.
- More options (temperature, a token budget) fit the same shape: a field of the admin model routes, a key of `modelOptions`, a mapping per kind.
- The agent image pins opencode 1.18.33; the mapping was checked with 1.18.34. A new opencode may move where `options` land: `test/agent-config.e2e-spec.ts` pins the configuration, not the requests.

## Considered Options

- Letting each Scan choose was the first version, released in 0.4.1: callers could change how a model the admin chose runs, its cost and its duration among them, and had to know which provider kinds take what. The same model with thinking on and off can be two pool models, under two ids.
- Passing raw provider options was rejected: the admin would need to know each provider's dialect, and could set anything opencode accepts.
- A per-model capability table was rejected: models change faster than the server, and the provider already answers with a clear error.
