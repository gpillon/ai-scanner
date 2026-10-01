import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayNotEmpty, IsArray, IsBoolean, IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, Min, ValidateIf } from 'class-validator';
import { ScanSchedule } from '../entities/scan-schedule.entity';
import { Cadence, CADENCES } from '../schedule-timing';

const LANGUAGE = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;
const LANGUAGE_MESSAGE = 'language must be a language code such as "en" or "pt-BR"';
/** Lets a PATCH field be `null`, to clear it. */
const nullable = () => ValidateIf((_o, v) => v !== null);

export class CreateScheduleDto {
  @ApiProperty({ description: 'Lowercase letters, digits and dashes, at most 48; its Scans are named `<id>-<yyyymmdd>-<hhmmss>` (UTC)' })
  @IsString()
  @IsNotEmpty()
  id: string;

  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;

  @ApiProperty({ description: 'The Saved Repository to scan, see GET /api/repositories' })
  @IsString()
  @IsNotEmpty()
  repository: string;

  @ApiPropertyOptional({ description: "Branch or tag; the repository's own otherwise" }) @IsOptional() @IsString() ref?: string;

  @ApiProperty({ description: 'Scan Profile name, see GET /api/profiles' }) @IsString() @IsNotEmpty() profile: string;

  @ApiPropertyOptional({ description: 'Model from the Model Pool; the Default Model when each Scan starts otherwise' })
  @IsOptional()
  @IsString()
  model?: string;

  @ApiPropertyOptional({ description: 'Report language code; the server default otherwise' })
  @IsOptional()
  @IsString()
  @Matches(LANGUAGE, { message: LANGUAGE_MESSAGE })
  language?: string;

  @ApiPropertyOptional() @IsOptional() @IsString() instructions?: string;

  @ApiPropertyOptional({ type: [String], description: 'Skill Packs to add, see GET /api/skill-packs' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  skillPacks?: string[];

  @ApiPropertyOptional({ description: 'Minutes each Attempt may run, 1 to 1440; the server setting otherwise' })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  attemptTimeoutMinutes?: number;

  @ApiProperty({ enum: CADENCES, description: '`interval`: every intervalHours; `daily`: at time; `weekly`: at time on weekdays' })
  @IsIn(CADENCES)
  cadence: Cadence;

  @ApiPropertyOptional({ description: 'With cadence `interval`: hours between two Scans, 1 to 720' }) @IsOptional() @IsInt() intervalHours?: number;

  @ApiPropertyOptional({ description: 'With cadence `daily` or `weekly`: `HH:MM` in timeZone', example: '02:30' })
  @IsOptional()
  @IsString()
  time?: string;

  @ApiPropertyOptional({ type: [Number], description: 'With cadence `weekly`: days, 0 (Sunday) to 6' })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsInt({ each: true })
  weekdays?: number[];

  @ApiPropertyOptional({ description: 'IANA time zone of `time`, e.g. `Europe/Rome`; `UTC` otherwise' })
  @IsOptional()
  @IsString()
  timeZone?: string;

  @ApiPropertyOptional({ description: 'Defaults to true' }) @IsOptional() @IsBoolean() enabled?: boolean;
}

export class UpdateScheduleDto {
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @IsNotEmpty() repository?: string;
  @ApiPropertyOptional({ nullable: true, type: String, description: "`null`: the repository's own" }) @IsOptional() @nullable() @IsString() ref?: string | null;
  @ApiPropertyOptional() @IsOptional() @IsString() @IsNotEmpty() profile?: string;
  @ApiPropertyOptional({ nullable: true, type: String, description: '`null`: the Default Model' }) @IsOptional() @nullable() @IsString() model?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @nullable()
  @IsString()
  @Matches(LANGUAGE, { message: LANGUAGE_MESSAGE })
  language?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String }) @IsOptional() @nullable() @IsString() instructions?: string | null;

  @ApiPropertyOptional({ nullable: true, type: [String] })
  @IsOptional()
  @nullable()
  @IsArray()
  @IsString({ each: true })
  skillPacks?: string[] | null;

  @ApiPropertyOptional({ nullable: true, type: Number })
  @IsOptional()
  @nullable()
  @IsInt()
  @Min(1)
  @Max(1440)
  attemptTimeoutMinutes?: number | null;

  @ApiPropertyOptional({ enum: CADENCES }) @IsOptional() @IsIn(CADENCES) cadence?: Cadence;
  @ApiPropertyOptional() @IsOptional() @IsInt() intervalHours?: number;
  @ApiPropertyOptional() @IsOptional() @IsString() time?: string;
  @ApiPropertyOptional({ type: [Number] }) @IsOptional() @IsArray() @ArrayNotEmpty() @IsInt({ each: true }) weekdays?: number[];
  @ApiPropertyOptional() @IsOptional() @IsString() timeZone?: string;
  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;
}

export class ScheduleDto {
  @ApiProperty() id: string;
  @ApiProperty() description: string;
  @ApiProperty() repository: string;
  @ApiProperty({ nullable: true, type: String }) ref: string | null;
  @ApiProperty() profile: string;
  @ApiProperty({ nullable: true, type: String }) model: string | null;
  @ApiProperty({ nullable: true, type: String }) language: string | null;
  @ApiProperty({ nullable: true, type: String }) instructions: string | null;
  @ApiProperty({ type: [String] }) skillPacks: string[];
  @ApiProperty({ nullable: true, type: Number }) attemptTimeoutMinutes: number | null;
  @ApiProperty({ enum: CADENCES }) cadence: Cadence;
  @ApiProperty({ nullable: true, type: Number }) intervalHours: number | null;
  @ApiProperty({ nullable: true, type: String }) time: string | null;
  @ApiProperty({ nullable: true, type: [Number] }) weekdays: number[] | null;
  @ApiProperty() timeZone: string;
  @ApiProperty() enabled: boolean;
  @ApiProperty({ nullable: true, type: String, description: 'When it starts its next Scan; null while disabled' }) nextRunAt: string | null;
  @ApiProperty({ nullable: true, type: String }) lastRunAt: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'The last Scan it started; it may since have been deleted' }) lastScanId: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Why its last run started no Scan' }) lastError: string | null;
  @ApiProperty() createdAt: string;

  static from(s: ScanSchedule): ScheduleDto {
    return {
      id: s.id,
      description: s.description,
      repository: s.repository,
      ref: s.ref,
      profile: s.profile,
      model: s.model,
      language: s.language,
      instructions: s.instructions,
      skillPacks: s.skillPacks ?? [],
      attemptTimeoutMinutes: s.attemptTimeoutMinutes,
      cadence: s.cadence,
      intervalHours: s.intervalHours,
      time: s.time,
      weekdays: s.weekdays,
      timeZone: s.timeZone,
      enabled: s.enabled,
      nextRunAt: s.nextRunAt,
      lastRunAt: s.lastRunAt,
      lastScanId: s.lastScanId,
      lastError: s.lastError,
      createdAt: s.createdAt,
    };
  }
}
