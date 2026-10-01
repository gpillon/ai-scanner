import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { detectRunner, loadConfig } from '../src/config/app-config';
import { STORED_KEY_ENV } from '../src/runner/agent-spec';
import { KubeApi } from '../src/runner/kube-api';
import { agentImageFor, attemptPodName, K8S, KubernetesRunner } from '../src/runner/kubernetes-runner';
import { AttemptRequest } from '../src/runner/runner';
import { testConfig } from './harness';

const NS = 'scanner-ns';
const SERVER_POD = 'ai-scanner-7d9f-abcde';

/** How a fake agent pod goes: the statuses it shows in turn (the last repeats), and its log. */
interface PodScript {
  statuses: object[];
  log?: string;
}
const terminated = (exitCode: number) => ({
  phase: exitCode ? 'Failed' : 'Succeeded',
  containerStatuses: [{ name: 'agent', state: { terminated: { exitCode } } }],
});
const running = { phase: 'Running', containerStatuses: [{ name: 'agent', state: { running: {} } }] };

/**
 * Just enough of the Kubernetes API for the Runner: the server's own pod, its claim and
 * Services, and agent pods and Secrets, which it records.
 */
class FakeKube {
  server!: Server;
  readonly pods = new Map<string, any>();
  readonly secrets = new Map<string, any>();
  readonly created: { pods: any[]; secrets: any[] } = { pods: [], secrets: [] };
  readonly deleted: string[] = [];
  readonly patches: { path: string; body: any }[] = [];
  readonly tokens: (string | undefined)[] = [];
  script: PodScript = { statuses: [terminated(0)], log: 'agent log\n' };
  accessModes = ['ReadWriteOnce'];
  selfPod: any;
  private polls = new Map<string, number>();

