import { createHash } from 'node:crypto';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { parse } from 'yaml';

/** Agent Skills names: what opencode accepts, and a safe directory name. */
export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

export interface SkillLimits {
  /** Bytes of one skill, all its files together. */
  maxBytes: number;
  /** Files of one skill. */
  maxFiles: number;
}

export interface FoundSkill {
  name: string;
  description: string;
  /** The directory holding its SKILL.md. */
  dir: string;
  /** sha256 over its files' paths and contents, to tell versions apart. */
  hash: string;
  files: number;
  bytes: number;
}

/** A skill directory that cannot be imported, and why. */
export class InvalidSkillError extends Error {}

/** The `name` and `description` of a SKILL.md's YAML frontmatter. */
export function readFrontmatter(text: string): { name?: unknown; description?: unknown } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?(?:\n|$)/.exec(text);
  if (!match) throw new InvalidSkillError('SKILL.md has no YAML frontmatter');
  try {
    const data = parse(match[1]);
    return data && typeof data === 'object' ? data : {};
  } catch (e) {
    throw new InvalidSkillError(`SKILL.md frontmatter is not valid YAML: ${(e as Error).message}`);
  }
}

/**
 * Every file under `dir`, refusing anything but regular files and directories: a symlink could
 * make the agent read outside the skill.
 */
async function walk(dir: string, limits: SkillLimits, acc = { files: [] as string[], bytes: 0 }): Promise<typeof acc> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const info = await lstat(path);
    if (info.isDirectory()) await walk(path, limits, acc);
    else if (info.isFile()) {
      acc.files.push(path);
      acc.bytes += info.size;
    } else throw new InvalidSkillError(`${entry.name} is neither a file nor a directory`);
    if (acc.files.length > limits.maxFiles) throw new InvalidSkillError(`more than ${limits.maxFiles} files`);
    if (acc.bytes > limits.maxBytes) throw new InvalidSkillError(`more than ${limits.maxBytes} bytes`);
  }
  return acc;
}

/** Reads and checks one skill directory. */
export async function readSkill(dir: string, limits: SkillLimits): Promise<FoundSkill> {
  const folder = dir.split(/[\\/]/).pop() ?? '';
  const { files, bytes } = await walk(dir, limits);
  const meta = readFrontmatter(await readFile(join(dir, 'SKILL.md'), 'utf8'));
  if (typeof meta.name !== 'string' || !SKILL_NAME_PATTERN.test(meta.name)) {
    throw new InvalidSkillError(`its name must be 1-64 lowercase letters, digits and dashes: ${String(meta.name)}`);
  }
  if (meta.name !== folder) throw new InvalidSkillError(`its name ${meta.name} differs from its directory ${folder}`);
  if (typeof meta.description !== 'string' || !meta.description.trim()) throw new InvalidSkillError('it has no description');

  const hash = createHash('sha256');
  for (const file of files.sort()) {
    hash.update(relative(dir, file).replaceAll('\\', '/')).update('\0');
    hash.update(await readFile(file)).update('\0');
  }
  return { name: meta.name, description: meta.description.trim(), dir, hash: hash.digest('hex'), files: files.length, bytes };
}

/**
 * The skill directories under `root`: each directory holding a SKILL.md, not looking inside it.
 * `root` itself counts when it holds one.
 */
export async function findSkillDirs(root: string, depth = 4): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true });
  if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) return [root];
  if (depth === 0) return [];
  const found: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) found.push(...(await findSkillDirs(join(root, entry.name), depth - 1)));
  }
  return found;
}
