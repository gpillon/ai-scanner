import Ajv, { ValidateFunction } from 'ajv';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export const FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low', 'info'] as const;

/**
 * The Findings schema shared by every Scan Profile that produces Findings. Findings may carry
 * extra fields; the ones below are what callers can rely on.
 */
export const FINDINGS_SCHEMA = {
  $schema: 'http://json-schema.org/draft-07/schema#',
  title: 'Findings',
  type: 'object',
  required: ['findings'],
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        required: ['severity', 'title', 'description', 'location'],
        properties: {
          severity: { enum: FINDING_SEVERITIES },
          title: { type: 'string', minLength: 1 },
          description: { type: 'string', minLength: 1 },
          location: {
            type: 'object',
            required: ['file'],
            properties: {
              file: { type: 'string', minLength: 1, description: 'Path relative to the workspace root' },
              line: { type: 'integer', minimum: 1 },
            },
          },
        },
      },
    },
  },
} as const;

const validateFindings = new Ajv({ allErrors: true }).compile(FINDINGS_SCHEMA);

export type OutputCheck = { valid: true; artifacts: string[] } | { valid: false; reason: string };

async function readIfPresent(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR') return undefined;
    throw e;
  }
}

/** What the check needs to know of the Scan Profile. */
export interface OutputContract {
  producesFindings: boolean;
  /** The Report template's validator of `findings.json`, when the server fills the Report (ADR-0005). */
  report?: { validate: ValidateFunction };
}

/**
 * Checks, deterministically, that an Attempt left the Artifacts it must produce (ADR-0001):
 * a non-empty `report.md`, plus a `findings.json` valid against FINDINGS_SCHEMA when the Scan
 * Profile declares Findings. With a Report template the agent writes only `findings.json`, which
 * must also match the template's schema; `report.md` is then the server's to write. It judges
 * presence and structure only, never quality.
 */
export async function checkOutput(outputDir: string, contract: OutputContract): Promise<OutputCheck> {
  if (!contract.report) {
    const report = await readIfPresent(join(outputDir, 'report.md'));
    if (report === undefined) return { valid: false, reason: 'report.md is missing' };
    if (report.trim() === '') return { valid: false, reason: 'report.md is empty' };
    if (!contract.producesFindings) return { valid: true, artifacts: ['report.md'] };
  }

  const findings = await readIfPresent(join(outputDir, 'findings.json'));
  if (findings === undefined) return { valid: false, reason: 'findings.json is missing' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(findings);
  } catch {
    return { valid: false, reason: 'findings.json is not valid JSON' };
  }
  for (const [validate, schema] of [
    [validateFindings, 'the Findings schema'],
    [contract.report?.validate, "the Report template's schema"],
  ] as const) {
    if (validate && !validate(parsed)) {
      const errors = validate.errors!.map((e) => `${e.instancePath || '/'} ${e.message}`).join('; ');
      return { valid: false, reason: `findings.json does not match ${schema}: ${errors}` };
    }
  }
  return { valid: true, artifacts: ['report.md', 'findings.json'] };
}
