import { Inject, Injectable } from '@nestjs/common';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { APP_CONFIG, AppConfig, MINUTE_MS } from '../config/app-config';
import { loadReportTemplate, ReportTemplate } from '../reports/report-template';

/** The Preparation's entry point, in the profile's `prepare/` directory (ADR-0015). */
export const PREPARATION_SCRIPT = 'run.sh';
/** How long a Preparation may run when the profile does not say. */
const DEFAULT_PREPARATION_TIMEOUT_MINUTES = 30;

export interface ScanProfile {
  name: string;
  description: string;
  producesFindings: boolean;
  /**
   * Whether the main agent may read the code itself. False makes it a lead that only maps the
   * codebase and coordinates `reviewer` subagents, which do all the reading (ADR-0012).
   */
  leadReadsCode: boolean;
  promptTemplate: string;
  /** Directory of the agent skills the profile brings, one `<skill>/SKILL.md` each; absent when it has none. */
  skillsDir?: string;
  /**
   * The Report template, when the profile has one (ADR-0005): the agent then writes only
   * `findings.json`, and the server fills `report.md` and `report.pdf` from it.
   */
  report?: ReportTemplate;
  /** The profile's Preparation, when it has one: its `prepare/` directory, holding `run.sh` (ADR-0015). */
  preparation?: { dir: string; timeoutMs: number };
  /**
   * The `host:port` endpoints its Scans may reach besides the model (`egressAllow`), in the
   * Preparation and in every Attempt (ADR-0015).
   */
  egress: string[];
  /**
   * The agent image variant its Preparation and Attempts run in (`agentImage`, e.g. `full`): the
   * server's agent image with `-<variant>` added to its repository, same tag (ADR-0016). Absent:
   * the agent image itself.
   */
  imageVariant?: string;
}

/** A variant name, as it goes into an image repository name. */
const IMAGE_VARIANT = /^[a-z0-9]+([._-][a-z0-9]+)*$/;

const HOSTNAME = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** `host` or `host:port` from `egressAllow` as the egress proxy compares it: `host:port`, 443 by default. */
export function egressEndpoint(entry: unknown): string {
  const match = typeof entry === 'string' ? /^([^:]+)(?::(\d{1,5}))?$/.exec(entry.trim().toLowerCase()) : null;
  const port = Number(match?.[2] ?? 443);
  if (!match || !HOSTNAME.test(match[1]) || port < 1 || port > 65535) {
    throw new Error(`egressAllow: ${JSON.stringify(entry)} is not a host name, with an optional port`);
  }
  return `${match[1]}:${port}`;
}

function preparationOf(dir: string, meta: any): ScanProfile['preparation'] {
  const prepareDir = join(dir, 'prepare');
  if (!existsSync(join(prepareDir, PREPARATION_SCRIPT))) {
    if (meta.prepareTimeoutMinutes !== undefined) throw new Error(`prepareTimeoutMinutes needs a prepare/${PREPARATION_SCRIPT}`);
    return undefined;
  }
  const minutes = meta.prepareTimeoutMinutes ?? DEFAULT_PREPARATION_TIMEOUT_MINUTES;
  if (typeof minutes !== 'number' || !(minutes > 0)) throw new Error('prepareTimeoutMinutes must be a positive number');
  return { dir: prepareDir, timeoutMs: minutes * MINUTE_MS };
}

/**
 * Server-owned Scan Profiles, loaded from `profiles/<name>/{profile.json,prompt.md,skills/,report/,prepare/}`
 * (ADR-0004). Each is checked here, so a broken profile stops the server at start-up.
 */
@Injectable()
export class ProfileRegistry {
  private readonly profiles = new Map<string, ScanProfile>();

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    for (const entry of readdirSync(config.profilesDir, { withFileTypes: true })) {
      const dir = join(config.profilesDir, entry.name);
      if (!entry.isDirectory() || !existsSync(join(dir, 'profile.json'))) continue;
      const meta = JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf8'));
      const report = loadReportTemplate(join(dir, 'report'));
      if (report && !meta.producesFindings) {
        throw new Error(`Scan Profile ${meta.name}: a Report template is filled from findings.json, so it needs producesFindings`);
      }
      if (meta.egressAllow !== undefined && !Array.isArray(meta.egressAllow)) {
        throw new Error(`Scan Profile ${meta.name}: egressAllow must be a list of host names`);
      }
      if (meta.agentImage !== undefined && (typeof meta.agentImage !== 'string' || !IMAGE_VARIANT.test(meta.agentImage))) {
        throw new Error(
          `Scan Profile ${meta.name}: agentImage ${JSON.stringify(meta.agentImage)} is not a variant name such as "full" ` +
            '(lower-case letters and digits, with ".", "_" or "-" between them)',
        );
      }
      let preparation: ScanProfile['preparation'];
      let egress: string[];
      try {
        preparation = preparationOf(dir, meta);
        egress = [...new Set<string>((meta.egressAllow ?? []).map(egressEndpoint))];
      } catch (e) {
        throw new Error(`Scan Profile ${meta.name}: ${(e as Error).message}`);
      }
      this.profiles.set(meta.name, {
        name: meta.name,
        description: meta.description,
        producesFindings: Boolean(meta.producesFindings),
        leadReadsCode: meta.leadReadsCode !== false,
        promptTemplate: readFileSync(join(dir, 'prompt.md'), 'utf8'),
        skillsDir: existsSync(join(dir, 'skills')) ? join(dir, 'skills') : undefined,
        report,
        preparation,
        egress,
        imageVariant: meta.agentImage,
      });
    }
  }

  list(): ScanProfile[] {
    return [...this.profiles.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  get(name: string): ScanProfile | undefined {
    return this.profiles.get(name);
  }
}
