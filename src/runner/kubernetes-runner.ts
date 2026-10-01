import { Logger, OnModuleInit } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { cp, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { paths } from '../common/paths';
import { AppConfig, KubernetesConfig } from '../config/app-config';
import { agentCommand, agentEnv, agentSecrets, AllowList, IN_CONTAINER } from './agent-spec';
import { inClusterConnection, KubeApi, KubeApiError } from './kube-api';
import { AttemptRequest, AttemptResult, Runner } from './runner';

/** Labels and annotations the Runner puts on what it creates. */
export const K8S = {
  name: 'app.kubernetes.io/name',
  component: 'app.kubernetes.io/component',
  instance: 'app.kubernetes.io/instance',
  managedBy: 'ai-scanner.io/managed-by',
  scan: 'ai-scanner.io/scan',
  scanId: 'ai-scanner.io/scan-id',
  attempt: 'ai-scanner.io/attempt',
};

/** Waiting reasons that never resolve on their own: the Attempt ends now, not at its timeout. */
const FATAL_WAITING = new Set(['ErrImagePull', 'ImagePullBackOff', 'InvalidImageName', 'CreateContainerConfigError', 'CreateContainerError']);
/** How long an agent pod may stay unschedulable (a cluster autoscaler may still add a node). */
const UNSCHEDULABLE_GRACE_MS = 3 * 60_000;
const EGRESS_PORT_NAME = 'egress';

/** What the Runner learns once, from its own pod and the namespace. */
export interface KubernetesEnvironment {
  namespace: string;
  /** Agent pods are owned by the server pod, so the cluster removes them along with it. */
  owner?: { name: string; uid: string };
  /** Value of the `managed-by` label: agent pods of other ai-scanner instances are left alone. */
  instance: string;
  agentImage: string;
  egressProxy: string;
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
    conditions?: { type: string; status: string; reason?: string; message?: string }[];
    containerStatuses?: {
      name: string;
      state?: { waiting?: { reason?: string; message?: string }; terminated?: { exitCode: number; reason?: string } };
    }[];
  };
}

interface RunningAttempt {
  pod: string;
  stopped: boolean;
}

