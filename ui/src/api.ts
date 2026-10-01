// Client of the ai-scanner HTTP API. Every endpoint needs the shared bearer token (ADR-0002).

/** `warming`: the model is woken up before the first Attempt (ADR-0009). */
export type ScanState = 'queued' | 'warming' | 'running' | 'succeeded' | 'failed';

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
  /** The Skill Packs the Scan added to its profile, with the skills each gave it. */
  skillPacks?: { id: string; skills: { name: string; hash: string }[] }[];
  /** When the code came from a Git repository (ADR-0010). */
  source?: { type: 'git'; url: string; ref: string | null; commit: string };
  artifacts?: string[];
  /** Tokens the agent used over the Attempts so far, subagents included; absent until one reports it. */
  usage?: TokenUsage;
}

export interface TokenUsage {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  /** As the provider reports it; 0 when it reports none. */
  cost: number;
  /** Agent sessions: the main one plus one per subagent. */
  sessions: number;
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

/** Credentials of a private Git repository: kept in the form only, sent with each request. */
export interface GitCredentials {
  username?: string;
  token?: string;
}

export interface GitRefs {
  default: string | null;
  branches: string[];
  tags: string[];
}

export interface NewScan {
  id: string;
  /** A Source Archive, or else `repo`. */
  file?: File;
  repo?: { url: string; ref?: string; credentials?: GitCredentials };
  profile: string;
  model?: string;
  language?: string;
  instructions?: string;
  skillPacks?: string[];
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

/** `admin` for the admin token, which also opens the administration pages (ADR-0006). */
export type Role = 'admin' | 'caller';

export interface ProviderKind {
  kind: string;
  defaultBaseUrl?: string;
  apiKeyEnv?: string;
}

export interface Provider {
  id: string;
  kind: string;
  baseUrl: string | null;
  effectiveBaseUrl: string | null;
  apiKeySet: boolean;
  apiKeyHint: string | null;
  apiKeyEnv: string | null;
  models: number;
  createdAt: string;
}

export interface NewProvider {
  id: string;
  kind: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface ProviderChange {
  baseUrl?: string | null;
  /** A new key; `null` removes the stored one. */
  apiKey?: string | null;
}

export interface DiscoveredModel {
  name: string;
  displayName?: string;
  /** The Model Pool id, when the pool already has it. */
  inPool?: string;
}

export interface AdminModel {
  id: string;
  provider: string;
  name: string;
  enabled: boolean;
  default: boolean;
}

export interface NewModel {
  provider: string;
  name: string;
  id?: string;
  default?: boolean;
}

/** A skill of the Skill Library (ADR-0008). */
export interface LibrarySkill {
  name: string;
  description: string;
  source: string;
  hash: string;
  files: number;
  bytes: number;
  importedAt: string;
  packs: string[];
}

export interface SkillPack {
  id: string;
  description: string;
  skills: { name: string; description: string }[];
}

/** A JSON request body. */
const send = (method: string, path: string, body: unknown) =>
  request(path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

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
    if (scan.skillPacks?.length) form.append('skillPacks', scan.skillPacks.join(','));
    if (scan.file) form.append('file', scan.file, scan.file.name);
    if (scan.repo) {
      form.append('repoUrl', scan.repo.url);
      if (scan.repo.ref) form.append('ref', scan.repo.ref);
      if (scan.repo.credentials?.username) form.append('gitUsername', scan.repo.credentials.username);
      if (scan.repo.credentials?.token) form.append('gitToken', scan.repo.credentials.token);
    }
    const res = await request(`/api/scan/${encodeURIComponent(scan.id)}`, { method: 'POST', body: form });
    return res.json();
  },

  gitRefs: async (url: string, credentials: GitCredentials = {}): Promise<GitRefs> =>
    (await send('POST', '/api/git/refs', { url, ...credentials })).json(),

  async deleteScan(id: string): Promise<void> {
    await request(`/api/scan/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  me: async (): Promise<{ role: Role }> => (await request('/api/me')).json(),

  providerKinds: async (): Promise<ProviderKind[]> => (await request('/api/admin/provider-kinds')).json(),

  providers: async (): Promise<Provider[]> => (await request('/api/admin/providers')).json(),

  createProvider: async (input: NewProvider): Promise<Provider> => (await send('POST', '/api/admin/providers', input)).json(),

  updateProvider: async (id: string, change: ProviderChange): Promise<Provider> =>
    (await send('PATCH', `/api/admin/providers/${encodeURIComponent(id)}`, change)).json(),

  async deleteProvider(id: string): Promise<void> {
    await request(`/api/admin/providers/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  discoverModels: async (providerId: string): Promise<DiscoveredModel[]> =>
    (await request(`/api/admin/providers/${encodeURIComponent(providerId)}/models`)).json(),

  adminModels: async (): Promise<AdminModel[]> => (await request('/api/admin/models')).json(),

  createModel: async (input: NewModel): Promise<AdminModel> => (await send('POST', '/api/admin/models', input)).json(),

  updateModel: async (id: string, change: { enabled?: boolean; default?: boolean }): Promise<AdminModel> =>
    (await send('PATCH', `/api/admin/models/${encodeURIComponent(id)}`, change)).json(),

  async deleteModel(id: string): Promise<void> {
    await request(`/api/admin/models/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  skillPacks: async (): Promise<SkillPack[]> => (await request('/api/skill-packs')).json(),

  librarySkills: async (): Promise<LibrarySkill[]> => (await request('/api/admin/skills')).json(),

  librarySkill: async (name: string): Promise<LibrarySkill & { instructions: string }> =>
    (await request(`/api/admin/skills/${encodeURIComponent(name)}`)).json(),

  async uploadSkills(file: File, replace: boolean): Promise<{ imported: LibrarySkill[] }> {
    const form = new FormData();
    form.append('replace', String(replace));
    form.append('file', file, file.name);
    return (await request('/api/admin/skills', { method: 'POST', body: form })).json();
  },

  installSkills: async (source: string, skills: string[], replace: boolean): Promise<{ imported: LibrarySkill[] }> =>
    (await send('POST', '/api/admin/skills/install', { source, ...(skills.length && { skills }), replace })).json(),

  async deleteSkill(name: string): Promise<void> {
    await request(`/api/admin/skills/${encodeURIComponent(name)}`, { method: 'DELETE' });
  },

  createSkillPack: async (pack: { id: string; description: string; skills: string[] }): Promise<SkillPack> =>
    (await send('POST', '/api/admin/skill-packs', pack)).json(),

  updateSkillPack: async (id: string, change: { description?: string; skills?: string[] }): Promise<SkillPack> =>
    (await send('PATCH', `/api/admin/skill-packs/${encodeURIComponent(id)}`, change)).json(),

  async deleteSkillPack(id: string): Promise<void> {
    await request(`/api/admin/skill-packs/${encodeURIComponent(id)}`, { method: 'DELETE' });
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
  kind: 'tool' | 'text' | 'step' | 'error' | 'log' | 'subagent';
  /** The subagent that did it; absent for the main agent. */
  subagent?: string;
  /** For a `subagent` line: how many subagents are active, after this event. */
  active?: number;
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
