import type { ProviderKind } from './provider-kinds';

/**
 * Thinking levels a model may be set to. Each is sent as given: whether a model takes it is the
 * provider's to say (OpenAI has no `max`, Claude models before Opus 4.7 no `xhigh`).
 */
export const THINKING_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * How a model of the Model Pool runs, over its own defaults, as the admin set it (ADR-0013). Each
 * field is optional: one left out is the model's own behaviour, and nothing is sent for it.
 */
export interface ModelOptions {
  /** Whether the model reasons before answering. */
  thinking?: 'on' | 'off';
  /** With `thinking: 'on'`: how much. Without it, the model's own level. */
  thinkingLevel?: ThinkingLevel;
}

/**
 * What each provider kind is sent for a thinking setting, as opencode model `options` (which it
 * hands to the provider's AI SDK package). Kinds missing here cannot take thinking options.
 * Whether a given model honours them is the provider's to say: one that refuses fails the
 * Attempt with the provider's message.
 */
const THINKING: Partial<Record<ProviderKind, (thinking: 'on' | 'off', level?: ThinkingLevel) => Record<string, unknown>>> = {
  // Sent as is in the request body: the chat template switch of Qwen3 and alike on vLLM and SGLang,
  // and `reasoning_effort`, which servers without levels ignore.
  'openai-compatible': (thinking, level) => ({
    chat_template_kwargs: { enable_thinking: thinking === 'on' },
    ...(level && { reasoningEffort: level }),
  }),
  // Reasoning models always reason; `none` turns it off where the model allows it.
  openai: (thinking, level) => (thinking === 'off' ? { reasoningEffort: 'none' } : level ? { reasoningEffort: level } : {}),
  // Adaptive thinking with an effort level; older models that take a token budget refuse it.
  anthropic: (thinking, level) =>
    thinking === 'off' ? { thinking: { type: 'disabled' } } : { thinking: { type: 'adaptive' }, ...(level && { effort: level }) },
};

/** The model options a provider kind takes, by name: what the admin may set for its models. */
export function modelOptionsOf(kind: ProviderKind): (keyof ModelOptions)[] {
  return THINKING[kind] ? ['thinking', 'thinkingLevel'] : [];
}

/** Why a provider kind cannot take these options, or undefined when it can. */
export function unsupportedModelOptions(kind: ProviderKind, options: ModelOptions): string | undefined {
  if (options.thinkingLevel && options.thinking !== 'on') return 'thinkingLevel goes with thinking=on only';
  if (options.thinking && !THINKING[kind]) return `Provider kind ${kind} takes no thinking options`;
  return undefined;
}

/** The opencode model `options` for a provider kind; empty when the model has none set. */
export function opencodeModelOptions(kind: ProviderKind, options: ModelOptions | null | undefined): Record<string, unknown> {
  const thinking = options?.thinking && THINKING[kind];
  return thinking ? thinking(options.thinking!, options.thinkingLevel) : {};
}
