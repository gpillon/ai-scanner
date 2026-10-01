import { LEAD_READABLE, opencodeConfig, REVIEWER_AGENT } from '../src/runner/agent-spec';
import { ModelOptions, opencodeModelOptions, unsupportedModelOptions } from '../src/models/model-options';
import { PROVIDER_KINDS, ProviderKind } from '../src/models/provider-kinds';

/** The opencode configuration an Attempt runs with (ADR-0011, ADR-0012). */
describe('Agent configuration', () => {
  type Config = { agent: Record<string, { permission: Record<string, any> }>; permission: Record<string, any> };
  const model = { provider: 'ignis', builtIn: false, name: 'qwen', baseUrl: 'http://llm:8000/v1' };
  // A Scan Profile with `leadReadsCode: false`, as the security profile.
  const config = opencodeConfig(model, true, false) as Config;
  const lead = config.agent.build.permission;
  const reviewer = config.agent[REVIEWER_AGENT].permission;

  it('lets the lead read only manifests, READMEs, the skills and its output, and never search', () => {
    expect(lead.grep).toBe('deny');
    expect(lead.read['*']).toBe('deny');
    for (const f of LEAD_READABLE) expect(lead.read[`*${f}`]).toBe('allow');
    // Relative to the worktree: `/` without a git repository, else /workspace.
    for (const p of ['skills/*', '../skills/*', 'output/*', '../output/*']) expect(lead.read[p]).toBe('allow');
  });

  it('lets reviewers read and search everything, and start nothing', () => {
    expect(reviewer).toMatchObject({ read: 'allow', grep: 'allow', glob: 'allow', list: 'allow', task: 'deny', edit: 'deny' });
  });

  it('leaves the lead free to read when the profile does not say otherwise', () => {
    const free = opencodeConfig(model, true) as Config;
    expect(free.agent.build).toBeUndefined();
    expect(free.permission.read).toBe('allow');
  });

  it('lets the lead start reviewers only', () => {
    expect(config.permission.task).toEqual({ '*': 'deny', [REVIEWER_AGENT]: 'allow' });
  });
});

/** A model's options reach opencode as the model's own options (ADR-0013). */
describe('Model options in the agent configuration', () => {
  type Providers = { provider: Record<string, { models?: Record<string, { options?: object; tool_call?: boolean }> }> };
  const thinkingOff = { chat_template_kwargs: { enable_thinking: false } };

  it('sets them on an OpenAI-compatible model, beside its tool calling', () => {
    const model = { provider: 'ignis', builtIn: false, name: 'qwen', baseUrl: 'http://llm:8000/v1', options: thinkingOff };
    const config = opencodeConfig(model, false) as Providers;
    expect(config.provider.ignis.models).toEqual({ qwen: { tool_call: true, options: thinkingOff } });
  });

  it("sets them on a built-in provider's model, which opencode merges with what it knows of it", () => {
    const options = { thinking: { type: 'adaptive' }, effort: 'low' };
    const config = opencodeConfig({ provider: 'anthropic', builtIn: true, name: 'claude-sonnet-5-5', options }, false) as Providers;
    expect(config.provider.anthropic.models).toEqual({ 'claude-sonnet-5-5': { options } });
  });

  it('adds nothing without them', () => {
    expect((opencodeConfig({ provider: 'anthropic', builtIn: true, name: 'm' }, false) as Providers).provider.anthropic.models).toBeUndefined();
    expect((opencodeConfig({ provider: 'ignis', builtIn: false, name: 'q' }, false) as Providers).provider.ignis.models).toEqual({ q: { tool_call: true } });
  });
});

describe('Model options per provider kind', () => {
  it.each([
    ['openai-compatible', { thinking: 'on' }, { chat_template_kwargs: { enable_thinking: true } }],
    ['openai-compatible', { thinking: 'on', thinkingLevel: 'low' }, { chat_template_kwargs: { enable_thinking: true }, reasoningEffort: 'low' }],
    ['openai-compatible', { thinking: 'off' }, { chat_template_kwargs: { enable_thinking: false } }],
    ['openai', { thinking: 'on' }, {}],
    ['openai', { thinking: 'on', thinkingLevel: 'medium' }, { reasoningEffort: 'medium' }],
    ['openai', { thinking: 'off' }, { reasoningEffort: 'none' }],
    ['anthropic', { thinking: 'on' }, { thinking: { type: 'adaptive' } }],
    ['anthropic', { thinking: 'on', thinkingLevel: 'high' }, { thinking: { type: 'adaptive' }, effort: 'high' }],
    ['anthropic', { thinking: 'on', thinkingLevel: 'xhigh' }, { thinking: { type: 'adaptive' }, effort: 'xhigh' }],
    ['anthropic', { thinking: 'on', thinkingLevel: 'max' }, { thinking: { type: 'adaptive' }, effort: 'max' }],
    ['openai', { thinking: 'on', thinkingLevel: 'xhigh' }, { reasoningEffort: 'xhigh' }],
    ['openai-compatible', { thinking: 'on', thinkingLevel: 'max' }, { chat_template_kwargs: { enable_thinking: true }, reasoningEffort: 'max' }],
    ['anthropic', { thinking: 'off' }, { thinking: { type: 'disabled' } }],
  ] as [ProviderKind, ModelOptions, object][])('%s, %j: %j', (kind, choice, sent) => {
    expect(unsupportedModelOptions(kind, choice)).toBeUndefined();
    expect(opencodeModelOptions(kind, choice)).toEqual(sent);
  });

  it('sends nothing when the model has none set', () => {
    for (const kind of PROVIDER_KINDS) expect(opencodeModelOptions(kind, null)).toEqual({});
  });

  it('refuses thinking for the kinds it has no mapping for', () => {
    for (const kind of ['google', 'mistral', 'groq', 'xai', 'openrouter'] as ProviderKind[]) {
      expect(unsupportedModelOptions(kind, { thinking: 'on' })).toMatch(kind);
    }
  });
});
