import { lstat, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { paths } from '../src/paths';
import { Harness, listFiles, makeZip, Script, scripts, startApp, waitUntil, ZipEntry } from './harness';

describe('Source Archive extraction', () => {
  let h: Harness;
  afterEach(() => h?.dispose());

  it('gives the agent the Source Archive contents as its workspace', async () => {
    h = await startApp();
    let seen = '';
    h.runner.script = async (req, ctl) => {
      seen = await readFile(join(req.workspaceDir, 'src', 'lib', 'db.js'), 'utf8');
      await scripts.writeReport()(req, ctl);
    };
    await h.submit('s1', { profile: 'security' }, makeZip({ 'README.md': '# app\n', 'src/lib/db.js': 'query(input)\n' }));
    await h.waitForState('s1', 'succeeded');
    expect(seen).toBe('query(input)\n');
  });

  it('extracts a symlink entry as a plain file holding its target', async () => {
    h = await startApp();
    let link = { isFile: false, text: '' };
    h.runner.script = async (req, ctl) => {
      const path = join(req.workspaceDir, 'passwd');
      link = { isFile: (await lstat(path)).isFile(), text: await readFile(path, 'utf8') };
      await scripts.writeReport()(req, ctl);
    };
    await h.submit('s1', { profile: 'security' }, makeZip({ passwd: { data: '/etc/passwd', symlink: true } }));
    await h.waitForState('s1', 'succeeded');
    expect(link).toEqual({ isFile: true, text: '/etc/passwd' });
  });

  describe('when the Scan ends', () => {
    const exists = (path: string) => stat(path).then(() => true, () => false);

    /** What is left on disk of the caller's code and of what is kept for debugging. */
    async function leftovers(id: string) {
      return {
        sourceArchive: await exists(paths.sourceArchive(h.dataDir, id)),
        workspace: await exists(paths.workspace(h.dataDir, id)),
        output: await exists(paths.output(h.dataDir, id)),
        transcript: await exists(paths.transcript(h.dataDir, id, 1)),
      };
    }

    it.each<[string, Script, string]>([
      ['succeeded', scripts.writeReport(), 'succeeded'],
      ['failed', scripts.writeReportOnly(), 'failed'],
    ])('removes the Source Archive and the workspace once it has %s, keeping the debug output', async (_n, script, state) => {
      h = await startApp();
      h.runner.script = script;
      await h.submit('s1');
      await h.waitForState('s1', state);
      expect(await leftovers('s1')).toEqual({ sourceArchive: false, workspace: false, output: true, transcript: true });
    });

    it('removes the Source Archive when it was invalid', async () => {
      h = await startApp();
      await h.submit('s1', { profile: 'security' }, makeZip({ '../evil.txt': 'pwned' }));
      await h.waitForState('s1', 'failed');
      expect(await leftovers('s1')).toMatchObject({ sourceArchive: false, workspace: false });
    });

    it('removes the Source Archive and the workspace of a Scan failed as interrupted by a restart', async () => {
      h = await startApp();
      h.runner.script = scripts.hang();
      await h.submit('s1');
      await waitUntil(() => h.runner.calls.length === 1, 'the first Attempt');
      await h.close();
      const restarted = await startApp({ dataDir: h.dataDir });
      try {
        expect((await restarted.waitForState('s1', 'failed')).failureReason).toMatch(/Interrupted/);
        expect(await leftovers('s1')).toEqual({ sourceArchive: false, workspace: false, output: true, transcript: true });
      } finally {
        await restarted.close();
      }
    });
  });

  describe('fails the Scan without running the agent when the Source Archive', () => {
    const zeros = (bytes: number) => '\0'.repeat(bytes);
    const smallFiles = (count: number, bytes: number) =>
      Object.fromEntries(Array.from({ length: count }, (_, i) => [`f${i}.txt`, zeros(bytes)]));

    it.each<[string, Record<string, string | ZipEntry> | Buffer]>([
      ['has an entry climbing out of the root', { 'ok.txt': 'fine', '../evil.txt': 'pwned' }],
      ['has an entry climbing out from a subdirectory', { 'src/../../evil.txt': 'pwned' }],
      ['has an absolute entry', { '/tmp/evil.txt': 'pwned' }],
      ['has an entry with a drive letter', { 'C:/evil.txt': 'pwned' }],
      ['has an entry with backslashes', { 'src\\..\\..\\evil.txt': 'pwned' }],
      ['has an entry naming an alternate data stream', { 'notes.txt:evil': 'pwned' }],
      ['has more entries than the limit', smallFiles(21, 1)],
      ['inflates past the size limit (zip bomb)', { 'bomb.bin': { data: zeros(1024 * 1024), deflate: true } }],
      ['adds up past the size limit over many files', smallFiles(10, 8 * 1024)],
      ['declares smaller sizes than it holds', { 'big.bin': { data: zeros(128 * 1024), deflate: true, declaredSize: 10 } }],
      ['is corrupt past its zip signature', Buffer.from('PK\x03\x04 then nothing a zip reader understands', 'latin1')],
    ])('%s', async (_name, contents) => {
      h = await startApp();
      const archive = Buffer.isBuffer(contents) ? contents : makeZip(contents);
      expect((await h.submit('s1', { profile: 'security' }, archive)).status).toBe(201);
      const status = await h.waitForState('s1', 'failed');
      expect(status.failureReason).toMatch(/^Invalid Source Archive: /);
      expect(h.runner.calls).toHaveLength(0);
      expect((await listFiles(h.dataDir)).filter((f) => /evil|pwned/.test(f))).toEqual([]);
    });
  });
});
