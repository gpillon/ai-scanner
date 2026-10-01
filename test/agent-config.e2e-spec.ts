import { LEAD_READABLE, opencodeConfig, REVIEWER_AGENT } from '../src/runner/agent-spec';

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
