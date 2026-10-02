import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { paths } from '../src/common/paths';
import { AppConfig, MINUTE_MS as MINUTE } from '../src/config/app-config';
import { egressEndpoint, ProfileRegistry } from '../src/profiles/profile-registry.service';
import { agentImageVariant } from '../src/runner/agent-spec';
import { AgentImageUnavailableError } from '../src/runner/runner';
import { Harness, makeZip, scripts, startApp, waitUntil } from './harness';

/**
 * A Scan Profile's Preparation (ADR-0015): a script of the profile the server runs once per Scan,
 * before any Attempt, whose output the agent reads in /prepared; and the endpoints a profile lets
 * its Scans reach besides the model.
 */
describe('Preparation', () => {
  let h: Harness | undefined;
  let profilesDir: string;

  /** A profile in `profilesDir`: `prepare` adds its `prepare/run.sh`. */
  async function profile(name: string, meta: object = {}, prepare = true): Promise<void> {
    const dir = join(profilesDir, name);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'profile.json'), JSON.stringify({ name, description: `${name} profile`, producesFindings: false, ...meta }));
    await writeFile(join(dir, 'prompt.md'), 'Read /prepared and write /output/report.md.\n');
    if (prepare) {
      await mkdir(join(dir, 'prepare'), { recursive: true });
      await writeFile(join(dir, 'prepare', 'run.sh'), 'echo prepared > "$SCANNER_PREPARED/data.txt"\n');
    }
  }

  beforeEach(async () => {
    profilesDir = await mkdtemp(join(tmpdir(), 'ai-scanner-profiles-'));
    await profile('prepared', { egressAllow: ['Packages.Example.org', 'mirror.example.net:8443'], prepareTimeoutMinutes: 5 });
    await profile('plain', { egressAllow: ['packages.example.org'] }, false);
  });
  afterEach(async () => {
    await h?.dispose();
    h = undefined;
    await rm(profilesDir, { recursive: true, force: true });
  });

  async function start(): Promise<Harness> {
    h = await startApp({ config: { profilesDir } });
    h.runner.script = scripts.writeReportOnly();
    return h;
  }

  /** The steps the Scan logged before Attempt 1, which its activity stream shows. */
  async function steps(id: string): Promise<string[]> {
    const log = await readFile(paths.warmupLog(h!.dataDir, id), 'utf8').catch(() => '');
    return log.split('\n').filter(Boolean).map((l) => JSON.parse(l).text);
  }

  it('runs once, before the first Attempt, on the workspace, and the agent then reads what it wrote', async () => {
    await start();
    const order: string[] = [];
    h!.runner.preparation = async (req) => {
      order.push('preparation');
      expect(await readFile(join(req.workspaceDir, 'app.txt'), 'utf8')).toBe('code\n');
      await writeFile(join(req.preparedDir, 'data.txt'), 'prepared\n');
    };
    h!.runner.script = scripts.perAttempt(
      async (req) => {
        order.push(`attempt ${req.attempt}`);
        expect(await readFile(join(req.preparedDir!, 'data.txt'), 'utf8')).toBe('prepared\n');
      },
      async (req, ctl) => {
        order.push(`attempt ${req.attempt}`);
        await scripts.writeReportOnly()(req, ctl);
      },
    );
    await h!.submit('s1', { profile: 'prepared' }, makeZip({ 'app.txt': 'code\n' })).expect(201);
    await h!.waitForState('s1', 'succeeded');

    // Once per Scan, not per Attempt.
    expect(order).toEqual(['preparation', 'attempt 1', 'attempt 2']);
    const [prep] = h!.runner.preparationCalls;
    expect(prep).toMatchObject({
      scanId: 's1',
      workspaceDir: paths.workspace(h!.dataDir, 's1'),
      preparedDir: paths.prepared(h!.dataDir, 's1'),
      scriptDir: join(profilesDir, 'prepared', 'prepare'),
      logPath: paths.preparationLog(h!.dataDir, 's1'),
      egress: ['packages.example.org:443', 'mirror.example.net:8443'],
      timeoutMs: 5 * MINUTE,
    });
    expect(h!.runner.calls.every((c) => c.preparedDir === prep.preparedDir)).toBe(true);
    expect(await steps('s1')).toEqual(['Preparing the code for the agent', 'Preparation done']);
    // Derived from the caller's code: gone with it once the Scan ends.
    expect(existsSync(prep.preparedDir)).toBe(false);
  });

  it("lets the Scan's proxy through to the profile's endpoints, besides the model's", async () => {
    await start();
    await h!.submit('s1', { profile: 'plain' }).expect(201);
    await h!.waitForState('s1', 'succeeded');
    const [attempt] = h!.runner.calls;
    // The model's endpoint, when the pool knows it, then the profile's.
    const ofProfile = attempt.modelEgress.filter((e) => !attempt.egress.includes(e));
    expect(ofProfile).toEqual(['packages.example.org:443']);
    // Without a Preparation, there is nothing to run, nor to read.
    expect(h!.runner.preparationCalls).toHaveLength(0);
    expect(attempt.preparedDir).toBeUndefined();
  });

  it('fails the Scan without any Attempt when the script fails, saying what it printed last', async () => {
    await start();
    h!.runner.preparation = async (req) => {
      await writeFile(req.logPath, 'reading app.war\nno deployment descriptor in app.war\n\n');
      return { exitCode: 3 };
    };
    await h!.submit('s1', { profile: 'prepared' }).expect(201);
    const status = await h!.waitForState('s1', 'failed');
    expect(status.failureReason).toBe('Preparation failed: it exited with code 3: no deployment descriptor in app.war');
    expect(status.attempts).toBe(0);
    expect(h!.runner.calls).toHaveLength(0);
    expect((await steps('s1')).at(-1)).toBe('Preparation failed: it exited with code 3: no deployment descriptor in app.war');
    expect(existsSync(paths.prepared(h!.dataDir, 's1'))).toBe(false);
  });

  it('fails the Scan when the Preparation cannot run', async () => {
    await start();
    h!.runner.preparation = async () => {
      throw new Error('Pod ai-scanner-x-prep cannot start: ErrImagePull');
    };
    await h!.submit('s1', { profile: 'prepared' }).expect(201);
    const status = await h!.waitForState('s1', 'failed');
    expect(status.failureReason).toMatch(/^Preparation failed: it could not run: Pod ai-scanner-x-prep cannot start: ErrImagePull/);
    expect(h!.runner.calls).toHaveLength(0);
  });

  it("stops the Preparation at its profile's timeout, and fails the Scan", async () => {
    await start();
    h!.runner.preparation = (_req, ctl) => ctl.stopped.then(() => ({ exitCode: 137 }));
    await h!.submit('s1', { profile: 'prepared' }).expect(201);
    await waitUntil(() => h!.runner.preparationCalls.length === 1, 'the Preparation');
    h!.clock.advance(5 * MINUTE);
    const status = await h!.waitForState('s1', 'failed');
    expect(status.failureReason).toBe('Preparation failed: it timed out after 5 min');
    expect(h!.runner.stopCalls).toEqual(['s1']);
    expect(h!.runner.calls).toHaveLength(0);
  });

  it('shows the Scan running, with no Attempt, while it prepares, and stops it when the Scan is deleted', async () => {
    await start();
    h!.runner.preparation = (_req, ctl) => ctl.stopped.then(() => ({ exitCode: 137 }));
    await h!.submit('s1', { profile: 'prepared' }).expect(201);
    await waitUntil(() => h!.runner.preparationCalls.length === 1, 'the Preparation');
    const status = (await h!.api.get('/api/scan/s1')).body;
    expect(status).toMatchObject({ state: 'running', attempts: 0 });
    await h!.api.delete('/api/scan/s1').expect(204);
    expect(h!.runner.stopCalls).toEqual(['s1']);
    expect(h!.runner.calls).toHaveLength(0);
  });

  it('prepares again a Scan a restart interrupted while preparing', async () => {
    await start();
    h!.runner.preparation = (_req, ctl) => ctl.stopped.then(() => ({ exitCode: 137 }));
    await h!.submit('s1', { profile: 'prepared' }).expect(201);
    await waitUntil(() => h!.runner.preparationCalls.length === 1, 'the Preparation');
    // Left behind by the interrupted one: the next Preparation starts from an empty directory.
    await writeFile(join(paths.prepared(h!.dataDir, 's1'), 'partial.txt'), 'half\n');
    await h!.close();

    h = await startApp({ dataDir: h!.dataDir, config: { profilesDir } });
    h.runner.script = scripts.writeReportOnly();
    h.runner.preparation = async (req) => {
      expect(existsSync(join(req.preparedDir, 'partial.txt'))).toBe(false);
    };
    await h.waitForState('s1', 'succeeded');
    expect(h.runner.preparationCalls).toHaveLength(1);
  });
});

