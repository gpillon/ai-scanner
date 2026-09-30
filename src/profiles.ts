import { Inject, Injectable } from '@nestjs/common';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { APP_CONFIG, AppConfig } from './config';

export interface ScanProfile {
  name: string;
  description: string;
  producesFindings: boolean;
  promptTemplate: string;
}

/** Server-owned Scan Profiles, loaded from `profiles/<name>/{profile.json,prompt.md}` (ADR-0004). */
@Injectable()
export class ProfileRegistry {
  private readonly profiles = new Map<string, ScanProfile>();

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    for (const entry of readdirSync(config.profilesDir, { withFileTypes: true })) {
      const dir = join(config.profilesDir, entry.name);
      if (!entry.isDirectory() || !existsSync(join(dir, 'profile.json'))) continue;
      const meta = JSON.parse(readFileSync(join(dir, 'profile.json'), 'utf8'));
      this.profiles.set(meta.name, {
        name: meta.name,
        description: meta.description,
        producesFindings: Boolean(meta.producesFindings),
        promptTemplate: readFileSync(join(dir, 'prompt.md'), 'utf8'),
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
