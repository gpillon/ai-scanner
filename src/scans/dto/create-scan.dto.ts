import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsNotEmpty, IsOptional, IsString, Matches } from 'class-validator';

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
