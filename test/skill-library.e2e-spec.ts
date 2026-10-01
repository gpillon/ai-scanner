import { existsSync } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '../src/common/paths';
import { Harness, makeZip, startApp } from './harness';

const skillMd = (name: string, description = `Does ${name} things.`) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nInstructions.\n`;

/** A zip of skill directories, as an admin uploads it. */
const skillsZip = (...names: string[]) =>
  makeZip(Object.fromEntries(names.flatMap((n) => [[`pack/${n}/SKILL.md`, skillMd(n)], [`pack/${n}/references/notes.md`, `notes of ${n}\n`]])));

describe('Skill Library and Skill Packs', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await startApp();
  });
  afterEach(() => h.dispose());

  const upload = (zip: Buffer, replace = false) =>
    h.admin.post('/api/admin/skills').field('replace', String(replace)).attach('file', zip, 'skills.zip');

  describe('importing a zip', () => {
    it('stores each skill directory, with its files', async () => {
      const res = await upload(skillsZip('java-sinks', 'spring-security'));
      expect(res.status).toBe(201);
      expect(res.body.imported.map((s: any) => [s.name, s.description, s.files, s.source])).toEqual([
        ['java-sinks', 'Does java-sinks things.', 2, 'upload:skills.zip'],
        ['spring-security', 'Does spring-security things.', 2, 'upload:skills.zip'],
      ]);
      const dir = join(paths.skills(h.dataDir), 'java-sinks');
      expect(await readFile(join(dir, 'references', 'notes.md'), 'utf8')).toBe('notes of java-sinks\n');
      expect((await h.admin.get('/api/admin/skills/java-sinks')).body.instructions).toContain('# java-sinks');
      // The import's scratch directory is gone.
      expect(await readdir(paths.skillImports(h.dataDir))).toEqual([]);
    });

    it('refuses what the library already has, unless replacing', async () => {
      await upload(skillsZip('java-sinks'));
      expect((await upload(skillsZip('java-sinks'))).status).toBe(409);
      const changed = makeZip({ 'java-sinks/SKILL.md': skillMd('java-sinks', 'Second version.') });
      const res = await upload(changed, true);
      expect(res.status).toBe(201);
      expect((await h.admin.get('/api/admin/skills')).body.map((s: any) => [s.name, s.description])).toEqual([['java-sinks', 'Second version.']]);
    });

    it.each([
      ['no skill at all', { 'readme.md': 'hi' }, /No skill found/],
      ['a name unlike its directory', { 'one/SKILL.md': skillMd('two') }, /differs from its directory/],
      ['a bad name', { 'Bad_Name/SKILL.md': skillMd('Bad_Name') }, /lowercase/],
      ['no description', { 'x/SKILL.md': '---\nname: x\n---\nbody\n' }, /no description/],
      ['no frontmatter', { 'x/SKILL.md': '# x\n' }, /frontmatter/],
      ['a Scan Profile skill', { 'security-review/SKILL.md': skillMd('security-review') }, /Scan Profile already brings/],
    ])('refuses %s', async (_what, entries, message) => {
      const res = await upload(makeZip(entries));
      expect(res.status).toBe(400);
      expect(res.body.message).toMatch(message);
      expect((await h.admin.get('/api/admin/skills')).body).toEqual([]);
    });

    it('keeps a symlink of the zip as a plain file holding its target', async () => {
      const res = await upload(makeZip({ 'x/SKILL.md': skillMd('x'), 'x/link': { data: '/etc/passwd', symlink: true } }));
      expect(res.status).toBe(201);
      const link = join(paths.skills(h.dataDir), 'x', 'link');
      expect((await lstat(link)).isFile()).toBe(true);
      expect(await readFile(link, 'utf8')).toBe('/etc/passwd');
    });

    it('needs the admin token', async () => {
      expect((await h.api.post('/api/admin/skills').attach('file', skillsZip('x'), 'x.zip')).status).toBe(403);
    });
  });

  describe('importing with the skills CLI', () => {
    jest.setTimeout(120_000);
    let source: string;
    beforeEach(async () => {
      source = await mkdtemp(join(tmpdir(), 'ai-scanner-skill-src-'));
      for (const name of ['go-sinks', 'go-crypto']) {
        await mkdir(join(source, name), { recursive: true });
        await writeFile(join(source, name, 'SKILL.md'), skillMd(name));
      }
    });
    afterEach(() => rm(source, { recursive: true, force: true }));

    it('runs `skills add` on a source and imports what it installed', async () => {
      const res = await h.admin.post('/api/admin/skills/install').send({ source });
      expect(res.status).toBe(201);
      expect(res.body.imported.map((s: any) => s.name).sort()).toEqual(['go-crypto', 'go-sinks']);
      expect(res.body.imported[0].source).toBe(source);
    });

    it('imports only the skills asked for', async () => {
      const res = await h.admin.post('/api/admin/skills/install').send({ source, skills: ['go-sinks'] });
      expect(res.body.imported.map((s: any) => s.name)).toEqual(['go-sinks']);
    });

    it('is a 502 when the CLI installs nothing', async () => {
      const res = await h.admin.post('/api/admin/skills/install').send({ source: join(source, 'missing') });
      expect(res.status).toBe(502);
    });

    it('refuses a source that looks like an option', async () => {
      expect((await h.admin.post('/api/admin/skills/install').send({ source: '--global' })).status).toBe(400);
    });
  });

  describe('Skill Packs', () => {
    beforeEach(async () => {
      await upload(skillsZip('java-sinks', 'spring-security', 'go-sinks'));
    });

    it('group library skills, and callers can list them', async () => {
      const created = await h.admin.post('/api/admin/skill-packs').send({ id: 'java', description: 'Java and Spring', skills: ['java-sinks', 'spring-security'] });
      expect(created.status).toBe(201);
      const listed = await h.api.get('/api/skill-packs');
      expect(listed.body).toEqual([
        {
          id: 'java',
          description: 'Java and Spring',
          skills: [
            { name: 'java-sinks', description: 'Does java-sinks things.' },
            { name: 'spring-security', description: 'Does spring-security things.' },
          ],
        },
      ]);
      expect((await h.admin.get('/api/admin/skills')).body.find((s: any) => s.name === 'java-sinks').packs).toEqual(['java']);
    });

    it('are validated', async () => {
      const post = (body: object) => h.admin.post('/api/admin/skill-packs').send(body);
      expect((await post({ id: 'Bad Id', description: '', skills: ['go-sinks'] })).status).toBe(400);
      expect((await post({ id: 'go', description: '', skills: [] })).status).toBe(400);
      expect((await post({ id: 'go', description: '', skills: ['nope'] })).body.message).toMatch(/Not in the Skill Library: nope/);
      expect((await post({ id: 'go', description: '', skills: ['go-sinks'] })).status).toBe(201);
      expect((await post({ id: 'go', description: '', skills: ['go-sinks'] })).status).toBe(409);
    });

    it('keep their skills in the library until they let go of them', async () => {
      await h.admin.post('/api/admin/skill-packs').send({ id: 'go', description: '', skills: ['go-sinks'] });
      expect((await h.admin.delete('/api/admin/skills/go-sinks')).status).toBe(409);
      await h.admin.patch('/api/admin/skill-packs/go').send({ skills: ['java-sinks'] });
      expect((await h.admin.delete('/api/admin/skills/go-sinks')).status).toBe(204);
      expect(existsSync(join(paths.skills(h.dataDir), 'go-sinks'))).toBe(false);
      expect((await h.admin.delete('/api/admin/skill-packs/go')).status).toBe(204);
      expect((await h.api.get('/api/skill-packs')).body).toEqual([]);
    });

    it('are managed with the admin token only', async () => {
      expect((await h.api.post('/api/admin/skill-packs').send({ id: 'go', description: '', skills: ['go-sinks'] })).status).toBe(403);
    });
  });
});
