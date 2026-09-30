import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';
import { Scan, ScanState } from './scan.entity';

const emptyToUndefined = () => Transform(({ value }) => (value === '' ? undefined : value));

/** Multipart text fields of `POST /api/scan/<id>`; the Source Archive travels in field `file`. */
export class CreateScanDto {
  @ApiProperty({ description: 'Scan Profile name, e.g. `security`. See GET /api/profiles.' })
  @IsString()
  @IsNotEmpty()
  profile: string;

  @ApiPropertyOptional({ description: 'Model from the Model Pool. Defaults to the Default Model.' })
  @emptyToUndefined()
  @IsOptional()
  @IsString()
  model?: string;

  @ApiPropertyOptional({ description: 'Report language code, e.g. `en`, `it`. Defaults to the server default.' })
  @emptyToUndefined()
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/, { message: 'language must be a language code such as "en" or "pt-BR"' })
  language?: string;

  @ApiPropertyOptional({ description: 'Short free-text instructions to steer the analysis (length-limited).' })
  @emptyToUndefined()
  @IsOptional()
  @IsString()
  instructions?: string;
}

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

export class ProfileDto {
  @ApiProperty() name: string;
  @ApiProperty() description: string;
  @ApiProperty({ description: 'Whether Scans of this profile produce Findings (findings.json)' }) producesFindings: boolean;
}

export class ModelDto {
  @ApiProperty() id: string;
  @ApiProperty() provider: string;
  @ApiProperty({ description: 'True for the Default Model' }) default: boolean;
}