  constructor(dataDir: string) {
    this.selfPod = {
      metadata: { name: SERVER_POD, uid: 'server-uid', labels: { [K8S.name]: 'ai-scanner', [K8S.component]: 'server', [K8S.instance]: 'scan-prod' } },
      spec: {
        nodeName: 'node-a',
        imagePullSecrets: [{ name: 'ghcr' }],
        securityContext: { fsGroup: 1000 },
        containers: [
          { name: 'server', image: 'ghcr.io/acme/ai-scanner:1.2.3', volumeMounts: [{ name: 'data', mountPath: dataDir }] },
          { name: 'egress-proxy', image: 'ghcr.io/acme/ai-scanner:1.2.3', volumeMounts: [{ name: 'data', mountPath: '/egress', subPath: 'egress', readOnly: true }] },
        ],
        volumes: [{ name: 'data', persistentVolumeClaim: { claimName: 'scanner-data' } }],
      },
    };
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((r) => this.server.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  stop(): Promise<void> {
    return new Promise((r) => this.server.close(() => r()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    this.tokens.push(req.headers.authorization);
    const url = new URL(req.url!, 'http://x');
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { 'content-type': typeof data === 'string' ? 'text/plain' : 'application/json' });
      res.end(typeof data === 'string' ? data : JSON.stringify(data));
    };
    const notFound = () => send(404, { kind: 'Status', reason: 'NotFound', message: 'not found' });
    const base = `/api/v1/namespaces/${NS}/`;
    if (!url.pathname.startsWith(base)) return send(403, { reason: 'Forbidden', message: 'wrong namespace' });
    const [kind, name, sub] = url.pathname.slice(base.length).split('/');
    const store = kind === 'pods' ? this.pods : kind === 'secrets' ? this.secrets : undefined;

    if (kind === 'pods' && name === SERVER_POD && req.method === 'GET') return send(200, this.selfPod);
    if (kind === 'persistentvolumeclaims' && req.method === 'GET') {
      return name === 'scanner-data' ? send(200, { status: { accessModes: this.accessModes } }) : notFound();
    }
    if (kind === 'services' && req.method === 'GET') {
      return send(200, {
        items: [
          { metadata: { name: 'other' }, spec: { selector: { app: 'other' }, ports: [{ name: 'egress', port: 3128 }] } },
          { metadata: { name: 'scan-prod-api' }, spec: { selector: { [K8S.instance]: 'scan-prod' }, ports: [{ name: 'http', port: 3000 }] } },
          { metadata: { name: 'scan-prod-egress' }, spec: { selector: { [K8S.instance]: 'scan-prod', [K8S.component]: 'server' }, ports: [{ name: 'egress', port: 3128 }] } },
        ],
      });
    }
    if (!store) return notFound();
    if (req.method === 'GET' && !name) {
      const selector = url.searchParams.get('labelSelector') ?? '';
      const [k, v] = selector.split('=');
      return send(200, { items: [...store.values()].filter((o) => o.metadata.labels?.[k] === v) });
    }
    if (req.method === 'POST') {
      const object = { ...body, metadata: { ...body.metadata, uid: `${body.metadata.name}-uid` } };
      store.set(body.metadata.name, object);
      this.created[kind as 'pods' | 'secrets'].push(body);
      return send(201, object);
    }
    if (req.method === 'DELETE') {
      if (!store.has(name)) return notFound();
      store.delete(name);
      this.deleted.push(`${kind}/${name}`);
      return send(200, { kind: 'Status', status: 'Success' });
    }
    if (req.method === 'PATCH') {
      if (!store.has(name)) return notFound();
      this.patches.push({ path: `${kind}/${name}`, body });
      return send(200, store.get(name));
    }
    if (kind === 'pods' && sub === 'log') return store.has(name) ? send(200, this.script.log ?? '') : notFound();
    if (kind === 'pods' && req.method === 'GET') {
      if (!store.has(name)) return notFound();
      const n = this.polls.get(name) ?? 0;
      this.polls.set(name, n + 1);
      const status = this.script.statuses[Math.min(n, this.script.statuses.length - 1)];
      return send(200, { ...store.get(name), status });
    }
    return notFound();
  }
}

describe('Kubernetes Runner', () => {
  let dataDir: string;
  let kube: FakeKube;
  let runner: KubernetesRunner;

  async function makeRunner(overrides: Partial<ReturnType<typeof testConfig>['kubernetes']> = {}) {
    const config = testConfig(dataDir, { runner: 'kubernetes' });
    config.kubernetes = { ...config.kubernetes, ...overrides };
    const url = await kube.start();
    runner = new KubernetesRunner(config, {
      connection: { api: new KubeApi({ server: url, token: async () => 'sa-token' }), namespace: NS },
      podName: SERVER_POD,
      pollMs: 5,
      uid: 1000610000,
      gid: 0,
    });
    return runner;
  }

  async function request(over: Partial<AttemptRequest> = {}): Promise<AttemptRequest> {
    const scanDir = join(dataDir, 'scans', 'My_Scan.ID');
    for (const d of ['workspace', 'output', 'attempts/1']) await mkdir(join(scanDir, d), { recursive: true });
    const skillsDir = join(dataDir, '..', `skills-${Date.now()}`);
    await mkdir(join(skillsDir, 'security-review'), { recursive: true });
    await writeFile(join(skillsDir, 'security-review', 'SKILL.md'), '# skill\n');
    return {
      scanId: 'My_Scan.ID',
      attempt: 1,
      workspaceDir: join(scanDir, 'workspace'),
      outputDir: join(scanDir, 'output'),
      transcriptPath: join(scanDir, 'attempts', '1', 'transcript.log'),
      prompt: 'Review the code.',
      profile: 'security',
      skillsDir,
      model: 'claude',
      agentModel: { provider: 'anthropic', builtIn: true, name: 'claude-x', apiKey: 'sk-secret-123' },
      egress: ['api.anthropic.com:443'],
      ...over,
    };
  }

  beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ai-scanner-k8s-'));
    kube = new FakeKube(dataDir);
  });
  afterEach(async () => {
    await kube.stop().catch(() => undefined);
    await rm(dataDir, { recursive: true, force: true });
  });

  it('runs the Attempt in a hardened pod set up from what it discovers', async () => {
    await makeRunner();
    const req = await request();
    expect(await runner.run(req)).toEqual({ exitCode: 0 });

    const [pod] = kube.created.pods;
    const spec = pod.spec;
    const agent = spec.containers[0];
    expect(pod.metadata.name).toBe(attemptPodName('My_Scan.ID', 1));
    expect(pod.metadata.name).toMatch(/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/);
    expect(pod.metadata.annotations[K8S.scanId]).toBe('My_Scan.ID');
    expect(pod.metadata.labels).toMatchObject({ [K8S.component]: 'agent', [K8S.managedBy]: 'scan-prod', [K8S.instance]: 'scan-prod' });
    expect(pod.metadata.ownerReferences).toEqual([{ apiVersion: 'v1', kind: 'Pod', name: SERVER_POD, uid: 'server-uid' }]);
    expect(spec).toMatchObject({
      restartPolicy: 'Never',
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      imagePullSecrets: [{ name: 'ghcr' }],
      securityContext: { runAsNonRoot: true, runAsUser: 1000610000, runAsGroup: 0, fsGroup: 1000, seccompProfile: { type: 'RuntimeDefault' } },
    });
    // A ReadWriteOnce claim: the agent runs on the server's node.
    expect(spec.affinity.nodeAffinity.requiredDuringSchedulingIgnoredDuringExecution.nodeSelectorTerms).toEqual([
      { matchFields: [{ key: 'metadata.name', operator: 'In', values: ['node-a'] }] },
    ]);
    expect(agent.image).toBe('ghcr.io/acme/ai-scanner-agent:1.2.3');
    expect(agent.securityContext).toEqual({ allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: ['ALL'] } });
    expect(agent.command.slice(0, 2)).toEqual(['opencode', 'run']);
    expect(agent.volumeMounts).toEqual(
      expect.arrayContaining([
        { name: 'data', mountPath: '/workspace', subPath: 'scans/My_Scan.ID/workspace', readOnly: true },
        { name: 'data', mountPath: '/output', subPath: 'scans/My_Scan.ID/output' },
        { name: 'data', mountPath: '/skills', subPath: 'scans/My_Scan.ID/agent-skills', readOnly: true },
      ]),
    );
    expect(spec.volumes[0]).toEqual({ name: 'data', persistentVolumeClaim: { claimName: 'scanner-data' } });
    const env = Object.fromEntries(agent.env.map((e: any) => [e.name, e.value]));
    expect(env.HTTPS_PROXY).toBe(`http://scan-prod-egress.${NS}.svc:3128`);

    // The key is in a Secret of its own, owned by the pod, and never in the pod spec.
    expect(JSON.stringify(pod)).not.toContain('sk-secret-123');
    expect(agent.envFrom).toEqual([{ secretRef: { name: `${pod.metadata.name}-env` } }]);
    expect(kube.created.secrets[0].stringData).toEqual({ [STORED_KEY_ENV]: 'sk-secret-123' });
    expect(kube.patches[0].body.metadata.ownerReferences[0]).toMatchObject({ kind: 'Pod', name: pod.metadata.name });

    // Skills copied onto the volume, the allow list written, the log kept, everything removed.
    expect(await readFile(join(dataDir, 'scans', 'My_Scan.ID', 'agent-skills', 'security-review', 'SKILL.md'), 'utf8')).toBe('# skill\n');
    expect(await readFile(join(dataDir, 'egress', 'allow.txt'), 'utf8')).toBe('api.anthropic.com:443\n');
    expect(await readFile(req.transcriptPath, 'utf8')).toBe('agent log\n');
    expect(kube.pods.size).toBe(0);
    expect(kube.secrets.size).toBe(0);
    expect(kube.tokens.every((t) => t === 'Bearer sa-token')).toBe(true);
  });

