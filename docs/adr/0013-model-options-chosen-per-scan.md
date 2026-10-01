# Model options chosen per Scan, mapped per provider kind

A caller choosing a model also wants to choose how it runs: first, whether it thinks before answering and how much. Thinking makes a review slower and more expensive, and on a local model it can be most of the time an Attempt takes; some models think by default, some do not.

So `POST /api/scan/<id>` takes **model options** next to `model`, starting with `thinking` (`on` or `off`) and, with `on`, `thinkingLevel` (`low`, `medium` or `high`). An option left out is the model's own behaviour, and nothing is sent for it. The Scan records them as `modelOptions` and `GET /api/scan/<id>` returns them; the supervisor gives them to every Attempt.

Each provider says it differently, so the Model Pool, which knows the Provider's kind, maps them (`src/models/model-options.ts`) to opencode model `options`. The Runners place those under the model in opencode's configuration, where opencode merges them over its own and hands them to the provider's AI SDK package; the agent layer stays generic and never sees a thinking choice. What opencode 1.18.34 sends, checked against a capture server:

| Kind | `off` | `on` | level |
|---|---|---|---|
| `openai-compatible` | `chat_template_kwargs: {enable_thinking: false}` | `chat_template_kwargs: {enable_thinking: true}` | `reasoning_effort` |
| `openai` | `reasoning.effort: none` | the model's default effort | `reasoning.effort` |
| `anthropic` | `thinking: {type: disabled}` | `thinking: {type: adaptive}` | `output_config.effort` |

`chat_template_kwargs` is how vLLM and SGLang switch the thinking of Qwen3 and alike: IGNIS (`qwen3.8-27b`) answers without reasoning with it off. Other kinds take no thinking options: a Scan asking for them is refused with `400`. `GET /api/models` lists, per model, the options its provider takes, so the New Scan form offers the thinking controls only for those models.

opencode's `run --variant` was not used: its variants are opencode's own table, empty for many models (every `qwen` one among them), while model `options` reach the request as given.

## Consequences

- Whether a model honours a choice is the provider's to say. One that refuses it fails the Attempt with the provider's message: the latest Claude models cannot turn thinking off, Claude models before 4.6 take a token budget rather than adaptive thinking, and older OpenAI reasoning models do not take effort `none`. The server checks only what it can know, the provider kind.
- A server without thinking levels, as vLLM serving Qwen3, ignores `reasoning_effort`: the level then changes nothing.
- The warm-up (ADR-0009) does not send the model options: a choice the provider refuses shows at the first Attempt, not before it.
- More options (temperature, a token budget) fit the same shape: a field on `POST`, a key of `modelOptions`, a mapping per kind.
- The agent image pins opencode 1.18.33; the mapping was checked with 1.18.34. A new opencode may move where `options` land: `test/agent-config.e2e-spec.ts` pins the configuration, not the requests.

## Considered Options

- Passing raw provider options from the caller was rejected: callers would need to know each provider's dialect, and could set anything opencode accepts.
- A per-model capability table was rejected: models change faster than the server, and the provider already answers with a clear error.
