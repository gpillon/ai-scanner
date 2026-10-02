import { Logger, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { createWriteStream, WriteStream } from 'node:fs';
import { cp, rm, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { AppConfig, KubernetesConfig } from '../config/app-config';
import { agentCommand, agentEnv, agentSecrets, IN_CONTAINER, PREPARATION_COMMAND, preparationEnv, variantImageOrThrow } from './agent-spec';
import { inClusterConnection, KubeApi, KubeApiError } from './kube-api';
import { AgentImageUnavailableError, AttemptRequest, AttemptResult, PreparationRequest, Runner } from './runner';

/** Labels and annotations the Runner puts on what it creates. */
export const K8S = {
  name: 'app.kubernetes.io/name',
  component: 'app.kubernetes.io/component',
  instance: 'app.kubernetes.io/instance',
  managedBy: 'ai-scanner.io/managed-by',
  scan: 'ai-scanner.io/scan',
  /** The Attempt's agent pod name, on everything belonging to that Attempt. */
  attemptPod: 'ai-scanner.io/attempt-pod',
  scanId: 'ai-scanner.io/scan-id',
  attempt: 'ai-scanner.io/attempt',
};

/** Where the egress proxy listens, in its pod. */
const PROXY_PORT = 3128;
/** The egress proxy script, as the server image ships it. */
const PROXY_COMMAND = ['node', '/app/containers/egress-proxy/proxy.js'];
/** Waiting reasons that never resolve on their own: the Attempt ends now, not at its timeout. */
const FATAL_WAITING = new Set(['ErrImagePull', 'ImagePullBackOff', 'InvalidImageName', 'CreateContainerConfigError', 'CreateContainerError']);
/** Of those, the ones that say the image cannot be had: every Attempt would fail alike. */
const IMAGE_WAITING = new Set(['ErrImagePull', 'ImagePullBackOff', 'InvalidImageName']);
/** How long a pod may stay unschedulable (a cluster autoscaler may still add a node). */
const UNSCHEDULABLE_GRACE_MS = 3 * 60_000;
/** How long the egress proxy may take to be ready. */
const PROXY_READY_TIMEOUT_MS = 3 * 60_000;

/** What the Runner learns once, from its own pod and the namespace. */
export interface KubernetesEnvironment {
  namespace: string;
  /** Agent pods are owned by the server pod, so the cluster removes them along with it. */
  owner?: { name: string; uid: string };
  /** Value of the `managed-by` label: agent pods of other ai-scanner instances are left alone. */
  instance: string;
  agentImage: string;
  /** Runs the egress proxy: the server's own image, which ships it. */
  proxyImage: string;
  dataClaim: string;
  /** Where the claim is mounted in the server, and the subPath it is mounted from. */
  dataMount: { path: string; subPath: string };
  /** The node agent pods must run on, when they share a ReadWriteOnce claim with the server. */
  node?: string;
  imagePullSecrets: { name: string }[];
  fsGroup?: number;
}

interface PodStatus {
  metadata: { name: string; uid: string };
  status?: {
    phase?: string;
    reason?: string;
    message?: string;
    podIP?: string;
    conditions?: { type: string; status: string; reason?: string; message?: string }[];
    containerStatuses?: {
      name: string;
      ready?: boolean;
      state?: { waiting?: { reason?: string; message?: string }; terminated?: { exitCode: number; reason?: string } };
    }[];
  };
}

interface RunningAttempt {
  pod: string;
  stopped: boolean;
}

/** What one pod of the Runner does for a Scan: an Attempt, or the Scan's Preparation. */
interface PodJob {
  scanId: string;
  /** Annotated on everything it creates: the Attempt's number, or `preparation`. */
  attempt: string;
  timeoutMs: number;
  /** The `host:port` endpoints its egress proxy lets through. */
  allow: string[];
}

/** What a pod of the Runner needs once the Runner knows its environment. */
interface PodSetup {
  /** Its secret environment: in a Secret of its own, owned by the pod. */
  secrets: Record<string, string>;
  /** The image it runs: the agent image, or the profile's variant of it (ADR-0016). */
  image: string;
  manifest: (proxyUrl: string, secretName?: string) => object;
}

/** A DNS-1123 name for an Attempt's pod: Scan ids are the caller's (ADR-0002), so they are hashed. */
export function attemptPodName(scanId: string, attempt: number): string {
  return `ai-scanner-${scanHash(scanId)}-${attempt}`;
}

/** The name of a Scan's Preparation pod (ADR-0015). */
export function preparationPodName(scanId: string): string {
  return `ai-scanner-${scanHash(scanId)}-prep`;
}

/** The container of a Preparation pod: its log is the Preparation's. */
const PREPARATION_CONTAINER = 'preparation';

function scanHash(scanId: string): string {
  return createHash('sha256').update(scanId).digest('hex').slice(0, 12);
}

/** `registry/org/ai-scanner:tag` gives `registry/org/ai-scanner-agent:tag`; a digest gives nothing. */
export function agentImageFor(serverImage: string): string | undefined {
  if (serverImage.includes('@')) return undefined;
  const slash = serverImage.lastIndexOf('/');
  const colon = serverImage.indexOf(':', slash + 1);
  const repo = colon < 0 ? serverImage : serverImage.slice(0, colon);
  const tag = colon < 0 ? '' : serverImage.slice(colon);
  return repo.endsWith('/ai-scanner') || repo === 'ai-scanner' ? `${repo}-agent${tag}` : undefined;
}

/**
 * Runs each Attempt as opencode in its own pod, in the namespace the server runs in (ADR-0007).
 *
 * The agent pod mounts the server's data claim: the workspace and skills read-only, /output
 * writable. It has a read-only root filesystem, no capabilities, no ServiceAccount token and no
 * service links, and runs as the server's user, so both can read what the other writes. The
 * model's key goes into a Secret of the Attempt.
 *
 * Each Attempt also gets its own egress proxy pod, which lets through only the Scan's model
 * endpoint, fixed at start. Two NetworkPolicies of the Attempt let the agent reach only that
 * proxy, and let only that agent reach it; the chart's policies deny everything else to agent
 * and proxy pods. The agent reaches the proxy by IP, so it needs no DNS either.
 *
 * A Scan's Preparation runs the same way, in a pod of the agent image labelled as an agent, so
 * the same policies hold it: its script for command, /prepared writable, no Secret, and a proxy
 * letting through only its profile's endpoints (ADR-0015).
 */
export class KubernetesRunner extends Runner implements OnModuleInit {
  private readonly log = new Logger(KubernetesRunner.name);
  private readonly k8s: KubernetesConfig;
  private readonly dataDir: string;
  private readonly running = new Map<string, RunningAttempt>();
  private ready?: Promise<KubernetesEnvironment>;
  private api?: KubeApi;

  constructor(
    private readonly config: AppConfig,
    private readonly options: {
      /** The API and namespace to use instead of the pod's own ServiceAccount. */
      connection?: { api: KubeApi; namespace: string };
      /** The server's pod name, instead of POD_NAME or HOSTNAME. */
      podName?: string;
      pollMs?: number;
      uid?: number;
      gid?: number;
    } = {},
  ) {
    super();
    this.k8s = config.kubernetes;
    this.dataDir = resolve(config.dataDir);
  }

  /** Discovers right away: a misconfiguration shows at startup, and pods a crashed server left behind go now. */
  onModuleInit(): void {
    this.prepared().catch((e) => this.log.error(`Could not prepare the Kubernetes Runner: ${e.message}`));
  }

  async run(request: AttemptRequest): Promise<AttemptResult> {
    const name = attemptPodName(request.scanId, request.attempt);
    const job = { scanId: request.scanId, attempt: String(request.attempt), timeoutMs: request.attemptTimeoutMs, allow: request.modelEgress };
    return this.launch(job, name, 'agent', request.transcriptPath, async (env) => {
      const skills = request.skillsDir && (await this.onVolume(env, request.skillsDir, request.workspaceDir, 'agent-skills'));
      return {
        secrets: agentSecrets(request.agentModel, this.k8s.agentEnv, (m) => this.log.warn(m)),
        image: variantImageOrThrow(env.agentImage, request.imageVariant),
        manifest: (proxyUrl, secretName) => this.podManifest(env, name, request, proxyUrl, skills, secretName),
      };
    });
  }

  async runPreparation(request: PreparationRequest): Promise<AttemptResult> {
    const name = preparationPodName(request.scanId);
    const job = { scanId: request.scanId, attempt: 'preparation', timeoutMs: request.timeoutMs, allow: request.egress };
    return this.launch(job, name, PREPARATION_CONTAINER, request.logPath, async (env) => {
      const scriptDir = await this.onVolume(env, request.scriptDir, request.workspaceDir, 'prepare-script');
      return {
        secrets: {},
        image: variantImageOrThrow(env.agentImage, request.imageVariant),
        manifest: (proxyUrl) => this.preparationPodManifest(env, name, job, request, proxyUrl, scriptDir),
      };
    });
  }

  /**
   * Runs one pod (`name`, whose `container` it waits for) behind an egress proxy pod of its own
   * that lets through `job.allow` only, under NetworkPolicies of its own; its log goes to
   * `logPath`. Everything it created goes once it exits.
   */
  private async launch(
    job: PodJob,
    name: string,
    container: string,
    logPath: string,
    setup: (env: KubernetesEnvironment) => Promise<PodSetup>,
  ): Promise<AttemptResult> {
    const attempt: RunningAttempt = { pod: name, stopped: false };
    this.running.set(job.scanId, attempt); // before any await: see Runner.stop
    const env = await this.prepared().catch((e) => {
      this.running.delete(job.scanId);
      throw e;
    });
    const api = this.api!;
    const ns = `/api/v1/namespaces/${env.namespace}`;
    const policies = `/apis/networking.k8s.io/v1/namespaces/${env.namespace}/networkpolicies`;
    const proxy = `${attempt.pod}-proxy`;
    const secretName = `${attempt.pod}-env`;
    try {
      // Leftovers of the same Attempt, should a previous server have died mid-way.
      await this.removeAttempt(api, env, attempt.pod);
      const { secrets, image, manifest } = await setup(env);
      const withSecret = Object.keys(secrets).length > 0;

      // The policies first: the proxy and the agent never run unconfined, not even briefly.
      for (const policy of this.networkPolicies(env, job, attempt.pod)) await api.post(policies, policy);
      await api.post(`${ns}/pods`, this.proxyManifest(env, job, proxy, attempt.pod));
      const proxyIp = await this.waitForProxy(api, `${ns}/pods/${proxy}`, attempt);
      if (proxyIp === undefined) return { exitCode: 137 };

      if (withSecret) await api.post(`${ns}/secrets`, this.secretManifest(env, secretName, job, attempt.pod, secrets));
      if (attempt.stopped) return { exitCode: 137 };
      const pod = await api.post<PodStatus>(`${ns}/pods`, manifest(`http://${proxyIp}:${PROXY_PORT}`, withSecret ? secretName : undefined));
      if (withSecret) {
        // The Secret now goes away with the pod, whatever happens to this process.
        await api.patch(`${ns}/secrets/${secretName}`, {
          metadata: { ownerReferences: [{ apiVersion: 'v1', kind: 'Pod', name: pod.metadata.name, uid: pod.metadata.uid }] },
        });
      }
      const log = new LogFollower(api, `${ns}/pods/${attempt.pod}/log?container=${container}`, logPath);
      try {
        const exitCode = await this.waitForExit(api, `${ns}/pods/${attempt.pod}`, attempt, container, image, () => log.start());
        if (exitCode !== undefined) await log.complete();
        return { exitCode: exitCode ?? 137 };
      } finally {
        await log.close();
      }
    } finally {
      if (this.running.get(job.scanId) === attempt) this.running.delete(job.scanId);
      await this.removeAttempt(api, env, attempt.pod).catch((e) => this.log.warn(`Could not clean up ${attempt.pod}: ${e.message}`));
    }
  }

  async stop(scanId: string): Promise<void> {
    const attempt = this.running.get(scanId);
    if (!attempt) return;
    attempt.stopped = true;
    const env = await this.ready?.catch(() => undefined);
    if (env && this.api) {
      const pods = `/api/v1/namespaces/${env.namespace}/pods`;
      await this.api.delete(`${pods}/${attempt.pod}`, 0).catch(() => undefined);
      await this.api.delete(`${pods}/${attempt.pod}-proxy`, 0).catch(() => undefined);
    }
  }

  /** Runs discovery once; a failed one is retried by the next caller. */
  private prepared(): Promise<KubernetesEnvironment> {
    return (this.ready ??= this.prepare().catch((e) => {
      this.ready = undefined;
      throw e;
    }));
  }

  private async prepare(): Promise<KubernetesEnvironment> {
    let namespace: string;
    if (this.options.connection) {
      this.api = this.options.connection.api;
      namespace = this.options.connection.namespace;
    } else {
      const connection = inClusterConnection();
      this.api = new KubeApi(connection);
      namespace = connection.namespace;
    }
    const env = await this.discover(this.api, namespace);
    this.log.log(
      `Agent pods in namespace ${env.namespace}: image ${env.agentImage}, proxy image ${env.proxyImage}, ` +
        `data on claim ${env.dataClaim}${env.node ? `, on node ${env.node}` : ''}`,
    );
    await this.removeLeftovers(this.api, env);
    return env;
  }

  /**
   * What the configuration leaves unset, from the server's own pod: the claim mounted at the
   * data directory (and whether agents must share its node), its image, pull secrets and fsGroup.
   */
  private async discover(api: KubeApi, namespace: string): Promise<KubernetesEnvironment> {
    const podName = this.options.podName ?? process.env.POD_NAME ?? process.env.HOSTNAME;
    const self = podName
      ? await api.get<any>(`/api/v1/namespaces/${namespace}/pods/${podName}`).catch((e) => {
          if (e instanceof KubeApiError && e.status === 404) return undefined;
          throw e;
        })
      : undefined;
    const labels: Record<string, string> = self?.metadata?.labels ?? {};

    let dataClaim = this.k8s.dataClaim;
    let dataMount = { path: this.dataDir, subPath: '' };
    if (self) {
      for (const container of self.spec.containers ?? []) {
        for (const mount of container.volumeMounts ?? []) {
          const mountPath = resolve(mount.mountPath);
          const rel = relative(mountPath, this.dataDir);
          if (rel.startsWith('..') || isAbsolute(rel)) continue;
          const volume = (self.spec.volumes ?? []).find((v: any) => v.name === mount.name);
          if (!volume?.persistentVolumeClaim) continue;
          if (dataClaim && volume.persistentVolumeClaim.claimName !== dataClaim) continue;
          dataClaim = volume.persistentVolumeClaim.claimName;
          dataMount = { path: mountPath, subPath: mount.subPath ?? '' };
        }
      }
    }
    if (!dataClaim) {
      throw new Error(`No PersistentVolumeClaim is mounted at the data directory ${this.dataDir}: set SCANNER_K8S_DATA_CLAIM`);
    }

    let node: string | undefined;
    if (this.k8s.colocate !== 'never') {
      const claim = await api.get<any>(`/api/v1/namespaces/${namespace}/persistentvolumeclaims/${dataClaim}`);
      const shared = (claim.status?.accessModes ?? claim.spec?.accessModes ?? []).includes('ReadWriteMany');
      if (this.k8s.colocate === 'always' || !shared) {
        node = self?.spec?.nodeName;
        if (!node) throw new Error(`Claim ${dataClaim} is not ReadWriteMany, and the server's node is unknown: set POD_NAME`);
      }
    }

    const serverImage: string | undefined = (self?.spec?.containers ?? []).find((c: any) =>
      (c.volumeMounts ?? []).some((m: any) => resolve(m.mountPath) === dataMount.path),
    )?.image;
    const agentImage = this.k8s.agentImage ?? (serverImage && agentImageFor(serverImage));
    if (!agentImage) throw new Error('Cannot tell the agent image from the server image: set SCANNER_AGENT_IMAGE');
    const proxyImage = this.k8s.proxyImage ?? serverImage;
    if (!proxyImage) throw new Error('Cannot tell the server image, which runs the egress proxy: set SCANNER_K8S_PROXY_IMAGE');

    return {
      namespace,
      owner: self ? { name: self.metadata.name, uid: self.metadata.uid } : undefined,
      instance: labels[K8S.instance] ?? 'ai-scanner',
      agentImage,
      proxyImage,
      dataClaim,
      dataMount,
      node,
      imagePullSecrets: self?.spec?.imagePullSecrets ?? [],
      fsGroup: self?.spec?.securityContext?.fsGroup,
    };
  }

  /** Agent and proxy pods, Secrets and NetworkPolicies of this instance that a previous server process left behind. */
  private async removeLeftovers(api: KubeApi, env: KubernetesEnvironment): Promise<void> {
    const selector = `labelSelector=${encodeURIComponent(`${K8S.managedBy}=${env.instance}`)}`;
    for (const base of this.collections(env)) {
      const list = await api.get<any>(`${base}?${selector}`);
      for (const item of list.items ?? []) await api.delete(`${base}/${item.metadata.name}`, 0);
    }
  }

  /** Everything one Attempt created: its agent and proxy pods, its Secret and its NetworkPolicies. */
  private async removeAttempt(api: KubeApi, env: KubernetesEnvironment, pod: string): Promise<void> {
    const [pods, secrets, policies] = this.collections(env);
    await api.delete(`${pods}/${pod}`, 0);
    await api.delete(`${pods}/${pod}-proxy`, 0);
    await api.delete(`${secrets}/${pod}-env`, 0);
    await api.delete(`${policies}/${pod}-agent`);
    await api.delete(`${policies}/${pod}-proxy`);
  }

  private collections(env: KubernetesEnvironment): string[] {
    return [
      `/api/v1/namespaces/${env.namespace}/pods`,
      `/api/v1/namespaces/${env.namespace}/secrets`,
      `/apis/networking.k8s.io/v1/namespaces/${env.namespace}/networkpolicies`,
    ];
  }

  /**
   * A directory as the pod can mount it: as it is when already on the data volume (a Scan's own
   * snapshot of skills), else a copy there, named `name`, next to the workspace (a profile's
   * skills or Preparation, which live in the server image).
   */
  private async onVolume(env: KubernetesEnvironment, dir: string, workspaceDir: string, name: string): Promise<string> {
    const rel = relative(env.dataMount.path, resolve(dir));
    if (!rel.startsWith('..') && !isAbsolute(rel)) return dir;
    const target = join(dirname(workspaceDir), name);
    await rm(target, { recursive: true, force: true });
    await cp(dir, target, { recursive: true });
    return target;
  }

  /** The subPath of the data claim a directory under the data mount lives at. */
  private subPath(env: KubernetesEnvironment, dir: string): string {
    const rel = relative(env.dataMount.path, resolve(dir));
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${dir} is not on the data volume mounted at ${env.dataMount.path}`);
    return posix.join(env.dataMount.subPath, rel.split(sep).join('/'));
  }

  private labels(env: KubernetesEnvironment, job: PodJob, pod: string, component: string): Record<string, string> {
    return {
      [K8S.name]: 'ai-scanner',
      [K8S.component]: component,
      [K8S.instance]: env.instance,
      [K8S.managedBy]: env.instance,
      [K8S.scan]: scanHash(job.scanId),
      [K8S.attemptPod]: pod,
    };
  }

  private metadata(env: KubernetesEnvironment, job: PodJob, name: string, pod: string, component: string): object {
    return {
      name,
      labels: this.labels(env, job, pod, component),
      annotations: { [K8S.scanId]: job.scanId, [K8S.attempt]: job.attempt },
      // Owned by the server pod: the cluster removes them along with it.
      ...(env.owner && { ownerReferences: [{ apiVersion: 'v1', kind: 'Pod', name: env.owner.name, uid: env.owner.uid }] }),
    };
  }

  private secretManifest(env: KubernetesEnvironment, name: string, job: PodJob, pod: string, data: Record<string, string>): object {
    return {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name, labels: this.labels(env, job, pod, 'agent'), annotations: { [K8S.scanId]: job.scanId } },
      type: 'Opaque',
      stringData: data,
    };
  }

  /**
   * The Attempt's own reachability, on top of the chart's deny-all for agent and proxy pods: its
   * agent may open connections to its proxy's port, and its proxy accepts them from its agent only.
   */
  networkPolicies(env: KubernetesEnvironment, job: PodJob, pod: string): object[] {
    const agent = { matchLabels: { [K8S.attemptPod]: pod, [K8S.component]: 'agent' } };
    const proxy = { matchLabels: { [K8S.attemptPod]: pod, [K8S.component]: 'egress-proxy' } };
    const port = [{ port: PROXY_PORT, protocol: 'TCP' }];
    return [
      {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        metadata: this.metadata(env, job, `${pod}-agent`, pod, 'agent'),
        spec: { podSelector: agent, policyTypes: ['Egress'], egress: [{ to: [{ podSelector: proxy }], ports: port }] },
      },
      {
        apiVersion: 'networking.k8s.io/v1',
        kind: 'NetworkPolicy',
        metadata: this.metadata(env, job, `${pod}-proxy`, pod, 'egress-proxy'),
        spec: { podSelector: proxy, policyTypes: ['Ingress'], ingress: [{ from: [{ podSelector: agent }], ports: port }] },
      },
    ];
  }

  private podSecurity(env: KubernetesEnvironment): object {
    const uid = this.options.uid ?? process.getuid?.();
    const gid = this.options.gid ?? process.getgid?.();
    return {
      runAsNonRoot: true,
      // The server's own user, so each can read and write what the other leaves on the volume.
      ...(uid !== undefined && uid !== 0 && { runAsUser: uid }),
      ...(gid !== undefined && uid !== 0 && { runAsGroup: gid }),
      ...(env.fsGroup !== undefined && { fsGroup: env.fsGroup }),
      seccompProfile: { type: 'RuntimeDefault' },
    };
  }

  private readonly containerSecurity = {
    allowPrivilegeEscalation: false,
    readOnlyRootFilesystem: true,
    capabilities: { drop: ['ALL'] },
  };

  /** Settings agent and proxy pods share: no token, no service links, no restart, a deadline. */
  private podBasics(env: KubernetesEnvironment, job: PodJob): object {
    return {
      restartPolicy: 'Never',
      // A backstop only: the supervisor stops the Attempt at its own timeout.
      activeDeadlineSeconds: Math.ceil(job.timeoutMs / 1000) + 300,
      terminationGracePeriodSeconds: 5,
      automountServiceAccountToken: false,
      enableServiceLinks: false,
      ...(this.k8s.agentServiceAccount && { serviceAccountName: this.k8s.agentServiceAccount }),
      ...(env.imagePullSecrets.length && { imagePullSecrets: env.imagePullSecrets }),
      securityContext: this.podSecurity(env),
    };
  }

  /** The Attempt's egress proxy: it lets through the Scan's model endpoint and its profile's, and nothing else. */
  proxyManifest(env: KubernetesEnvironment, job: PodJob, name: string, pod: string): object {
    return {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: this.metadata(env, job, name, pod, 'egress-proxy'),
      spec: {
        ...this.podBasics(env, job),
        containers: [
          {
            name: 'egress-proxy',
            image: env.proxyImage,
            command: PROXY_COMMAND,
            env: [
              { name: 'ALLOW', value: job.allow.join(',') },
              { name: 'PORT', value: String(PROXY_PORT) },
            ],
            ports: [{ name: 'egress', containerPort: PROXY_PORT }],
            readinessProbe: { tcpSocket: { port: PROXY_PORT }, periodSeconds: 1 },
            resources: { limits: { memory: '128Mi', cpu: '500m' }, requests: { memory: '32Mi', cpu: '10m' } },
            securityContext: this.containerSecurity,
          },
        ],
      },
    };
  }

  /** The agent pod of an Attempt. */
  podManifest(env: KubernetesEnvironment, name: string, request: AttemptRequest, proxyUrl: string, skillsDir?: string, secretName?: string): object {
    const job = { scanId: request.scanId, attempt: String(request.attempt), timeoutMs: request.attemptTimeoutMs, allow: request.modelEgress };
    const mount = (path: string, dir: string, readOnly: boolean) => ({
      name: 'data',
      mountPath: path,
      subPath: this.subPath(env, dir),
      ...(readOnly && { readOnly }),
    });
    return this.agentImagePod(env, job, name, {
      name: 'agent',
      image: variantImageOrThrow(env.agentImage, request.imageVariant),
      command: agentCommand(request, request.agentModel),
      workingDir: IN_CONTAINER.workspace,
      env: agentEnv(request, request.agentModel, proxyUrl),
      secretName,
      mounts: [
        mount(IN_CONTAINER.workspace, request.workspaceDir, true),
        mount(IN_CONTAINER.output, request.outputDir, false),
        ...(skillsDir ? [mount(IN_CONTAINER.skills, skillsDir, true)] : []),
        ...(request.preparedDir ? [mount(IN_CONTAINER.prepared, request.preparedDir, true)] : []),
      ],
    });
  }

  /** The pod of a Scan's Preparation: the profile's script, with /prepared writable (ADR-0015). */
  preparationPodManifest(env: KubernetesEnvironment, name: string, job: PodJob, request: PreparationRequest, proxyUrl: string, scriptDir: string): object {
    return this.agentImagePod(env, job, name, {
      name: PREPARATION_CONTAINER,
      image: variantImageOrThrow(env.agentImage, request.imageVariant),
      command: PREPARATION_COMMAND,
      workingDir: IN_CONTAINER.prepared,
      env: preparationEnv(proxyUrl),
      mounts: [
        { name: 'data', mountPath: IN_CONTAINER.workspace, subPath: this.subPath(env, request.workspaceDir), readOnly: true },
        { name: 'data', mountPath: IN_CONTAINER.prepared, subPath: this.subPath(env, request.preparedDir) },
        { name: 'data', mountPath: IN_CONTAINER.prepare, subPath: this.subPath(env, scriptDir), readOnly: true },
      ],
    });
  }

  /**
   * A pod of the agent image, labelled as an agent so the NetworkPolicies confine it: the data
   * claim's `mounts`, a small /tmp and home, no DNS, and the server's node when it must share it.
   */
  private agentImagePod(
    env: KubernetesEnvironment,
    job: PodJob,
    name: string,
    container: {
      name: string;
      image: string;
      command: string[];
      workingDir: string;
      env: Record<string, string>;
      secretName?: string;
      mounts: object[];
    },
  ): object {
    return {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: this.metadata(env, job, name, name, 'agent'),
      spec: {
        ...this.podBasics(env, job),
        // No DNS: the agent reaches its proxy by IP, and the NetworkPolicies drop DNS anyway. A
        // resolver on loopback, where nothing listens, makes any lookup fail at once instead of
        // waiting out timeouts on dropped packets (20 s each, before search domains).
        dnsPolicy: 'None',
        dnsConfig: { nameservers: ['127.0.0.1'], options: [{ name: 'ndots', value: '1' }, { name: 'attempts', value: '1' }] },
        ...(env.node && {
          affinity: {
            nodeAffinity: {
              requiredDuringSchedulingIgnoredDuringExecution: {
                nodeSelectorTerms: [{ matchFields: [{ key: 'metadata.name', operator: 'In', values: [env.node] }] }],
              },
            },
          },
        }),
        containers: [
          {
            name: container.name,
            image: container.image,
            command: container.command,
            workingDir: container.workingDir,
            env: Object.entries(container.env).map(([n, value]) => ({ name: n, value })),
            ...(container.secretName && { envFrom: [{ secretRef: { name: container.secretName } }] }),
            resources: {
              limits: { memory: this.k8s.memory, cpu: this.k8s.cpu },
              requests: { memory: '256Mi', cpu: '100m' },
            },
            securityContext: this.containerSecurity,
            volumeMounts: [...container.mounts, { name: 'tmp', mountPath: '/tmp' }, { name: 'home', mountPath: IN_CONTAINER.home }],
          },
        ],
        volumes: [
          { name: 'data', persistentVolumeClaim: { claimName: env.dataClaim } },
          { name: 'tmp', emptyDir: { sizeLimit: '512Mi' } },
          { name: 'home', emptyDir: { sizeLimit: '512Mi' } },
        ],
      },
    };
  }

  /** The proxy pod's IP once it is ready to accept connections; undefined if the Attempt was stopped meanwhile. */
  private async waitForProxy(api: KubeApi, path: string, attempt: RunningAttempt): Promise<string | undefined> {
    const deadline = Date.now() + PROXY_READY_TIMEOUT_MS;
    return this.poll(api, path, attempt, 'egress-proxy', undefined, (pod) => {
      const ready = pod.status?.conditions?.some((c) => c.type === 'Ready' && c.status === 'True');
      if (ready && pod.status?.podIP) return { value: pod.status.podIP };
      if (Date.now() > deadline) throw new Error(`The egress proxy ${pod.metadata.name} was not ready within ${PROXY_READY_TIMEOUT_MS / 1000} s`);
      return undefined;
    });
  }

  /**
   * Polls the pod until its `containerName` (the agent, or the Preparation) exits, and returns the
   * exit code; undefined once the pod is gone because the Attempt was stopped. A pod that can
   * never start ends the Attempt at once.
   */
  private waitForExit(
    api: KubeApi,
    path: string,
    attempt: RunningAttempt,
    containerName: string,
    image: string,
    started: () => void,
  ): Promise<number | undefined> {
    return this.poll(api, path, attempt, containerName, image, (pod, container) => {
      if (container?.state && !container.state.waiting) started();
      const terminated = container?.state?.terminated;
      if (terminated) return { value: terminated.exitCode };
      return undefined;
    });
  }

  /**
   * Polls a pod until `done` gives a value. Throws as soon as the pod can never get there: it
   * ended, it cannot pull its image or start its container, or it stays unschedulable. With
   * `image`, the agent image it runs: an image that cannot be pulled throws AgentImageUnavailableError.
   */
  private async poll<T>(
    api: KubeApi,
    path: string,
    attempt: RunningAttempt,
    containerName: string,
    image: string | undefined,
    done: (pod: PodStatus, container?: NonNullable<NonNullable<PodStatus['status']>['containerStatuses']>[number]) => { value: T } | undefined,
  ): Promise<T | undefined> {
    const pollMs = this.options.pollMs ?? 2000;
    let unschedulableSince: number | undefined;
    for (;;) {
      if (attempt.stopped) return undefined;
      let pod: PodStatus;
      try {
        pod = await api.get<PodStatus>(path);
      } catch (e) {
        if (e instanceof KubeApiError && e.status === 404) {
          if (attempt.stopped) return undefined;
          throw new Error(`Pod ${path.split('/').pop()} disappeared before the Attempt finished`);
        }
        throw e;
      }
      const name = pod.metadata.name;
      const container = pod.status?.containerStatuses?.find((c) => c.name === containerName);
      const result = done(pod, container);
      if (result) return result.value;
      if (pod.status?.phase === 'Failed' || pod.status?.phase === 'Succeeded') {
        throw new Error(`Pod ${name} ended (${pod.status.reason ?? pod.status.phase}): ${pod.status.message ?? `no ${containerName} exit code`}`);
      }
      const waiting = container?.state?.waiting;
      if (waiting?.reason && FATAL_WAITING.has(waiting.reason)) {
        if (image && IMAGE_WAITING.has(waiting.reason)) {
          throw new AgentImageUnavailableError(image, `pod ${name}: ${waiting.reason}: ${waiting.message ?? ''}`.trim());
        }
        throw new Error(`Pod ${name} cannot start: ${waiting.reason}: ${waiting.message ?? ''}`.trim());
      }
      const scheduled = pod.status?.conditions?.find((c) => c.type === 'PodScheduled');
      if (scheduled?.status === 'False' && scheduled.reason === 'Unschedulable') {
        unschedulableSince ??= Date.now();
        if (Date.now() - unschedulableSince > UNSCHEDULABLE_GRACE_MS) {
          throw new Error(`Pod ${name} cannot be scheduled: ${scheduled.message ?? 'Unschedulable'}`);
        }
      } else {
        unschedulableSince = undefined;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }
}

/**
 * The agent's log, followed into the transcript while the agent runs, as the Podman Runner
 * attaches to its container: the Scan's activity stream reads that file as it grows. Once the
 * agent exits, a follow that never started or broke off is replaced by the whole log.
 */
class LogFollower {
  private followed?: Promise<boolean>;
  private file?: WriteStream;
  private readonly abort = new AbortController();

  constructor(
    private readonly api: KubeApi,
    private readonly path: string,
    private readonly transcriptPath: string,
  ) {}

  /** Starts following, once the container runs; later calls do nothing. */
  start(): void {
    if (this.followed) return;
    this.file = createWriteStream(this.transcriptPath);
    this.followed = this.api.stream(`${this.path}&follow=true`, this.file, this.abort.signal).then(
      () => true,
      () => false,
    );
  }

  /** Once the agent exited: waits for the follow to end, or writes the whole log instead. */
  async complete(): Promise<void> {
    let timer: NodeJS.Timeout | undefined;
    const followed =
      this.followed &&
      (await Promise.race([this.followed, new Promise<false>((r) => (timer = setTimeout(() => r(false), 10_000)))]).finally(() =>
        clearTimeout(timer),
      ));
    if (followed) return;
    this.abort.abort();
    await this.close();
    try {
      await writeFile(this.transcriptPath, await this.api.text(this.path));
    } catch (e) {
      await writeFile(this.transcriptPath, `could not read the agent pod's log: ${(e as Error).message}\n`);
    }
  }

  async close(): Promise<void> {
    this.abort.abort();
    const file = this.file;
    this.file = undefined;
    if (file) await new Promise<void>((r) => file.end(() => r()));
  }
}

