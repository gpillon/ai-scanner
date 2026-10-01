/**
 * The kinds of Provider the Model Pool knows. opencode ships the built-in ones; any other
 * endpoint speaking the OpenAI API is `openai-compatible`, which opencode serves with the SDK it
 * bundles (anything else it would download at runtime, which the egress proxy forbids).
 */
export const PROVIDER_KINDS = ['anthropic', 'openai', 'google', 'mistral', 'groq', 'xai', 'openrouter', 'openai-compatible'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

export interface ProviderKindInfo {
  kind: ProviderKind;
  /** The API's base URL when the Provider gives none; `openai-compatible` always needs one. */
  defaultBaseUrl?: string;
  /** The environment variable opencode, and model discovery, read the key from by default. */
  apiKeyEnv?: string;
  /** How its model list is fetched. */
  discovery: 'openai' | 'anthropic' | 'google';
}

export const KIND_INFO: Record<ProviderKind, ProviderKindInfo> = {
  anthropic: { kind: 'anthropic', defaultBaseUrl: 'https://api.anthropic.com/v1', apiKeyEnv: 'ANTHROPIC_API_KEY', discovery: 'anthropic' },
  openai: { kind: 'openai', defaultBaseUrl: 'https://api.openai.com/v1', apiKeyEnv: 'OPENAI_API_KEY', discovery: 'openai' },
  google: {
    kind: 'google',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    apiKeyEnv: 'GOOGLE_GENERATIVE_AI_API_KEY',
    discovery: 'google',
  },
  mistral: { kind: 'mistral', defaultBaseUrl: 'https://api.mistral.ai/v1', apiKeyEnv: 'MISTRAL_API_KEY', discovery: 'openai' },
  groq: { kind: 'groq', defaultBaseUrl: 'https://api.groq.com/openai/v1', apiKeyEnv: 'GROQ_API_KEY', discovery: 'openai' },
  xai: { kind: 'xai', defaultBaseUrl: 'https://api.x.ai/v1', apiKeyEnv: 'XAI_API_KEY', discovery: 'openai' },
  openrouter: { kind: 'openrouter', defaultBaseUrl: 'https://openrouter.ai/api/v1', apiKeyEnv: 'OPENROUTER_API_KEY', discovery: 'openai' },
  'openai-compatible': { kind: 'openai-compatible', discovery: 'openai' },
};

export const isBuiltInKind = (name: string): name is Exclude<ProviderKind, 'openai-compatible'> =>
  name !== 'openai-compatible' && (PROVIDER_KINDS as readonly string[]).includes(name);

/** `host:port` of a URL, without the brackets of an IPv6 literal, as the egress proxy compares hosts. */
export function endpointOf(url: string): string {
  const u = new URL(url);
  return `${u.hostname.replace(/^\[|\]$/g, '')}:${u.port || (u.protocol === 'http:' ? 80 : 443)}`;
}
