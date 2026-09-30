import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface AttemptRequest {
  scanId: string;
  attempt: number;
  /** Host directory holding the Source Archive contents; the agent sees it as `/workspace`. */
  workspaceDir: string;
  /** Host directory the agent writes Artifacts into; the agent sees it as `/output`. */
  outputDir: string;
  /** Host file the Runner writes the agent's transcript to; kept for debugging, never served. */
  transcriptPath: string;
  prompt: string;
  profile: string;
  /** The Scan Profile's skills directory, when it has one. */
  skillsDir?: string;
  /** Model Pool id. */
  model: string;
}

export interface AttemptResult {
  /** A non-zero exit makes the Attempt one without valid output, whatever it wrote. */
  exitCode: number;
}

/** Runs one Attempt of the agent. Adapters: Podman/opencode, and a fake without any agent. */
export abstract class Runner {
  abstract run(request: AttemptRequest): Promise<AttemptResult>;
  /**
   * Stops the running Attempt of the Scan; the pending `run` settles. No-op when none runs.
   * The supervisor only calls `run` when it has not been cancelled, so `run` must register
   * the Attempt for `stop` before its first await.
   */
  abstract stop(scanId: string): Promise<void>;
}

const PLACEHOLDER_REPORT =
  '# Placeholder Report\n\nThis Scan ran on the fake Runner: no agent looked at the code, and there are no Findings.\n';

/** The `fake` Runner: every Attempt writes a placeholder Report and no Findings, without any agent. */
export class PlaceholderRunner extends Runner {
  async run(request: AttemptRequest): Promise<AttemptResult> {
    await writeFile(request.transcriptPath, 'fake Runner: no agent ran\n');
    await writeFile(join(request.outputDir, 'report.md'), PLACEHOLDER_REPORT);
    await writeFile(join(request.outputDir, 'findings.json'), JSON.stringify({ findings: [] }));
    return { exitCode: 0 };
  }
  async stop(): Promise<void> {}
}
