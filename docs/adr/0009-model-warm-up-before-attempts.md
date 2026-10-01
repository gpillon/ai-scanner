# The server warms the model up before a Scan's first Attempt

Before the first Attempt, the server asks the Scan's model for a real completion of one token. The Scan shows a state of its own meanwhile: `queued` → `warming` → `running`. The Attempt starts only once the model has answered: no agent pod or container waits for the model, and none starts for a model that cannot be used.

Models served with scale-to-zero (Knative, KServe, an autoscaler) hold the first request until a replica is up. That can take many minutes; on the test cluster a cold start took about eight. Without a warm-up, that time was spent inside the first Attempt, counted against its timeout, and showed nothing about what was going on.

- **One real completion.** It uses the API of the model's Provider kind: `chat/completions` for OpenAI and OpenAI-compatible APIs, `messages` for Anthropic, `generateContent` for Google. It uses the same key the agent gets. A model that refuses `max_tokens` is asked again with `max_completion_tokens`.
- **Long, bounded, retried.** The request may wait as long as the warm-up has left, `SCANNER_WARMUP_TIMEOUT_MINUTES`, 30 by default.
  - Answers a waking model gives (408, 409, 425, 429, 5xx) and network errors are retried, with a pause that starts at 5 s and doubles up to 30 s.
  - Any other answer (a wrong key, an unknown model, a bad request) fails the Scan at once, with the model's own error as the reason.
- **Its own state and its own clock.** The Scan timeout starts after the warm-up, so a slow wake-up does not eat into the Attempts' time. A `warming` Scan holds a concurrency slot. It is aborted when the Scan is deleted, and requeued when the server restarts.
- **Visible.** Each step goes to the Scan's warm-up log, which the activity stream shows as Attempt 0 `log` events: which model, every retry, and how long it took to answer.
- The server sends the request itself, not the agent. It reaches the model directly, not through an Attempt's egress proxy, which exists only once an Attempt starts.

## Consequences

- Every Scan costs one extra one-token completion.
- Concurrent Scans of the same model each send their own warm-up. They all wait for the same scale-up, which is harmless and keeps each Scan's warm-up its own.
- `SCANNER_WARMUP_TIMEOUT_MINUTES=0` skips the warm-up: Scans go from `queued` straight to `running`, as before.

## Considered Options

- **Waking the model from the agent's first request** was the behaviour before. It hid the wait inside an Attempt, counted it against the Attempt timeout, and could only fail after a container or pod had started.
- **A health or models endpoint instead of a completion** was rejected. Gateways answer `/models` while the model behind them is still scaled to zero, as the test cluster's did, so only a completion proves the model answers.