  it("mounts a Scan's own skills snapshot where it is, on the data volume", async () => {
    await makeRunner();
    const snapshot = join(dataDir, 'scans', 'My_Scan.ID', 'skills');
    await mkdir(join(snapshot, 'pack-skill'), { recursive: true });
    await runner.run(await request({ skillsDir: snapshot }));
    expect(kube.created.pods[0].spec.containers[0].volumeMounts).toContainEqual({
      name: 'data',
      mountPath: '/skills',
      subPath: 'scans/My_Scan.ID/skills',
      readOnly: true,
    });
  });

  it("lets agent pods run on any node when the claim is ReadWriteMany", async () => {
    kube.accessModes = ['ReadWriteMany'];
    await makeRunner();
    await runner.run(await request());
    expect(kube.created.pods[0].spec.affinity).toBeUndefined();
  });

  it('uses the configured image, proxy and ServiceAccount over what it would discover', async () => {
    await makeRunner({ agentImage: 'registry.local/agent:dev', egressProxy: 'http://proxy:3128', agentServiceAccount: 'scanner-agent' });
    await runner.run(await request({ agentModel: { provider: 'local', builtIn: false, name: 'qwen', baseUrl: 'http://llm:8000/v1' } }));
    const [pod] = kube.created.pods;
    expect(pod.spec.containers[0].image).toBe('registry.local/agent:dev');
    expect(pod.spec.serviceAccountName).toBe('scanner-agent');
    expect(pod.spec.containers[0].env).toContainEqual({ name: 'HTTPS_PROXY', value: 'http://proxy:3128' });
    // No key: no Secret.
    expect(kube.created.secrets).toEqual([]);
    expect(pod.spec.containers[0].envFrom).toBeUndefined();
  });

