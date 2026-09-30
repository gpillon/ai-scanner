import { Inject, Injectable } from '@nestjs/common';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { loadReportTemplate, ReportTemplate } from '../reports/report-template';

export interface ScanProfile {
  name: string;
  description: string;
  producesFindings: boolean;
  promptTemplate: string;
  /** Directory of the agent skills the profile brings, one `<skill>/SKILL.md` each; absent when it has none. */
  skillsDir?: string;
  /**
   * The Report template, when the profile has one (ADR-0005): the agent then writes only
   * `findings.json`, and the server fills `report.md` and `report.pdf` from it.
   */
  report?: ReportTemplate;
}

/** Server-owned Scan Profiles, loaded from `profiles/<name>/{profile.json,prompt.md,skills/,report/}` (ADR-0004). */
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
      this.profiles.set(meta.name, {
        name: meta.name,
        description: meta.description,
        producesFindings: Boolean(meta.producesFindings),
        promptTemplate: readFileSync(join(dir, 'prompt.md'), 'utf8'),
        skillsDir: existsSync(join(dir, 'skills')) ? join(dir, 'skills') : undefined,
        report,
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
