import { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { crc32 } from 'node:zlib';
import request from 'supertest';
import { AppModule, configureApp } from '../src/app.module';
import { Clock } from '../src/clock';
import { AppConfig } from '../src/config';
import { AttemptRequest, AttemptResult, Runner } from '../src/runner';
import { RetentionSweeper } from '../src/retention-sweeper';
import { writeFile } from 'node:fs/promises';

export const TOKEN = 'test-token';

export class FakeClock extends Clock {
  constructor(private current = new Date('2026-01-01T00:00:00.000Z')) {
    super();
  }
  now(): Date {
    return new Date(this.current);
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
}

export interface AttemptControl {
  /** Resolves when the supervisor stops this Attempt. */
  stopped: Promise<void>;
}
export type Script = (req: AttemptRequest, ctl: AttemptControl) => Promise<AttemptResult | void>;

export const scripts = {
  writeReport:
    (content = '# Report\n\nAll good.\n'): Script =>
    async (req) => {
      await writeFile(join(req.outputDir, 'report.md'), content);
      await writeFile(join(req.outputDir, 'findings.json'), '{"findings":[]}');
    },
  writeNothing: (): Script => async () => undefined,
  writeEmptyReport: (): Script => async (req) => writeFile(join(req.outputDir, 'report.md'), ''),
  crash: (): Script => async () => {
    throw new Error('agent crashed');
  },
  hang: (): Script => (_req, ctl) => ctl.stopped,
};

/** Scriptable stand-in for the agent: the only fake in the suite. */
export class FakeRunner extends Runner {
  script: Script = scripts.writeReport();
  readonly calls: AttemptRequest[] = [];
  readonly stopCalls: string[] = [];
  private readonly stops = new Map<string, () => void>();

  async run(req: AttemptRequest): Promise<AttemptResult> {
    this.calls.push(req);
    const stopped = new Promise<void>((resolve) => this.stops.set(req.scanId, resolve));
    return (await this.script(req, { stopped })) ?? { exitCode: 0 };
  }

  async stop(scanId: string): Promise<void> {
    this.stopCalls.push(scanId);
    this.stops.get(scanId)?.();
  }
}

/** A stored (uncompressed) zip with the given entries. */
export function makeZip(entries: Record<string, string> = { 'src/index.js': 'console.log(1)\n' }): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const nameBuf = Buffer.from(name);
    const data = Buffer.from(text);
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(data.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(nameBuf.length, 28);
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
  runner: FakeRunner;
  clock: FakeClock;
  dataDir: string;
  config: AppConfig;
  sweeper: RetentionSweeper;
  /** supertest agent already sending the bearer token. */
  api: ReturnType<typeof authed>;
  /** supertest against the app, no token. */
  anonymous: () => ReturnType<typeof request>;
  submit(id: string, fields?: Record<string, string>, archive?: Buffer | null, filename?: string): request.Test;
  waitForState(id: string, states: string | string[]): Promise<any>;
  /** Stops the app but keeps the data directory (to test restarts). */
  close(): Promise<void>;
  /** Stops the app and removes the data directory. */
  dispose(): Promise<void>;
}

function authed(app: INestApplication) {
  const http = () => request(app.getHttpServer());
  const bearer = { Authorization: `Bearer ${TOKEN}` };
  return {
    get: (url: string) => http().get(url).set(bearer),
    post: (url: string) => http().post(url).set(bearer),
    delete: (url: string) => http().delete(url).set(bearer),
  };
}

export function testConfig(dataDir: string, overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    token: TOKEN,
    dataDir,
    profilesDir: resolve(__dirname, '..', 'profiles'),
    models: [
      { id: 'fast-model', provider: 'openai-compatible' },
      { id: 'deep-model', provider: 'anthropic' },
    ],
    defaultModel: 'fast-model',
    defaultLanguage: 'en',
    maxArchiveBytes: 1024 * 1024,
    maxInstructionsLength: 200,
    retentionDays: 365,
    sweepIntervalMs: 0,
    ...overrides,
  };
}

export async function startApp(options: {
  dataDir?: string;
  runner?: FakeRunner;
  clock?: FakeClock;
  config?: Partial<AppConfig>;
} = {}): Promise<Harness> {
  const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), 'ai-scanner-')));
  const runner = options.runner ?? new FakeRunner();
  const clock = options.clock ?? new FakeClock();
  const config = testConfig(dataDir, options.config);
  const app = await NestFactory.create(AppModule.register(config, { runner, clock }), { logger: false });
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
    anonymous: () => request(app.getHttpServer()),
    submit(id, fields = { profile: 'security' }, archive = makeZip(), filename = 'source.zip') {
      const req = api.post(`/api/scan/${id}`);
      for (const [k, v] of Object.entries(fields)) req.field(k, v);
      if (archive) req.attach('file', archive, filename);
      return req;
    },
    async waitForState(id, states) {
      const wanted = Array.isArray(states) ? states : [states];
      for (let i = 0; i < 200; i++) {
        const res = await api.get(`/api/scan/${id}`);
        if (res.status === 200 && wanted.includes(res.body.state)) return res.body;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error(`Scan ${id} never reached ${wanted.join('|')}`);
    },
    close: () => app.close(),
    dispose: async () => {
      await app.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
  return harness;
}

/** All file paths under a directory, relative. */
export async function listFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true });
  return entries.map(String);
}