/** A DNS-1123 name for an Attempt's pod: Scan ids are the caller's (ADR-0002), so they are hashed. */
export function attemptPodName(scanId: string, attempt: number): string {
  return `ai-scanner-${scanHash(scanId)}-${attempt}`;
}

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
 * The agent pod mounts the server's data claim: the workspace and skills read-only, /output
 * writable. It has a read-only root filesystem, no capabilities, no ServiceAccount token and
 * no service links, and runs as the server's user, so both can read what the other writes.
 * NetworkPolicy (from the Helm chart) lets it reach only the egress proxy, a sidecar of the
 * server pod whose allow list the server writes to the data volume before each Attempt.
 * Secrets (the model's key) go into a Secret per Attempt, owned by the pod.
 */
export class KubernetesRunner extends Runner implements OnModuleInit {
  private readonly log = new Logger(KubernetesRunner.name);
  private readonly k8s: KubernetesConfig;
  private readonly dataDir: string;
  private readonly allowList: AllowList;
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
    this.allowList = new AllowList(paths.egress(config.dataDir), (m) => this.log.log(m));
  }

  /** Discovers right away: a misconfiguration shows at startup, and pods a crashed server left behind go now. */
  onModuleInit(): void {
    this.prepared().catch((e) => this.log.error(`Could not prepare the Kubernetes Runner: ${e.message}`));
  }

  async run(request: AttemptRequest): Promise<AttemptResult> {
    const attempt: RunningAttempt = { pod: attemptPodName(request.scanId, request.attempt), stopped: false };
    this.running.set(request.scanId, attempt); // before any await: see Runner.stop
    const env = await this.prepared().catch((e) => {
      this.running.delete(request.scanId);
      throw e;
    });
    const api = this.api!;
    const pods = `/api/v1/namespaces/${env.namespace}/pods`;
    const secrets = `/api/v1/namespaces/${env.namespace}/secrets`;
    try {
      await this.allowList.write(request.egress);
      const skills = request.skillsDir && (await this.skillsOnVolume(request));
      const secretEnv = agentSecrets(request.agentModel, this.k8s.agentEnv, (m) => this.log.warn(m));
      const secretName = Object.keys(secretEnv).length ? `${attempt.pod}-env` : undefined;
      // Leftovers of the same Attempt, should a previous server have died mid-way.
      await api.delete(`${pods}/${attempt.pod}`, 0);
      if (secretName) {
        await api.delete(`${secrets}/${secretName}`, 0);
        await api.post(secrets, this.secretManifest(env, secretName, request, secretEnv));
      }
      if (attempt.stopped) return { exitCode: 137 };
      const pod = await api.post<PodStatus>(pods, this.podManifest(env, attempt.pod, request, skills, secretName));
      if (secretName) {
        // The Secret now goes away with the pod, whatever happens to this process.
        await api.patch(`${secrets}/${secretName}`, {
          metadata: { ownerReferences: [{ apiVersion: 'v1', kind: 'Pod', name: pod.metadata.name, uid: pod.metadata.uid }] },
        });
      }
      const exitCode = await this.waitForExit(api, `${pods}/${attempt.pod}`, attempt);
      if (exitCode !== undefined) await this.saveLog(api, `${pods}/${attempt.pod}/log?container=agent`, request.transcriptPath);
      return { exitCode: exitCode ?? 137 };
    } finally {
      if (this.running.get(request.scanId) === attempt) this.running.delete(request.scanId);
      await api.delete(`${pods}/${attempt.pod}`, 0).catch((e) => this.log.warn(`Could not delete pod ${attempt.pod}: ${e.message}`));
      await api.delete(`${secrets}/${attempt.pod}-env`, 0).catch(() => undefined);
    }
  }

  async stop(scanId: string): Promise<void> {
    const attempt = this.running.get(scanId);
    if (!attempt) return;
    attempt.stopped = true;
    const env = await this.ready?.catch(() => undefined);
    if (env && this.api) await this.api.delete(`/api/v1/namespaces/${env.namespace}/pods/${attempt.pod}`, 0).catch(() => undefined);
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
      `Agent pods in namespace ${env.namespace}: image ${env.agentImage}, egress via ${env.egressProxy}, ` +
        `data on claim ${env.dataClaim}${env.node ? `, on node ${env.node}` : ''}`,
    );
    await this.removeLeftovers(this.api, env);
    return env;
  }

  /**
   * What the configuration leaves unset, from the server's own pod: the claim mounted at the
   * data directory (and whether agents must share its node), its image, pull secrets and
   * fsGroup, and the Service exposing its egress port.
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

    const serverContainer = (self?.spec?.containers ?? []).find((c: any) =>
      (c.volumeMounts ?? []).some((m: any) => resolve(m.mountPath) === dataMount.path),
    );
    const agentImage = this.k8s.agentImage ?? (serverContainer && agentImageFor(serverContainer.image));
    if (!agentImage) throw new Error('Cannot tell the agent image from the server image: set SCANNER_AGENT_IMAGE');

    const egressProxy = this.k8s.egressProxy ?? (await this.findEgressService(api, namespace, labels));
    if (!egressProxy) {
      throw new Error(`No Service in ${namespace} selects this pod with a port named ${EGRESS_PORT_NAME}: set SCANNER_K8S_EGRESS_PROXY`);
    }

    return {
      namespace,
      owner: self ? { name: self.metadata.name, uid: self.metadata.uid } : undefined,
      instance: labels[K8S.instance] ?? 'ai-scanner',
      agentImage,
      egressProxy,
      dataClaim,
      dataMount,
      node,
      imagePullSecrets: self?.spec?.imagePullSecrets ?? [],
      fsGroup: self?.spec?.securityContext?.fsGroup,
    };
  }

  private async findEgressService(api: KubeApi, namespace: string, labels: Record<string, string>): Promise<string | undefined> {
    const services = await api.get<any>(`/api/v1/namespaces/${namespace}/services`);
    for (const svc of services.items ?? []) {
      const selector: Record<string, string> = svc.spec?.selector ?? {};
      const selects = Object.keys(selector).length > 0 && Object.entries(selector).every(([k, v]) => labels[k] === v);
      const port = (svc.spec?.ports ?? []).find((p: any) => p.name === EGRESS_PORT_NAME);
      if (selects && port) return `http://${svc.metadata.name}.${namespace}.svc:${port.port}`;
    }
    return undefined;
  }

  /** Agent pods and Secrets of this instance that a previous server process left behind. */
  private async removeLeftovers(api: KubeApi, env: KubernetesEnvironment): Promise<void> {
    const selector = encodeURIComponent(`${K8S.managedBy}=${env.instance}`);
    for (const kind of ['pods', 'secrets']) {
      const list = await api.get<any>(`/api/v1/namespaces/${env.namespace}/${kind}?labelSelector=${selector}`);
      for (const item of list.items ?? []) {
        await api.delete(`/api/v1/namespaces/${env.namespace}/${kind}/${item.metadata.name}`, 0);
      }
    }
  }

  /** The skills live in the server image: a copy on the data volume, next to the workspace, for the pod to mount. */
  private async skillsOnVolume(request: AttemptRequest): Promise<string> {
    const target = join(dirname(request.workspaceDir), 'skills');
    await cp(request.skillsDir!, target, { recursive: true, force: true });
    return target;
  }

  /** The subPath of the data claim a directory under the data mount lives at. */
  private subPath(env: KubernetesEnvironment, dir: string): string {
    const rel = relative(env.dataMount.path, resolve(dir));
    if (rel.startsWith('..') || isAbsolute(rel)) throw new Error(`${dir} is not on the data volume mounted at ${env.dataMount.path}`);
    return posix.join(env.dataMount.subPath, rel.split(sep).join('/'));
  }

  private labels(env: KubernetesEnvironment, request: AttemptRequest): Record<string, string> {
    return {
      [K8S.name]: 'ai-scanner',
      [K8S.component]: 'agent',
      [K8S.instance]: env.instance,
      [K8S.managedBy]: env.instance,
      [K8S.scan]: scanHash(request.scanId),
    };
  }

  private secretManifest(env: KubernetesEnvironment, name: string, request: AttemptRequest, data: Record<string, string>): object {
    return {
      apiVersion: 'v1',
      kind: 'Secret',
      metadata: { name, labels: this.labels(env, request), annotations: { [K8S.scanId]: request.scanId } },
      type: 'Opaque',
      stringData: data,
    };
  }

  /** The agent pod of an Attempt. */
  podManifest(env: KubernetesEnvironment, name: string, request: AttemptRequest, skillsDir?: string, secretName?: string): object {
    const uid = this.options.uid ?? process.getuid?.();
    const gid = this.options.gid ?? process.getgid?.();
    const mounts = [
      { name: 'data', mountPath: IN_CONTAINER.workspace, subPath: this.subPath(env, request.workspaceDir), readOnly: true },
      { name: 'data', mountPath: IN_CONTAINER.output, subPath: this.subPath(env, request.outputDir) },
      ...(skillsDir ? [{ name: 'data', mountPath: IN_CONTAINER.skills, subPath: this.subPath(env, skillsDir), readOnly: true }] : []),
      { name: 'tmp', mountPath: '/tmp' },
      { name: 'home', mountPath: IN_CONTAINER.home },
    ];
    return {
      apiVersion: 'v1',
      kind: 'Pod',
      metadata: {
        name,
        labels: this.labels(env, request),
        annotations: { [K8S.scanId]: request.scanId, [K8S.attempt]: String(request.attempt) },
        ...(env.owner && { ownerReferences: [{ apiVersion: 'v1', kind: 'Pod', name: env.owner.name, uid: env.owner.uid }] }),
      },
      spec: {
        restartPolicy: 'Never',
        // A backstop only: the supervisor stops the Attempt at its own timeout.
        activeDeadlineSeconds: Math.ceil(this.config.attemptTimeoutMs / 1000) + 300,
        terminationGracePeriodSeconds: 5,
        automountServiceAccountToken: false,
        enableServiceLinks: false,
        ...(this.k8s.agentServiceAccount && { serviceAccountName: this.k8s.agentServiceAccount }),
        ...(env.imagePullSecrets.length && { imagePullSecrets: env.imagePullSecrets }),
        securityContext: {
          runAsNonRoot: true,
          // The server's own user, so each can read and write what the other leaves on the volume.
          ...(uid !== undefined && uid !== 0 && { runAsUser: uid }),
          ...(gid !== undefined && uid !== 0 && { runAsGroup: gid }),
          ...(env.fsGroup !== undefined && { fsGroup: env.fsGroup }),
          seccompProfile: { type: 'RuntimeDefault' },
        },
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
            name: 'agent',
            image: env.agentImage,
            command: agentCommand(request, request.agentModel),
            workingDir: IN_CONTAINER.workspace,
            env: Object.entries(agentEnv(request, request.agentModel, env.egressProxy)).map(([n, value]) => ({ name: n, value })),
            ...(secretName && { envFrom: [{ secretRef: { name: secretName } }] }),
            resources: {
              limits: { memory: this.k8s.memory, cpu: this.k8s.cpu },
              requests: { memory: '256Mi', cpu: '100m' },
            },
            securityContext: {
              allowPrivilegeEscalation: false,
              readOnlyRootFilesystem: true,
              capabilities: { drop: ['ALL'] },
            },
            volumeMounts: mounts,
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

  /**
   * Polls the pod until its agent exits, and returns the exit code; undefined once the pod is
   * gone because the Attempt was stopped. A pod that can never start ends the Attempt at once.
   */
  private async waitForExit(api: KubeApi, path: string, attempt: RunningAttempt): Promise<number | undefined> {
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
          throw new Error(`Pod ${attempt.pod} disappeared before the agent finished`);
        }
        throw e;
      }
      const container = pod.status?.containerStatuses?.find((c) => c.name === 'agent');
      const terminated = container?.state?.terminated;
      if (terminated) return terminated.exitCode;
      if (pod.status?.phase === 'Failed' || pod.status?.phase === 'Succeeded') {
        throw new Error(`Pod ${attempt.pod} ended (${pod.status.reason ?? pod.status.phase}): ${pod.status.message ?? 'no agent exit code'}`);
      }
      const waiting = container?.state?.waiting;
      if (waiting?.reason && FATAL_WAITING.has(waiting.reason)) {
        throw new Error(`Pod ${attempt.pod} cannot start: ${waiting.reason}: ${waiting.message ?? ''}`.trim());
      }
      const scheduled = pod.status?.conditions?.find((c) => c.type === 'PodScheduled');
      if (scheduled?.status === 'False' && scheduled.reason === 'Unschedulable') {
        unschedulableSince ??= Date.now();
        if (Date.now() - unschedulableSince > UNSCHEDULABLE_GRACE_MS) {
          throw new Error(`Pod ${attempt.pod} cannot be scheduled: ${scheduled.message ?? 'Unschedulable'}`);
        }
      } else {
        unschedulableSince = undefined;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  private async saveLog(api: KubeApi, path: string, transcriptPath: string): Promise<void> {
    try {
      await writeFile(transcriptPath, await api.text(path));
    } catch (e) {
      await writeFile(transcriptPath, `could not read the agent pod's log: ${(e as Error).message}\n`);
    }
  }
}