/** A Scan Profile's agent image variant (ADR-0016). */
describe('Agent image variants', () => {
  let h: Harness | undefined;
  let profilesDir: string;

  beforeEach(async () => {
    profilesDir = await mkdtemp(join(tmpdir(), 'ai-scanner-profiles-'));
    const dir = join(profilesDir, 'tooled');
    await mkdir(join(dir, 'prepare'), { recursive: true });
    await writeFile(join(dir, 'profile.json'), JSON.stringify({ name: 'tooled', description: 'd', agentImage: 'full' }));
    await writeFile(join(dir, 'prompt.md'), 'p\n');
    await writeFile(join(dir, 'prepare', 'run.sh'), 'true\n');
    h = await startApp({ config: { profilesDir } });
    h.runner.script = scripts.writeReportOnly();
  });
  afterEach(async () => {
    await h?.dispose();
    h = undefined;
    await rm(profilesDir, { recursive: true, force: true });
  });

  it('runs the Preparation and every Attempt in the variant', async () => {
    h!.runner.script = scripts.perAttempt(scripts.writeNothing(), scripts.writeReportOnly());
    await h!.submit('s1', { profile: 'tooled' }).expect(201);
    await h!.waitForState('s1', 'succeeded');
    expect(h!.runner.preparationCalls.map((c) => c.imageVariant)).toEqual(['full']);
    expect(h!.runner.calls.map((c) => c.imageVariant)).toEqual(['full', 'full']);
  });

  it('fails the Scan at once, naming the image, when the Attempt cannot have it', async () => {
    h!.runner.script = async () => {
      throw new AgentImageUnavailableError('localhost/ai-scanner-agent-full:latest', 'podman pull exited with 125: image not known');
    };
    await h!.submit('s1', { profile: 'tooled' }).expect(201);
    const status = await h!.waitForState('s1', 'failed');
    expect(status.failureReason).toBe(
      'The agent image localhost/ai-scanner-agent-full:latest is not available: podman pull exited with 125: image not known',
    );
    // No other Attempt: it would fail the same way.
    expect(status.attempts).toBe(1);
  });

  it('fails the Scan before any Attempt when the Preparation cannot have it', async () => {
    h!.runner.preparation = async () => {
      throw new AgentImageUnavailableError('localhost/ai-scanner-agent-full:latest', 'image not known');
    };
    await h!.submit('s1', { profile: 'tooled' }).expect(201);
    const status = await h!.waitForState('s1', 'failed');
    expect(status.failureReason).toBe('Preparation failed: The agent image localhost/ai-scanner-agent-full:latest is not available: image not known');
    expect(h!.runner.calls).toHaveLength(0);
  });

  it("names the variant's image after the agent image's", () => {
    expect(agentImageVariant('localhost/ai-scanner-agent:latest', 'full')).toBe('localhost/ai-scanner-agent-full:latest');
    expect(agentImageVariant('registry.example.com:5000/team/ai-scanner-agent:1.2.3', 'full')).toBe(
      'registry.example.com:5000/team/ai-scanner-agent-full:1.2.3',
    );
    expect(agentImageVariant('ai-scanner-agent', 'full')).toBe('ai-scanner-agent-full');
    expect(agentImageVariant('localhost/ai-scanner-agent:latest')).toBe('localhost/ai-scanner-agent:latest');
    // A digest names one image: there is no telling its variant's.
    expect(agentImageVariant('ghcr.io/acme/ai-scanner-agent@sha256:abc', 'full')).toBeUndefined();
  });
});

