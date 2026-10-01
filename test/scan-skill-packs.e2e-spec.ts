import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '../src/common/paths';
import { Gate, Harness, makeZip, startApp } from './harness';

const skillMd = (name: string) => `---\nname: ${name}\ndescription: Checks ${name}.\n---\n\n# ${name}\n`;

describe('Scans with Skill Packs', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startApp();
    await h.admin
      .post('/api/admin/skills')
      .attach('file', makeZip({ 'java-sinks/SKILL.md': skillMd('java-sinks'), 'spring-security/SKILL.md': skillMd('spring-security'), 'go-sinks/SKILL.md': skillMd('go-sinks') }), 's.zip');
    await h.admin.post('/api/admin/skill-packs').send({ id: 'java', description: 'Java', skills: ['java-sinks', 'spring-security'] });
    await h.admin.post('/api/admin/skill-packs').send({ id: 'go', description: 'Go', skills: ['go-sinks'] });
  });
  afterEach(() => h.dispose());

  it('without packs, run with the Scan Profile skills as before', async () => {
    await h.submit('plain');
    await h.waitForState('plain', 'succeeded');
    expect(h.runner.calls[0].skillsDir).toMatch(/profiles[\\/]security[\\/]skills$/);
    expect((await h.api.get('/api/scan/plain')).body).not.toHaveProperty('skillPacks');
  });

  it("run with one skills directory: the profile's skills and the packs'", async () => {
    const res = await h.submit('packed', { profile: 'security', skillPacks: 'java,go' });
    expect(res.status).toBe(201);
    await h.waitForState('packed', 'succeeded');
    const [call] = h.runner.calls;
    expect(call.skillsDir).toBe(paths.scanSkills(h.dataDir, 'packed'));
    const names = (await readdir(call.skillsDir!)).sort();
    expect(names).toEqual(expect.arrayContaining(['security-review', 'java-sinks', 'spring-security', 'go-sinks']));
    expect(call.prompt).toContain('- `spring-security`: Checks spring-security.');
    expect(call.prompt).toContain('- `go-sinks`: Checks go-sinks.');

    const status = (await h.api.get('/api/scan/packed')).body;
    expect(status.skillPacks).toEqual([
      { id: 'java', skills: [{ name: 'java-sinks', hash: expect.stringMatching(/^[0-9a-f]{64}$/) }, { name: 'spring-security', hash: expect.any(String) }] },
      { id: 'go', skills: [{ name: 'go-sinks', hash: expect.any(String) }] },
    ]);
  });

  it('take packs as a repeated multipart field too', async () => {
    const res = await h.api.post('/api/scan/repeated').field('profile', 'security').field('skillPacks', 'java').field('skillPacks', 'go').attach('file', makeZip(), 'source.zip');
    expect(res.status).toBe(201);
    expect(res.body.skillPacks.map((p: any) => p.id)).toEqual(['java', 'go']);
  });

  it('refuse unknown packs before taking the Scan', async () => {
    const res = await h.submit('bad', { profile: 'security', skillPacks: 'java,cobol' });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Unknown Skill Pack\(s\): cobol/);
    expect((await h.api.get('/api/scan/bad')).status).toBe(404);
  });

  it('keep the skills copied at submission, whatever happens to the packs afterwards', async () => {
    const gate = new Gate();
    h.runner.script = gate.script();
    await h.submit('kept', { profile: 'security', skillPacks: 'go' });
    await h.waitForState('kept', 'running');
    await h.admin.delete('/api/admin/skill-packs/go');
    expect((await h.admin.delete('/api/admin/skills/go-sinks')).status).toBe(204);
    gate.release('kept');
    await h.waitForState('kept', 'succeeded');
    const dir = h.runner.calls[0].skillsDir!;
    expect(await readFile(join(dir, 'go-sinks', 'SKILL.md'), 'utf8')).toContain('# go-sinks');
  });

  it('lose their copy when deleted', async () => {
    await h.submit('gone', { profile: 'security', skillPacks: 'go' });
    await h.waitForState('gone', 'succeeded');
    expect(existsSync(paths.scanSkills(h.dataDir, 'gone'))).toBe(true);
    await h.api.delete('/api/scan/gone');
    expect(existsSync(paths.scanSkills(h.dataDir, 'gone'))).toBe(false);
  });
});
