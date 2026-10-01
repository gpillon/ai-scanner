import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsArray, IsInt, IsNotEmpty, IsOptional, IsString, Matches, Max, Min } from 'class-validator';

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

  @ApiPropertyOptional({
    type: [String],
    description: 'Skill Packs to add to the Scan Profile, see GET /api/skill-packs: comma-separated, or the field repeated.',
  })
  @Transform(({ value }) =>
    value === undefined || value === ''
      ? undefined
      : (Array.isArray(value) ? value : [value]).flatMap((v: unknown) => String(v).split(',')).map((v: string) => v.trim()).filter(Boolean),
  )
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  skillPacks?: string[];

  @ApiPropertyOptional({ description: 'Instead of `file`: the https URL of a Git repository to scan (ADR-0010). Never put credentials in it.' })
  @emptyToUndefined()
  @IsOptional()
  @IsString()
  repoUrl?: string;

  @ApiPropertyOptional({
    description: 'Instead of `file` or repoUrl: a Saved Repository (ADR-0014), fetched with its stored credentials; one with a stored token needs the admin token. See GET /api/repositories.',
  })
  @emptyToUndefined()
  @IsOptional()
  @IsString()
  repository?: string;

  @ApiPropertyOptional({ description: "With repoUrl or repository: the branch or tag. Defaults to the Saved Repository's ref, else the default branch. See POST /api/git/refs." })
  @emptyToUndefined()
  @IsOptional()
  @IsString()
  ref?: string;

  @ApiPropertyOptional({ description: 'With repoUrl, for a private repository: the username; defaults to `oauth2`.' })
  @emptyToUndefined()
  @IsOptional()
  @IsString()
  gitUsername?: string;

  @ApiPropertyOptional({ description: 'With repoUrl, for a private repository: a token or password. Used for this one fetch, never stored.' })
  @emptyToUndefined()
  @IsOptional()
  @IsString()
  gitToken?: string;

  @ApiPropertyOptional({
    description:
      'Minutes each Attempt may run before it is stopped, 1 to 1440. Defaults to the server setting ' +
      '(SCANNER_ATTEMPT_TIMEOUT_MINUTES). The server-wide Scan timeout still applies.',
  })
  @Transform(({ value }) => (value === undefined || value === '' ? undefined : Number(value)))
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1440)
  attemptTimeoutMinutes?: number;

  @ApiPropertyOptional({ description: 'Short free-text instructions to steer the analysis (length-limited).' })
  @emptyToUndefined()
  @IsOptional()
  @IsString()
  instructions?: string;
}
