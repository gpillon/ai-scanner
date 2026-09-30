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
};
