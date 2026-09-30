export interface AttemptRequest {
  scanId: string;
  attempt: number;
  /** Host directory holding the Source Archive contents; the agent sees it as `/workspace`. */
  workspaceDir: string;
  /** Host directory the agent writes Artifacts into; the agent sees it as `/output`. */
  outputDir: string;
  prompt: string;
  profile: string;
  model: string;
}

export interface AttemptResult {
  exitCode: number;
}

/** Runs one Attempt of the agent. Adapters: Podman/opencode (later), a fake in tests. */
export abstract class Runner {
  abstract run(request: AttemptRequest): Promise<AttemptResult>;
  /**
   * Stops the running Attempt of the Scan; the pending `run` settles. No-op when none runs.
   * The supervisor only calls `run` when it has not been cancelled, so `run` must register
   * the Attempt for `stop` before its first await.
   */
  abstract stop(scanId: string): Promise<void>;
}

/** Placeholder until the Podman/opencode Runner exists. Every Attempt fails. */
export class UnconfiguredRunner extends Runner {
  async run(): Promise<AttemptResult> {
    throw new Error('No Runner configured');
  }
  async stop(): Promise<void> {}
}
