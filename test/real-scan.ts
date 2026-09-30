/**
 * What a Scan by a real model must show on the sample codebases: shared by the Podman smoke
 * tests and the e2e gate.
 */
import { readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { FINDING_SEVERITIES } from '../src/reports/output-validator';
import { filesUnder } from './harness';

export const VULNERABLE_APP = resolve(__dirname, 'fixtures', 'vulnerable-app');
/** The vulnerable app with every planted vulnerability fixed, and its legacy/ code gone. */
export const CLEAN_APP = resolve(__dirname, 'fixtures', 'clean-app');

export interface Finding {
  severity: (typeof FINDING_SEVERITIES)[number];
  title: string;
  category?: string;
  location: { file: string; line?: number };
}

/** A vulnerability planted in the sample codebase, and how to recognise the Finding reporting it (by `category`, or an English or Italian title). */
interface Planted {
  file: RegExp;
  line: number;
  kind: RegExp;
}

const PLANTED: Record<string, Planted> = {
  'SQL injection': { file: /^src\/server\.js$/, line: 15, kind: /sql/i },
  'command injection': { file: /^src\/server\.js$/, line: 20, kind: /comman|comand|shell|exec|rce/i },
  'path traversal': { file: /^src\/server\.js$/, line: 24, kind: /path|percors|traversal|file/i },
  'fallback JWT secret': { file: /^src\/(config|auth)\.js$/, line: 4, kind: /secret|segret|jwt|default|predefinit|credential|credenzial|hardcoded/i },
};

/** The Finding's file, relative to the workspace root as the Findings schema asks. */
export const findingFile = (f: Finding): string => f.location.file.replace(/^\.\//, '');

/** The planted vulnerabilities no Finding reports: each needs its own Finding, on its line (±3), of its kind. */
export function missedPlanted(findings: Finding[]): string[] {
  const unused = [...findings];
  return Object.entries(PLANTED)
    .filter(([, p]) => {
      const i = unused.findIndex(
        (f) =>
          p.file.test(findingFile(f)) &&
          f.location.line !== undefined &&
          Math.abs(f.location.line - p.line) <= 3 &&
          p.kind.test(`${f.category ?? ''} ${f.title}`),
      );
      if (i >= 0) unused.splice(i, 1);
      return i < 0;
    })
    .map(([name]) => name);
}

/** Findings a clean codebase must not have. */
export function highSeverity(findings: Finding[]): Finding[] {
  return findings.filter((f) => f.severity === 'critical' || f.severity === 'high');
}

/** Whether the text reads as Italian: enough words other Romance languages do not share. */
export function looksItalian(text: string): boolean {
  return (text.match(/\b(il|che|della|delle|degli|nella|sono|questo|questa)\b/gi)?.length ?? 0) > 10;
}

/** Every file under `dir`, keyed by its `/`-separated path relative to `dir`, for makeZip. */
export function fixtureFiles(dir: string): Record<string, string> {
  return Object.fromEntries(filesUnder(dir).map((path) => [relative(dir, path).split(sep).join('/'), readFileSync(path, 'utf8')]));
}
