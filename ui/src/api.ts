// Client of the ai-scanner HTTP API. Every endpoint needs the shared bearer token (ADR-0002).

export type ScanState = 'queued' | 'running' | 'succeeded' | 'failed';

export interface ScanStatus {
  id: string;
  state: ScanState;
  profile: string;
  model: string;
  language: string;
  attempts: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  failureReason?: string;
  artifacts?: string[];
}

export interface Profile {
  name: string;
  description: string;
  producesFindings: boolean;
}

export interface Model {
  id: string;
  provider: string;
  default: boolean;
}

export interface NewScan {
  id: string;
  file: File;
  profile: string;
  model?: string;
  language?: string;
  instructions?: string;
}

/** Scan ids must match the server's pattern: lowercase letters, digits and dashes, 1-64. */
export const SCAN_ID_PATTERN = /^[a-z0-9-]{1,64}$/;

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

const TOKEN_KEY = 'ai-scanner.token';

export const token = {
  get: (): string | null => {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      return null;
    }
  },
  set: (value: string) => {
    try {
      localStorage.setItem(TOKEN_KEY, value);
    } catch {
      // Private mode: the token lives only as long as the page.
    }
  },
  clear: () => {
    try {
      localStorage.removeItem(TOKEN_KEY);
    } catch {
      // Nothing stored.
    }
  },
};

/** Called on 401, so the app can ask for the token again. */
let onUnauthorized: () => void = () => undefined;
export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

/** Nest error bodies carry `message` as a string or, from validation, as a list. */
async function errorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json();
    const message = Array.isArray(body.message) ? body.message.join('; ') : body.message;
    return message || res.statusText;
  } catch {
    return res.statusText || `HTTP ${res.status}`;
  }
}

async function request(path: string, init: RequestInit = {}, bearer = token.get()): Promise<Response> {
  const res = await fetch(path, {
    ...init,
    headers: { ...init.headers, ...(bearer && { Authorization: `Bearer ${bearer}` }) },
  });
  if (res.status === 401) {
    onUnauthorized();
    throw new ApiError(401, 'Missing or wrong token');
  }
  if (!res.ok) throw new ApiError(res.status, await errorMessage(res));
  return res;
}

export const api = {
  /** Checks a token before keeping it: any authenticated endpoint will do. */
  async verifyToken(candidate: string): Promise<boolean> {
    const res = await fetch('/api/models', { headers: { Authorization: `Bearer ${candidate}` } });
    if (res.status === 401) return false;
    if (!res.ok) throw new ApiError(res.status, await errorMessage(res));
    return true;
  },

  profiles: async (): Promise<Profile[]> => (await request('/api/profiles')).json(),

  models: async (): Promise<Model[]> => (await request('/api/models')).json(),

  scans: async (): Promise<ScanStatus[]> => (await request('/api/scans')).json(),

  scan: async (id: string): Promise<ScanStatus> => (await request(`/api/scan/${encodeURIComponent(id)}`)).json(),

  async createScan(scan: NewScan): Promise<ScanStatus> {
    const form = new FormData();
    form.append('profile', scan.profile);
    if (scan.model) form.append('model', scan.model);
    if (scan.language) form.append('language', scan.language);
    if (scan.instructions) form.append('instructions', scan.instructions);
    form.append('file', scan.file, scan.file.name);
    const res = await request(`/api/scan/${encodeURIComponent(scan.id)}`, { method: 'POST', body: form });
    return res.json();
  },

  async deleteScan(id: string): Promise<void> {
    await request(`/api/scan/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  /** Artifacts need the bearer header, so they are fetched as a Blob rather than linked. */
  async artifact(id: string, name: string): Promise<Blob> {
    const res = await request(`/api/scan/${encodeURIComponent(id)}/artifacts/${encodeURIComponent(name)}`);
    return res.blob();
  },
};

/** One line of what the agent did, as `GET /api/scan/<id>/events` sends it. */
export interface Activity {
  attempt: number;
  at: string;
  kind: 'tool' | 'text' | 'step' | 'error' | 'log';
  tool?: string;
  ok?: boolean;
  text: string;
}

export type ScanEvent =
  | { type: 'state'; data: ScanStatus }
  | { type: 'attempt'; data: { attempt: number } }
  | { type: 'activity'; data: Activity }
  | { type: 'deleted'; data: { id: string } };

/**
 * Follows `GET /api/scan/<id>/events` until the server ends it or `signal` aborts. EventSource
 * cannot send the bearer header, so this reads the server-sent events off a fetch body.
 */
export async function followScan(id: string, onEvent: (event: ScanEvent) => void, signal: AbortSignal): Promise<void> {
  const res = await request(`/api/scan/${encodeURIComponent(id)}/events`, { signal, headers: { Accept: 'text/event-stream' } });
  if (!res.body) return;
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return;
    buffer += value.replace(/\r\n/g, '\n');
    let end: number;
    while ((end = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      let type = 'message';
      const data: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) type = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) onEvent({ type, data: JSON.parse(data.join('\n')) } as ScanEvent);
    }
  }
}

/** Saves a Blob as a file through a temporary object URL. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