describe('Scan Profile endpoints and Preparation settings', () => {
  it('takes a host name or host:port, as the egress proxy compares them', () => {
    expect(egressEndpoint('Packages.Example.org')).toBe('packages.example.org:443');
    expect(egressEndpoint(' mirror.example.net:8443 ')).toBe('mirror.example.net:8443');
    for (const bad of ['https://packages.example.org', 'host:0', 'host:70000', '-bad.example', 'a b', '', 42, '*.example.org']) {
      expect(() => egressEndpoint(bad)).toThrow(/is not a host name/);
    }
  });

  describe('refuses at start-up', () => {
    let profilesDir: string;
    beforeEach(async () => {
      profilesDir = await mkdtemp(join(tmpdir(), 'ai-scanner-profiles-'));
    });
    afterEach(() => rm(profilesDir, { recursive: true, force: true }));

    it.each<[string, object, boolean, RegExp]>([
      ['an endpoint that is not a host', { egressAllow: ['http://x.example'] }, false, /bad: egressAllow: "http:\/\/x.example" is not a host name/],
      ['endpoints not in a list', { egressAllow: 'x.example' }, false, /bad: egressAllow must be a list/],
      ['a Preparation timeout without a Preparation', { prepareTimeoutMinutes: 5 }, false, /bad: prepareTimeoutMinutes needs a prepare\/run.sh/],
      ['a Preparation timeout that is not positive', { prepareTimeoutMinutes: 0 }, true, /bad: prepareTimeoutMinutes must be a positive number/],
      ['an image reference for agentImage', { agentImage: 'ghcr.io/acme/tools:1' }, false, /bad: agentImage "ghcr.io\/acme\/tools:1" is not a variant name/],
      ['an agentImage in capitals', { agentImage: 'Full' }, false, /bad: agentImage "Full" is not a variant name/],
    ])('%s', async (_name, meta, prepare, error) => {
      const dir = join(profilesDir, 'bad');
      await mkdir(join(dir, 'prepare'), { recursive: true });
      await writeFile(join(dir, 'profile.json'), JSON.stringify({ name: 'bad', description: 'd', ...meta }));
      await writeFile(join(dir, 'prompt.md'), 'p\n');
      if (prepare) await writeFile(join(dir, 'prepare', 'run.sh'), 'true\n');
      expect(() => new ProfileRegistry({ profilesDir } as AppConfig)).toThrow(error);
    });
  });
});
