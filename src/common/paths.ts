import { join } from 'node:path';

/** On-disk layout under the data directory. */
export const paths = {
  database: (dataDir: string) => join(dataDir, 'scanner.sqlite'),
  incoming: (dataDir: string) => join(dataDir, 'incoming'),
  artifacts: (dataDir: string) => join(dataDir, 'artifacts'),
  /** Mounted read-only into the egress proxy: `allow.txt` is its allow list, read at runtime. */
  egress: (dataDir: string) => join(dataDir, 'egress'),
  /** The Skill Library: one `<skill>/SKILL.md` directory per imported skill (ADR-0008). */
  skills: (dataDir: string) => join(dataDir, 'skills'),
  /** Imports in progress, on the same volume as the library so they move into place by renaming. */
  skillImports: (dataDir: string) => join(dataDir, 'skill-imports'),
  scanDir: (dataDir: string, id: string) => join(dataDir, 'scans', id),
  /** A Scan's own copy of the skills it runs with, when it adds Skill Packs to its profile's. */
  scanSkills: (dataDir: string, id: string) => join(dataDir, 'scans', id, 'skills'),
  sourceArchive: (dataDir: string, id: string) => join(dataDir, 'scans', id, 'source.zip'),
  workspace: (dataDir: string, id: string) => join(dataDir, 'scans', id, 'workspace'),
  output: (dataDir: string, id: string) => join(dataDir, 'scans', id, 'output'),
  /** `report.pdf` as rendered by the server, before it is stored as an Artifact. */
  renderedPdf: (dataDir: string, id: string) => join(dataDir, 'scans', id, 'report.pdf'),
  /** What the model warm-up did, one JSON line per step: the Scan's activity before Attempt 1. */
  warmupLog: (dataDir: string, id: string) => join(dataDir, 'scans', id, 'warmup.log'),
  transcript: (dataDir: string, id: string, attempt: number) =>
    join(dataDir, 'scans', id, 'attempts', String(attempt), 'transcript.log'),
};
