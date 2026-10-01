/**
 * The `security` Scan Profile as shipped in `profiles/security` (ADR-0004): its skills must be
 * loadable by opencode, complete, and named by the prompt that relies on them.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { filesUnder, Harness, startApp } from './harness';

const profileDir = resolve(__dirname, '..', 'profiles', 'security');
const skillsDir = join(profileDir, 'skills');
const skills = readdirSync(skillsDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);
const prompt = readFileSync(join(profileDir, 'prompt.md'), 'utf8');

/** The frontmatter fields of a SKILL.md, as opencode reads them. */
function frontmatter(skillMd: string): Record<string, string> {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(skillMd);
  if (!block) return {};
  const fields: Record<string, string> = {};
  for (const line of block[1].split(/\r?\n/)) {
    const field = /^([a-z-]+):\s*(.*)$/.exec(line);
    if (field) fields[field[1]] = field[2].replace(/^(['"])(.*)\1$/, '$2');
  }
  return fields;
}

describe('the security Scan Profile', () => {
  it('brings its four skills', () => {
    expect(skills.sort()).toEqual(['insecure-defaults', 'security-review', 'sharp-edges', 'vulnerability-triage-brocards']);
  });

  describe.each(skills)('skill %s', (skill) => {
    const skillMd = join(skillsDir, skill, 'SKILL.md');

    it('has a SKILL.md opencode accepts: a name matching its directory and a description', () => {
      const meta = frontmatter(readFileSync(skillMd, 'utf8'));
      expect(meta.name).toBe(skill);
      expect(meta.name).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
      expect(meta.description).not.toMatch(/^[>|]/); // a YAML block scalar: keep it on one line
      expect(meta.description?.length).toBeGreaterThan(0);
      expect(meta.description.length).toBeLessThanOrEqual(1024);
    });

    it('links only to files it ships', () => {
      const missing: string[] = [];
      for (const file of filesUnder(join(skillsDir, skill)).filter((f) => f.endsWith('.md'))) {
        for (const [, target] of readFileSync(file, 'utf8').matchAll(/\]\(([^)#\s]+)(?:#[^)]*)?\)/g)) {
          if (/^[a-z]+:/i.test(target)) continue;
          if (!existsSync(join(dirname(file), target))) missing.push(`${file} -> ${target}`);
        }
      }
      expect(missing).toEqual([]);
    });

    it('carries the license it is distributed under', () => {
      expect(existsSync(join(skillsDir, skill, 'LICENSE'))).toBe(true);
    });

    it('is named by the prompt, which asks the agent to load it', () => {
      expect(prompt).toContain(`\`${skill}\``);
    });
  });

  it('keeps its lead to coordinating reviewers (ADR-0012)', () => {
    expect(JSON.parse(readFileSync(join(profileDir, 'profile.json'), 'utf8')).leadReadsCode).toBe(false);
  });

  it('tells the agent the one output file the supervisor validates, and that the server writes the Report', () => {
    expect(prompt).toContain('`/output/findings.json`');
    expect(prompt).toContain('do not write `report.md`');
  });

  it('has a Report template the server fills', () => {
    for (const file of ['schema.json', 'report.md.hbs', 'report.typ', 'fonts/Inter_400Regular.ttf', 'fonts/JetBrainsMono_400Regular.ttf']) {
      expect(existsSync(join(skillsDir, '..', 'report', file))).toBe(true);
    }
  });

  describe('GET /api/profiles', () => {
    let h: Harness;
    beforeAll(async () => {
      h = await startApp();
    });
    afterAll(() => h.dispose());

    it('describes it as a security review producing Findings', async () => {
      const security = (await h.api.get('/api/profiles')).body.find((p: { name: string }) => p.name === 'security');
      expect(security).toEqual({ name: 'security', description: expect.stringMatching(/security/i), producesFindings: true });
    });
  });
});
