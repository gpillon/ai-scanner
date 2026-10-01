import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { readdirSync } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { configureApp } from '../src/app.setup';
import { Clock, Timer } from '../src/common/clock';
import { AppConfig, loadConfig, MINUTE_MS } from '../src/config/app-config';
import { AttemptRequest, AttemptResult, Runner } from '../src/runner/runner';
import { RetentionSweeper } from '../src/scans/retention-sweeper.service';

export const TOKEN = 'test-token';
export const ADMIN_TOKEN = 'test-admin-token';

/** Time moves only on `advance`, which fires the timers that come due, earliest first. */
export class FakeClock extends Clock {
  private timers: { due: number; fire: () => void }[] = [];

  constructor(private current = new Date('2026-01-01T00:00:00.000Z')) {
    super();
  }
  now(): Date {
    return new Date(this.current);
  }
  timer(ms: number): Timer {
    let fire!: () => void;
    const elapsed = new Promise<void>((resolve) => (fire = resolve));
    const entry = { due: this.current.getTime() + ms, fire };
    this.timers.push(entry);
    return { elapsed, cancel: () => (this.timers = this.timers.filter((t) => t !== entry)) };
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
    const due = this.timers.filter((t) => t.due <= this.current.getTime()).sort((a, b) => a.due - b.due);
    this.timers = this.timers.filter((t) => !due.includes(t));
    for (const t of due) t.fire();
  }
}

export interface AttemptControl {
  /** Resolves when the supervisor stops this Attempt. */
  stopped: Promise<void>;
}
export type Script = (req: AttemptRequest, ctl: AttemptControl) => Promise<AttemptResult | void>;

/** The smallest findings.json the `security` profile's Report template accepts. */
export const NO_FINDINGS = { report: { summary: 'All good.' }, findings: [] };

export const SAMPLE_FINDINGS = {
  report: { summary: 'One high-severity Finding.' },
  findings: [
    {
      severity: 'high',
      title: 'SQL injection',
      description: 'User input reaches a raw query.',
      location: { file: 'src/db.js', line: 12 },
    },
    { severity: 'info', title: 'Outdated dependency', description: 'lodash 3', location: { file: 'package.json' } },
  ],
};

export const scripts = {
  writeReport:
    (content = '# Report\n\nAll good.\n', findings: unknown = NO_FINDINGS): Script =>
    async (req) => {
      await writeFile(join(req.outputDir, 'report.md'), content);
      await writeFile(join(req.outputDir, 'findings.json'), JSON.stringify(findings));
    },
  writeReportOnly:
    (content = '# Report\n\nAll good.\n'): Script =>
    async (req) =>
      writeFile(join(req.outputDir, 'report.md'), content),
  writeFindingsText:
    (text: string): Script =>
    async (req) =>
      writeFile(join(req.outputDir, 'findings.json'), text),
  writeNothing: (): Script => async () => undefined,
  writeEmptyReport: (): Script => async (req) => writeFile(join(req.outputDir, 'report.md'), ''),
  crash: (): Script => async () => {
    throw new Error('agent crashed');
  },
  /** Runs `then`, then exits with `exitCode`. */
  exit:
    (exitCode: number, then: Script = scripts.writeReport()): Script =>
    async (req, ctl) => {
      await then(req, ctl);
      return { exitCode };
    },
  hang: (): Script => (_req, ctl) => ctl.stopped,
  /** Attempt N runs the Nth script; the last one repeats. */
  perAttempt:
    (...list: Script[]): Script =>
    (req, ctl) =>
      list[Math.min(req.attempt, list.length) - 1](req, ctl),
};

/** Attempts that wait until the test lets their Scan finish, or the supervisor stops them. */
export class Gate {
  private readonly released = new Set<string>();
  private readonly waiting = new Map<string, () => void>();

  script(then: Script = scripts.writeReport()): Script {
    return async (req, ctl) => {
      const released = this.released.has(req.scanId)
        ? Promise.resolve(true)
        : new Promise<boolean>((resolve) => this.waiting.set(req.scanId, () => resolve(true)));
      if (await Promise.race([released, ctl.stopped.then(() => false)])) return then(req, ctl);
    };
  }

