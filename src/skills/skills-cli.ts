import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';

/** The `skills` CLI (npm package `skills`, pinned in package.json), run by the server's own Node. */
const CLI = join(dirname(require.resolve('skills/package.json')), 'bin', 'cli.mjs');

export const SKILLS_CLI_TIMEOUT_MS = 3 * 60 * 1000;
const MAX_OUTPUT = 256 * 1024;

/** The CLI failed; `message` carries the tail of what it printed. */
export class SkillsCliError extends Error {}

/**
 * Runs `skills add <source>` in `projectDir`, which receives `.agents/skills/<name>/` for each
 * skill installed. The CLI is third-party code that reaches the network: it gets a minimal
 * environment (no server secrets, no provider keys, no Git credentials), a HOME of its own, no
 * telemetry, no prompts, and a hard time limit.
 */
export function runSkillsAdd(source: string, skills: string[], projectDir: string, homeDir: string): Promise<string> {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    // Windows needs these to start processes and resolve its temp directory.
    ...(process.platform === 'win32' && { SYSTEMROOT: process.env.SYSTEMROOT, COMSPEC: process.env.COMSPEC, PATHEXT: process.env.PATHEXT }),
    HOME: homeDir,
    USERPROFILE: homeDir,
    APPDATA: homeDir,
    XDG_CONFIG_HOME: homeDir,
    TMP: homeDir,
    TEMP: homeDir,
    TMPDIR: homeDir,
    DISABLE_TELEMETRY: '1',
    DO_NOT_TRACK: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(homeDir, '.gitconfig'),
    NO_COLOR: '1',
  };
  const args = [CLI, 'add', source, '--skill', skills.length ? skills.join(',') : '*', '--agent', 'opencode', '--yes', '--copy', '--json'];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { cwd: projectDir, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-MAX_OUTPUT);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => child.kill('SIGKILL'), SKILLS_CLI_TIMEOUT_MS);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(new SkillsCliError(`could not start the skills CLI: ${e.message}`));
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) return resolve(output);
      const why = signal ? `was stopped (${signal})` : `exited with ${code}`;
      reject(new SkillsCliError(`skills add ${why}: ${failureOf(output)}`));
    });
  });
}

/** The error the CLI reported in its JSON output, else the end of what it printed. */
export function failureOf(output: string): string {
  const errors = [...output.matchAll(/"error":\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => JSON.parse(`"${m[1]}"`));
  if (errors.length) return errors.join('; ');
  return output.trim().split('\n').slice(-5).join(' ').slice(-500) || 'no output';
}
