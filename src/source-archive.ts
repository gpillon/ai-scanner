import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import yauzl, { Entry, ZipFile } from 'yauzl';

export interface ExtractionLimits {
  /** Total bytes written, counted as they are decompressed: declared sizes are not trusted. */
  maxBytes: number;
  /** Entries in the archive, files and directories alike. */
  maxFiles: number;
}

/** The Source Archive cannot be extracted safely; the Scan fails without running the agent. */
export class InvalidSourceArchiveError extends Error {}

/** Filesystem errors an entry's name or layout causes, rather than the server's disk. */
const ENTRY_ERROR_CODES = new Set(['EEXIST', 'EISDIR', 'ENOTDIR', 'EINVAL', 'ENAMETOOLONG']);

function openZip(path: string): Promise<ZipFile> {
  return new Promise((resolve, reject) =>
    yauzl.open(path, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (e, zip) =>
      e ? reject(e) : resolve(zip),
    ),
  );
}

function nextEntry(zip: ZipFile): Promise<Entry | undefined> {
  return new Promise((resolve, reject) => {
    const done = () => {
      zip.off('entry', onEntry).off('end', onEnd).off('error', onError);
    };
    const onEntry = (entry: Entry) => (done(), resolve(entry));
    const onEnd = () => (done(), resolve(undefined));
    const onError = (e: Error) => (done(), reject(e));
    zip.on('entry', onEntry).on('end', onEnd).on('error', onError);
    zip.readEntry();
  });
}

function openEntry(zip: ZipFile, entry: Entry): Promise<Readable> {
  return new Promise((resolve, reject) => zip.openReadStream(entry, (e, stream) => (e ? reject(e) : resolve(stream))));
}

/**
 * Where the entry lands under `root`. Names are read from the central directory and already
 * refused by yauzl when absolute, containing `..` or a backslash; `:` is refused too, as a
 * drive letter or an NTFS alternate data stream on Windows.
 */
function targetOf(root: string, name: string): string {
  if (name.includes(':')) throw new InvalidSourceArchiveError(`entry name is not allowed: ${name}`);
  const target = resolve(root, name);
  const rel = relative(root, target);
  if (rel.startsWith('..') || isAbsolute(rel)) throw new InvalidSourceArchiveError(`entry escapes the archive root: ${name}`);
  return target;
}

/**
 * Extracts the Source Archive into `root`, an empty directory, within `limits`. Every entry is
 * written as a plain file or directory: symlinks become files holding their target. Any problem
 * with the archive itself throws InvalidSourceArchiveError, leaving `root` partially filled.
 */
export async function extractSourceArchive(archivePath: string, root: string, limits: ExtractionLimits): Promise<void> {
  let zip: ZipFile;
  try {
    zip = await openZip(archivePath);
  } catch (e) {
    throw new InvalidSourceArchiveError((e as Error).message);
  }
  try {
    if (zip.entryCount > limits.maxFiles) {
      throw new InvalidSourceArchiveError(`it has ${zip.entryCount} entries, more than the limit of ${limits.maxFiles}`);
    }
    let written = 0;
    const counted = () =>
      new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          written += chunk.length;
          if (written > limits.maxBytes) {
            callback(new InvalidSourceArchiveError(`it extracts to more than the limit of ${limits.maxBytes} bytes`));
          } else callback(null, chunk);
        },
      });
    for (let entry = await nextEntry(zip); entry; entry = await nextEntry(zip)) {
      const target = targetOf(root, entry.fileName);
      if (entry.fileName.endsWith('/')) {
        await mkdir(target, { recursive: true });
        continue;
      }
      await mkdir(dirname(target), { recursive: true });
      await pipeline(await openEntry(zip, entry), counted(), createWriteStream(target));
    }
  } catch (e) {
    if (e instanceof InvalidSourceArchiveError) throw e;
    const code = (e as NodeJS.ErrnoException).code;
    // yauzl errors carry no code: they are all about the archive's structure or contents.
    if (code === undefined || ENTRY_ERROR_CODES.has(code)) throw new InvalidSourceArchiveError((e as Error).message);
    throw e;
  } finally {
    zip.close();
  }
}
