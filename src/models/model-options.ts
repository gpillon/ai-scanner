import type { ProviderKind } from './provider-kinds';

/** Thinking levels a Scan may ask for: the ones every supported provider kind understands. */
export const THINKING_LEVELS = ['low', 'medium', 'high'] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/**
 * How a Scan asks its model to run, over the model's own defaults (ADR-0013). Each field is
 * optional: one left out is the model's own behaviour, and nothing is sent for it.
 */
export interface ModelOptions {
  /** Whether the model reasons before answering. */
  thinking?: 'on' | 'off';
  /** With `thinking: 'on'`: how much. Without it, the model's own level. */
  thinkingLevel?: ThinkingLevel;
}

/**
 * What each provider kind is sent for a thinking choice, as opencode model `options` (which it
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

/** The model options a provider kind takes, by name: what `GET /api/models` lists for its models. */
export function modelOptionsOf(kind: ProviderKind): (keyof ModelOptions)[] {
  return THINKING[kind] ? ['thinking', 'thinkingLevel'] : [];
}

/** Why a provider kind cannot take these options, or undefined when it can. */
export function unsupportedModelOptions(kind: ProviderKind, options: ModelOptions): string | undefined {
  if (options.thinkingLevel && options.thinking !== 'on') return 'thinkingLevel goes with thinking=on only';
  if (options.thinking && !THINKING[kind]) return `Provider kind ${kind} takes no thinking options`;
  return undefined;
}

/** The opencode model `options` for a provider kind; empty when the Scan chose nothing. */
export function opencodeModelOptions(kind: ProviderKind, options: ModelOptions | null | undefined): Record<string, unknown> {
  const thinking = options?.thinking && THINKING[kind];
  return thinking ? thinking(options.thinking!, options.thinkingLevel) : {};
}
