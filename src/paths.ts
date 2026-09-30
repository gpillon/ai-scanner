import { join } from 'node:path';

/** On-disk layout under the data directory. */
export const paths = {
  database: (dataDir: string) => join(dataDir, 'scanner.sqlite'),
  incoming: (dataDir: string) => join(dataDir, 'incoming'),
  artifacts: (dataDir: string) => join(dataDir, 'artifacts'),
  scanDir: (dataDir: string, id: string) => join(dataDir, 'scans', id),
  sourceArchive: (dataDir: string, id: string) => join(dataDir, 'scans', id, 'source.zip'),
  workspace: (dataDir: string, id: string) => join(dataDir, 'scans', id, 'workspace'),
  output: (dataDir: string, id: string) => join(dataDir, 'scans', id, 'output'),
  /** `report.pdf` as rendered by the server, before it is stored as an Artifact. */
  renderedPdf: (dataDir: string, id: string) => join(dataDir, 'scans', id, 'report.pdf'),
  transcript: (dataDir: string, id: string, attempt: number) =>
    join(dataDir, 'scans', id, 'attempts', String(attempt), 'transcript.log'),
};