  /** Lets the Scan's Attempt finish, now or as soon as it starts. */
  release(scanId: string): void {
    this.released.add(scanId);
    this.waiting.get(scanId)?.();
  }
}

/** Scriptable stand-in for the agent: the only fake in the suite. */
export class FakeRunner extends Runner {
  script: Script = scripts.writeReport();
  readonly calls: AttemptRequest[] = [];
  readonly stopCalls: string[] = [];
  private readonly stops = new Map<string, () => void>();

  async run(req: AttemptRequest): Promise<AttemptResult> {
    this.calls.push(req);
    const stopped = new Promise<void>((resolve) => this.stops.set(req.scanId, resolve));
    await writeFile(req.transcriptPath, `transcript of ${req.scanId} Attempt ${req.attempt}\n`);
    return (await this.script(req, { stopped })) ?? { exitCode: 0 };
  }

  /** Scan ids in the order their first Attempt started. */
  started(): string[] {
    return this.calls.filter((c) => c.attempt === 1).map((c) => c.scanId);
  }

  async stop(scanId: string): Promise<void> {
    this.stopCalls.push(scanId);
    this.stops.get(scanId)?.();
  }
}

/** A zip entry with control over how it is encoded, for crafting hostile Source Archives. */
export interface ZipEntry {
  data: string | Buffer;
  /** Deflate the data instead of storing it. */
  deflate?: boolean;
  /** Uncompressed size written in the headers, instead of the real one. */
  declaredSize?: number;
  /** Marks the entry as a Unix symlink whose target is `data`. */
  symlink?: boolean;
}

/** A zip with the given entries; plain strings are stored uncompressed. */
/** The paths of every file under `dir`, recursively. */
export function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name));
}

export function makeZip(entries: Record<string, string | ZipEntry> = { 'src/index.js': 'console.log(1)\n' }): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, spec] of Object.entries(entries)) {
    const entry = typeof spec === 'string' ? { data: spec } : spec;
    const nameBuf = Buffer.from(name);
    const raw = Buffer.from(entry.data);
    const data = entry.deflate ? deflateRawSync(raw) : raw;
    const method = entry.deflate ? 8 : 0;
    const size = entry.declaredSize ?? raw.length;
    const crc = crc32(raw);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(entry.symlink ? (3 << 8) | 20 : 20, 4); // made by Unix, for the mode bits
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(method, 10);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(size, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
    if (entry.symlink) dir.writeUInt32LE((0o120777 << 16) >>> 0, 38);
    dir.writeUInt32LE(offset, 42);
    parts.push(local, nameBuf, data);
    central.push(dir, nameBuf);
    offset += local.length + nameBuf.length + data.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(entries).length, 8);
  end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, end]);
}

export interface Harness {
  app: INestApplication;
  /** Not wired into the app when it runs another Runner. */
  runner: FakeRunner;
  clock: FakeClock;
  dataDir: string;
  config: AppConfig;
  sweeper: RetentionSweeper;
  /** supertest agent already sending the bearer token. */
  api: ReturnType<typeof authed>;
  /** The same, with the admin token. */
  admin: ReturnType<typeof authed>;
  /** supertest against the app, no token. */
  anonymous: () => ReturnType<typeof request>;
  submit(id: string, fields?: Record<string, string>, archive?: Buffer | null, filename?: string): request.Test;
  waitForState(id: string, states: string | string[], timeoutMs?: number): Promise<any>;
  /** Downloads an Artifact as raw bytes. */
  download(id: string, name: string): Promise<{ status: number; contentType: string; body: Buffer }>;
  /** Stops the app but keeps the data directory (to test restarts). */
  close(): Promise<void>;
  /** Stops the app and removes the data directory. */
  dispose(): Promise<void>;
}

function authed(app: INestApplication, token = TOKEN) {
  const http = () => request(app.getHttpServer());
  const bearer = { Authorization: `Bearer ${token}` };
  return {
    get: (url: string) => http().get(url).set(bearer),
    post: (url: string) => http().post(url).set(bearer),
    patch: (url: string) => http().patch(url).set(bearer),
    delete: (url: string) => http().delete(url).set(bearer),
  };
}

