import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { TokenUsage } from '../../runner/usage';
import { Scan, ScanSource, ScanState } from '../entities/scan.entity';

export class ScanStatusDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: ['queued', 'warming', 'running', 'succeeded', 'failed'] }) state: ScanState;
  @ApiProperty() profile: string;
  @ApiProperty() model: string;
  @ApiProperty() language: string;
  @ApiProperty({ description: 'Number of Attempts made so far' }) attempts: number;
  @ApiProperty() createdAt: string;
  @ApiProperty({ nullable: true, type: String }) startedAt: string | null;
  @ApiProperty({ nullable: true, type: String }) finishedAt: string | null;
  @ApiPropertyOptional({ description: 'Present when the Scan failed' }) failureReason?: string;
  @ApiPropertyOptional({ type: [String], description: 'Present when the Scan succeeded' }) artifacts?: string[];
  @ApiPropertyOptional({
    description: 'The Skill Packs it runs with, and the skills each gave it (name, sha256 of its files)',
    example: [{ id: 'java', skills: [{ name: 'spring-security', hash: '…' }] }],
  })
  skillPacks?: { id: string; skills: { name: string; hash: string }[] }[];
  @ApiPropertyOptional({
    description: 'When the code came from a Git repository: its URL (never with credentials), the ref asked for (null: default branch) and the commit',
    example: { type: 'git', url: 'https://github.com/acme/app.git', ref: 'main', commit: '…' },
  })
  source?: ScanSource;
  @ApiPropertyOptional({
    description:
      'Tokens the agent used, summed over its Attempts and every subagent session: input, output, reasoning, cache reads and writes, ' +
      'their total, the cost the provider reports (0 when none), and the number of agent sessions. Present once an Attempt has reported it.',
    example: { input: 12000, output: 3400, reasoning: 0, cacheRead: 180000, cacheWrite: 0, total: 195400, cost: 0, sessions: 4 },
  })
  usage?: TokenUsage;

  static from(scan: Scan, artifacts: string[]): ScanStatusDto {
    return {
      id: scan.id,
      state: scan.state,
      profile: scan.profile,
      model: scan.model,
      language: scan.language,
      attempts: scan.attempts,
      createdAt: scan.createdAt,
      startedAt: scan.startedAt,
      finishedAt: scan.finishedAt,
      ...(scan.source && { source: scan.source }),
      ...(scan.usage && { usage: scan.usage }),
      ...(scan.skillPacks?.length && {
        skillPacks: scan.skillPacks.map((p) => ({ id: p.id, skills: p.skills.map(({ name, hash }) => ({ name, hash })) })),
      }),
      ...(scan.state === 'failed' && { failureReason: scan.failureReason ?? undefined }),
      ...(scan.state === 'succeeded' && { artifacts }),
    };
  }
}
