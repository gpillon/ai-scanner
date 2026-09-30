import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';

export abstract class ArtifactStore {
  /** Stores a local file as the Scan's Artifact `name`. */
  abstract put(scanId: string, name: string, sourcePath: string): Promise<void>;
  abstract list(scanId: string): Promise<string[]>;
  abstract stream(scanId: string, name: string): Readable;
  abstract delete(scanId: string): Promise<void>;
}

export class LocalFolderArtifactStore extends ArtifactStore {
  constructor(private readonly root: string) {
    super();
  }

  private dir(scanId: string): string {
    return join(this.root, scanId);
  }

  async put(scanId: string, name: string, sourcePath: string): Promise<void> {
    await mkdir(this.dir(scanId), { recursive: true });
    await copyFile(sourcePath, join(this.dir(scanId), name));
  }

  async list(scanId: string): Promise<string[]> {
    try {
      return (await readdir(this.dir(scanId))).sort();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw e;
    }
  }

  stream(scanId: string, name: string): Readable {
    return createReadStream(join(this.dir(scanId), name));
  }

  async delete(scanId: string): Promise<void> {
    await rm(this.dir(scanId), { recursive: true, force: true });
  }
}
