import { BadGatewayException, BadRequestException, Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { paths } from '../common/paths';
import { APP_CONFIG, AppConfig } from '../config/app-config';
import { checkRef, checkRepoUrl, fetchSource, GitCredentials, GitFetchError, GitRefs, GitSourceError, listRefs } from './git-source';

/**
 * Scans whose source is a Git repository (ADR-0010): the refs a caller can choose from, and the
 * checkout a Scan runs on. Credentials only ever live in memory, for the one git command.
 */
@Injectable()
export class GitSources {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  async refs(repoUrl: string, credentials: GitCredentials): Promise<GitRefs> {
    return this.translate(async () => {
      const url = await checkRepoUrl(repoUrl, this.config.git, Boolean(credentials.token));
      return listRefs(url, credentials, this.config.git, join(paths.incoming(this.config.dataDir), `git-${randomUUID()}`));
    });
  }

  /** The URL as it would be stored, once checked like a fetch checks it; a 400 otherwise. */
  async checkUrl(repoUrl: string, withCredentials: boolean): Promise<string> {
    return this.translate(async () => (await checkRepoUrl(repoUrl, this.config.git, withCredentials)).href);
  }

  /** A branch or tag name checked like a fetch checks it; a 400 otherwise. */
  checkRefName(ref: string | null): string | null {
    try {
      return ref === null ? null : checkRef(ref);
    } catch (e) {
      throw e instanceof GitSourceError ? new BadRequestException(e.message) : e;
    }
  }

  /** Checks out `ref`, or the default branch, into `target`; returns the URL as stored and the commit. */
  async fetch(repoUrl: string, ref: string | undefined, credentials: GitCredentials, target: string): Promise<{ url: string; commit: string }> {
    return this.translate(async () => {
      const url = await checkRepoUrl(repoUrl, this.config.git, Boolean(credentials.token));
      const fetched = await fetchSource(url, ref ? checkRef(ref) : undefined, credentials, this.config.git, target, {
        maxFiles: this.config.maxExtractedFiles,
        maxBytes: this.config.maxExtractedBytes,
      });
      return { url: url.href, commit: fetched.commit };
    });
  }

  private async translate<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (e) {
      if (e instanceof GitSourceError) throw new BadRequestException(e.message);
      if (e instanceof GitFetchError) {
        if (e.authFailed) {
          throw new BadRequestException(`The repository refused access: check the URL and the credentials (${e.message})`);
        }
        throw new BadGatewayException(`Cannot read the repository: ${e.message}`);
      }
      throw e;
    }
  }
}