  it("returns the agent's exit code, after it ran", async () => {
    kube.script = { statuses: [{ phase: 'Pending' }, running, running, terminated(3)] };
    await makeRunner();
    expect(await runner.run(await request())).toEqual({ exitCode: 3 });
  });

  it.each([
    ['ImagePullBackOff', { phase: 'Pending', containerStatuses: [{ name: 'agent', state: { waiting: { reason: 'ImagePullBackOff', message: 'pull denied' } } }] }],
    ['CreateContainerConfigError', { phase: 'Pending', containerStatuses: [{ name: 'agent', state: { waiting: { reason: 'CreateContainerConfigError' } } }] }],
    ['DeadlineExceeded', { phase: 'Failed', reason: 'DeadlineExceeded', message: 'active deadline' }],
  ])('ends the Attempt at once on %s, removing the pod', async (reason, status) => {
    kube.script = { statuses: [status] };
    await makeRunner();
    await expect(runner.run(await request())).rejects.toThrow(reason);
    expect(kube.pods.size).toBe(0);
  });

  it('stops a running Attempt by deleting its pod', async () => {
    kube.script = { statuses: [running] };
    await makeRunner();
    const req = await request();
    const run = runner.run(req);
    await new Promise((r) => setTimeout(r, 100));
    await runner.stop(req.scanId);
    expect(await run).toEqual({ exitCode: 137 });
    expect(kube.pods.size).toBe(0);
  });

  it("removes this instance's leftover agent pods and Secrets at startup, and no other's", async () => {
    await makeRunner();
    const mine = { metadata: { name: 'ai-scanner-old-1', labels: { [K8S.managedBy]: 'scan-prod' } } };
    const theirs = { metadata: { name: 'ai-scanner-other-1', labels: { [K8S.managedBy]: 'scan-test' } } };
    kube.pods.set(mine.metadata.name, mine).set(theirs.metadata.name, theirs);
    kube.secrets.set('ai-scanner-old-1-env', { metadata: { name: 'ai-scanner-old-1-env', labels: { [K8S.managedBy]: 'scan-prod' } } });
    await runner.run(await request());
    expect(kube.deleted).toEqual(expect.arrayContaining(['pods/ai-scanner-old-1', 'secrets/ai-scanner-old-1-env']));
    expect(kube.pods.has('ai-scanner-other-1')).toBe(true);
  });

  it('refuses to start when no claim holds the data directory', async () => {
    kube.selfPod.spec.volumes = [{ name: 'data', emptyDir: {} }];
    await makeRunner();
    await expect(runner.run(await request())).rejects.toThrow(/SCANNER_K8S_DATA_CLAIM/);
    expect(kube.created.pods).toEqual([]);
  });
});

describe('Kubernetes Runner helpers', () => {
  it.each([
    ['ghcr.io/acme/ai-scanner:1.2.3', 'ghcr.io/acme/ai-scanner-agent:1.2.3'],
    ['ghcr.io/acme/ai-scanner', 'ghcr.io/acme/ai-scanner-agent'],
    ['localhost:5000/ai-scanner:dev', 'localhost:5000/ai-scanner-agent:dev'],
    ['ghcr.io/acme/ai-scanner@sha256:abc', undefined],
    ['ghcr.io/acme/something-else:1', undefined],
  ])('derives the agent image of %s', (server, agent) => {
    expect(agentImageFor(server)).toBe(agent);
  });

  it('names pods by a hash of the Scan id, so any id gives a valid name', () => {
    for (const id of ['UPPER_case.id', 'x'.repeat(200), 'a']) {
      expect(attemptPodName(id, 12)).toMatch(/^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/);
    }
    expect(attemptPodName('a', 1)).not.toBe(attemptPodName('A', 1));
  });

  it('picks the Kubernetes Runner inside a pod, Podman elsewhere, unless told', () => {
    const base = { SCANNER_TOKEN: 't', SCANNER_MODELS: '[{"id":"m","provider":"anthropic"}]' };
    expect(detectRunner({})).toBe('podman');
    expect(loadConfig(base).runner).toBe(detectRunner(process.env));
    expect(loadConfig({ ...base, SCANNER_RUNNER: 'auto' }).runner).toBe(detectRunner(process.env));
    expect(loadConfig({ ...base, SCANNER_RUNNER: 'kubernetes' }).runner).toBe('kubernetes');
    expect(() => loadConfig({ ...base, SCANNER_RUNNER: 'docker' })).toThrow(/auto or one of/);
  });
});
