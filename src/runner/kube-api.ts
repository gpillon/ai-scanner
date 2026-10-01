import { existsSync, readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import * as http from 'node:http';
import * as https from 'node:https';
import { join } from 'node:path';

/** Where Kubernetes mounts a pod's ServiceAccount credentials. */
export const SERVICE_ACCOUNT_DIR = '/var/run/secrets/kubernetes.io/serviceaccount';

/** How to reach the Kubernetes API. */
export interface KubeConnection {
  /** e.g. `https://172.30.0.1:443` */
  server: string;
  /** Read on every request: bound ServiceAccount tokens rotate, about hourly. */
  token: () => Promise<string | undefined>;
  ca?: Buffer;
}

/** Whether this process runs in a Kubernetes pod with its ServiceAccount token mounted. */
export function inCluster(env: NodeJS.ProcessEnv = process.env, dir = SERVICE_ACCOUNT_DIR): boolean {
  return Boolean(env.KUBERNETES_SERVICE_HOST) && existsSync(join(dir, 'token'));
}

/** The pod's own connection to the API server, and its namespace. */
export function inClusterConnection(
  env: NodeJS.ProcessEnv = process.env,
  dir = SERVICE_ACCOUNT_DIR,
): KubeConnection & { namespace: string } {
  const host = env.KUBERNETES_SERVICE_HOST;
  if (!host) throw new Error('Not running in a Kubernetes pod: KUBERNETES_SERVICE_HOST is not set');
  const port = env.KUBERNETES_SERVICE_PORT || '443';
  return {
    server: `https://${host.includes(':') ? `[${host}]` : host}:${port}`,
    token: async () => (await readFile(join(dir, 'token'), 'utf8')).trim(),
    ca: existsSync(join(dir, 'ca.crt')) ? readFileSync(join(dir, 'ca.crt')) : undefined,
    namespace: readFileSync(join(dir, 'namespace'), 'utf8').trim(),
  };
}

export class KubeApiError extends Error {
  constructor(
    readonly status: number,
    readonly reason: string,
    message: string,
  ) {
    super(message);
  }
}

const REQUEST_TIMEOUT_MS = 30_000;

/**
 * The few Kubernetes API calls the Runner needs, over plain HTTPS: no client library, so the
 * server image gains no dependency. Paths are API paths, e.g. `/api/v1/namespaces/x/pods`.
 */
export class KubeApi {
  constructor(private readonly connection: KubeConnection) {}

  get<T>(path: string): Promise<T> {
    return this.json('GET', path);
  }

  post<T>(path: string, body: unknown): Promise<T> {
    return this.json('POST', path, body);
  }

  /** A JSON merge patch. */
  patch<T>(path: string, body: unknown): Promise<T> {
    return this.json('PATCH', path, body, 'application/merge-patch+json');
  }

  /** Deletes, ignoring an object already gone. */
  async delete(path: string, gracePeriodSeconds?: number): Promise<void> {
    const body = gracePeriodSeconds === undefined ? undefined : { kind: 'DeleteOptions', apiVersion: 'v1', gracePeriodSeconds, propagationPolicy: 'Background' };
    try {
      await this.json('DELETE', path, body);
    } catch (e) {
      if (!(e instanceof KubeApiError && e.status === 404)) throw e;
    }
  }

  /** A plain-text resource, such as a pod's log. */
  async text(path: string): Promise<string> {
    return (await this.send('GET', path)).toString('utf8');
  }

  private async json<T>(method: string, path: string, body?: unknown, contentType = 'application/json'): Promise<T> {
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    return JSON.parse((await this.send(method, path, payload, contentType)).toString('utf8')) as T;
  }

  private async send(method: string, path: string, payload?: Buffer, contentType?: string): Promise<Buffer> {
    const url = new URL(path, this.connection.server);
    const token = await this.connection.token();
    const headers: Record<string, string> = { Accept: 'application/json, */*' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (payload) Object.assign(headers, { 'Content-Type': contentType!, 'Content-Length': String(payload.length) });
    const transport = url.protocol === 'http:' ? http : https;
    return new Promise((resolve, reject) => {
      const req = transport.request(url, { method, headers, ca: this.connection.ca, timeout: REQUEST_TIMEOUT_MS }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const data = Buffer.concat(chunks);
          const status = res.statusCode ?? 0;
          if (status >= 200 && status < 300) return resolve(data);
          let reason = '';
          let message = data.toString('utf8').slice(0, 500);
          try {
            const parsed = JSON.parse(data.toString('utf8'));
            reason = parsed.reason ?? '';
            message = parsed.message ?? message;
          } catch {
            // not a Status object
          }
          reject(new KubeApiError(status, reason, `Kubernetes API ${method} ${url.pathname}: ${status} ${message}`));
        });
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error(`Kubernetes API ${method} ${url.pathname} timed out`)));
      req.on('error', reject);
      req.end(payload);
    });
  }
}
