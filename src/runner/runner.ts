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
  /** Every `host:port` the Model Pool's models are served from: for a proxy all Scans share. */
  egress: string[];
  /** The `host:port` this Scan's model is served from: all a proxy of this Scan alone lets through. */
  modelEgress: string[];
  /** How long the supervisor lets the Attempt run: the Scan's own setting, or the server's. */
  attemptTimeoutMs: number;
  /** The Scan Profile's choice: false keeps the main agent to coordinating reviewers (ADR-0012). */
  leadReadsCode: boolean;
  /** Host directory the Scan's Preparation wrote, when its profile has one; the agent sees it, read-only, as `/prepared`. */
  preparedDir?: string;
  /** The Scan Profile's agent image variant (ADR-0016); absent: the agent image. */
  imageVariant?: string;
}

/**
 * The Scan Profile's Preparation (ADR-0015): its script, run once per Scan before any Attempt, in
 * the agent's isolation but without a model.
 */
export interface PreparationRequest {
  scanId: string;
  /** Host directory holding the Source Archive contents; the script sees it, read-only, as `/workspace`. */
  workspaceDir: string;
  /** Host directory the script writes into, empty at start; it sees it as `/prepared`. */
  preparedDir: string;
  /** The profile's `prepare/` directory, holding `run.sh`; the script sees it, read-only, as `/prepare`. */
  scriptDir: string;
  /** Host file the Runner writes the script's output to; kept for debugging, never served. */
  logPath: string;
  /** The `host:port` endpoints the profile lets its Scans reach: all its proxy lets through. */
  egress: string[];
  /** How long the supervisor lets it run: the Runner's own deadline is only a backstop. */
  timeoutMs: number;
  /** The Scan Profile's agent image variant (ADR-0016); absent: the agent image. */
  imageVariant?: string;
}

/**
 * The image an Attempt or a Preparation needs cannot be had: not built, not pushed, or not
 * derivable. Another Attempt would fail the same way, so the Scan fails at once.
 */
export class AgentImageUnavailableError extends Error {
  constructor(
    readonly image: string,
    detail: string,
  ) {
    super(`The agent image ${image} is not available: ${detail}`);
  }
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
  /** Provider-specific settings the model runs with (the Scan's model options), as opencode takes them. */
  options?: Record<string, unknown>;
}

export interface AttemptResult {
  /** A non-zero exit makes the Attempt one without valid output, whatever it wrote. */
  exitCode: number;
}

/**
 * Runs one Attempt of the agent, or a Scan's Preparation. Adapters: Podman/opencode, Kubernetes,
 * and a fake without any agent.
 */
export abstract class Runner {
  abstract run(request: AttemptRequest): Promise<AttemptResult>;
  /** Runs the Preparation's script; a non-zero exit fails the Scan. */
  abstract runPreparation(request: PreparationRequest): Promise<AttemptResult>;
  /**
   * Stops the running Attempt or Preparation of the Scan; the pending `run` or `runPreparation`
   * settles. No-op when none runs. The supervisor only calls them when the Scan has not been
   * cancelled, so they must register for `stop` before their first await.
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
  /** Runs no script: `/prepared` stays empty. */
  async runPreparation(request: PreparationRequest): Promise<AttemptResult> {
    await writeFile(request.logPath, 'fake Runner: no Preparation ran\n');
    return { exitCode: 0 };
  }
  async stop(): Promise<void> {}
}
