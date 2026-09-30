import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Scan, ScanState } from '../entities/scan.entity';

export class ScanStatusDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: ['queued', 'running', 'succeeded', 'failed'] }) state: ScanState;
  @ApiProperty() profile: string;
  @ApiProperty() model: string;
  @ApiProperty() language: string;
  @ApiProperty({ description: 'Number of Attempts made so far' }) attempts: number;
  @ApiProperty() createdAt: string;
  @ApiProperty({ nullable: true, type: String }) startedAt: string | null;
  @ApiProperty({ nullable: true, type: String }) finishedAt: string | null;
  @ApiPropertyOptional({ description: 'Present when the Scan failed' }) failureReason?: string;
  @ApiPropertyOptional({ type: [String], description: 'Present when the Scan succeeded' }) artifacts?: string[];

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
      ...(scan.state === 'failed' && { failureReason: scan.failureReason ?? undefined }),
      ...(scan.state === 'succeeded' && { artifacts }),
    };
  }
}