export function testConfig(dataDir: string, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    token: TOKEN,
    adminToken: ADMIN_TOKEN,
    dataDir,
    profilesDir: resolve(__dirname, '..', 'profiles'),
    models: [
      { id: 'fast-model', provider: 'openai-compatible' },
      { id: 'deep-model', provider: 'anthropic' },
    ],
    defaultModel: 'fast-model',
    defaultLanguage: 'en',
    maxArchiveBytes: 1024 * 1024,
    maxExtractedBytes: 64 * 1024,
    maxExtractedFiles: 20,
    runner: 'fake',
    podman: loadConfig({ SCANNER_TOKEN: TOKEN, SCANNER_MODELS: '[{"id":"m","provider":"anthropic"}]' }).podman,
    maxInstructionsLength: 200,
    retentionDays: 365,
    sweepIntervalMs: 0,
    maxAttempts: 3,
    attemptTimeoutMs: 20 * MINUTE_MS,
    scanTimeoutMs: 60 * MINUTE_MS,
    concurrency: 2,
    ...overrides,
  };
}

export async function startApp(options: {
  dataDir?: string;
  /** `configured` runs the Runner the config selects instead of a FakeRunner. */
  runner?: Runner | 'configured';
  clock?: FakeClock;
  config?: Partial<AppConfig>;
} = {}): Promise<Harness> {
  const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), 'ai-scanner-')));
  const runner = options.runner instanceof FakeRunner ? options.runner : new FakeRunner();
  const override = options.runner === 'configured' ? undefined : (options.runner ?? runner);
  const clock = options.clock ?? new FakeClock();
  const config = testConfig(dataDir, options.config);
  const app = await NestFactory.create(AppModule.register(config, { runner: override, clock }), { logger: false });
  configureApp(app);
  await app.init();
  const api = authed(app);

  const harness: Harness = {
    app,
    runner,
    clock,
    dataDir,
    config,
    sweeper: app.get(RetentionSweeper),
    api,
    admin: authed(app, ADMIN_TOKEN),
    anonymous: () => request(app.getHttpServer()),
    submit(id, fields = { profile: 'security' }, archive = makeZip(), filename = 'source.zip') {
      const req = api.post(`/api/scan/${id}`);
      for (const [k, v] of Object.entries(fields)) req.field(k, v);
      if (archive) req.attach('file', archive, filename);
      return req;
    },
    async waitForState(id, states, timeoutMs = 2000) {
      const wanted = Array.isArray(states) ? states : [states];
      for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; ) {
        const res = await api.get(`/api/scan/${id}`);
        if (res.status === 200 && wanted.includes(res.body.state)) return res.body;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`Scan ${id} never reached ${wanted.join('|')}`);
    },
    async download(id, name) {
      const res = await api
        .get(`/api/scan/${id}/artifacts/${name}`)
        .buffer(true)
        .parse((stream, done) => {
          const chunks: Buffer[] = [];
          stream.on('data', (c: Buffer) => chunks.push(c));
          stream.on('end', () => done(null, Buffer.concat(chunks)));
        });
      return { status: res.status, contentType: res.headers['content-type'], body: res.body as Buffer };
    },
    close: () => app.close(),
    dispose: async () => {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
  return harness;
}

/** Polls until `condition` holds, every `intervalMs`: for progress no single request shows. */
export async function waitUntil(
  condition: () => boolean | Promise<boolean>,
  what = 'condition',
  timeoutMs = 3000,
  intervalMs = 10,
): Promise<void> {
  for (const deadline = Date.now() + timeoutMs; Date.now() < deadline; ) {
    if (await condition()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`Timed out waiting for ${what}`);
}

/** Lets the app's pending work run, before asserting that something did not happen. */
export const settle = (ms = 50) => new Promise((r) => setTimeout(r, ms));

/** All file paths under a directory, relative. */
export async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  return entries.map(String);
}

/** Paths under a directory that belong to the Scan: one of their segments is its id. */
export async function filesOf(dir: string, scanId: string): Promise<string[]> {
  return (await listFiles(dir)).filter((f) => f.split(/[\\/]/).includes(scanId));
}
