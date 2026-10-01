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
  /** How the agent reaches that model. */
  agentModel: AgentModel;
  /** Every `host:port` the Model Pool's models are served from: what the agent may reach. */
  egress: string[];
}

/** A Model Pool model as the agent needs it. */
export interface AgentModel {
  /** The provider name opencode knows it by: the kind for built-in providers, else the Provider id. */
  provider: string;
  /** Whether opencode ships that provider, or serves it as OpenAI-compatible. */
  builtIn: boolean;
  /** The model's name at the provider. */
  name: string;
  baseUrl?: string;
  /** The key itself (from the DB): the Runner passes it as an environment variable, never as an argument. */
  apiKey?: string;
  /** Or the server environment variable holding it. */
  apiKeyEnv?: string;
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

const PLACEHOLDER_SUMMARY = 'This Scan ran on the fake Runner: no agent looked at the code, and there are no Findings.';
const PLACEHOLDER_REPORT = `# Placeholder Report\n\n${PLACEHOLDER_SUMMARY}\n`;

/**
 * The `fake` Runner: every Attempt writes a placeholder Report and no Findings, without any agent.
 * `findings.json` carries the same text as its summary, for profiles with a Report template.
 */
export class PlaceholderRunner extends Runner {
  async run(request: AttemptRequest): Promise<AttemptResult> {
    await writeFile(request.transcriptPath, 'fake Runner: no agent ran\n');
    await writeFile(join(request.outputDir, 'report.md'), PLACEHOLDER_REPORT);
    await writeFile(join(request.outputDir, 'findings.json'), JSON.stringify({ report: { summary: PLACEHOLDER_SUMMARY }, findings: [] }));
    return { exitCode: 0 };
  }
  async stop(): Promise<void> {}
}
