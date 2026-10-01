import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, ValidateIf } from 'class-validator';
import { SavedRepository } from '../entities/saved-repository.entity';

export class CreateRepositoryDto {
  @ApiProperty({ description: 'What Scans and Scan Schedules pass in `repository`: lowercase letters, digits and dashes' })
  @IsString()
  @IsNotEmpty()
  id: string;

  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;

  @ApiProperty({ description: 'https URL of the Git repository, without credentials' })
  @IsString()
  @IsNotEmpty()
  url: string;

  @ApiPropertyOptional({ description: 'Branch or tag Scans check out unless they say otherwise; the default branch otherwise' })
  @IsOptional()
  @IsString()
  ref?: string;

  @ApiPropertyOptional({ description: 'For a private repository; defaults to `oauth2`' })
  @IsOptional()
  @IsString()
  username?: string;

  @ApiPropertyOptional({ description: 'Token or password of a private repository; admin token only. Stored sealed with SCANNER_SECRET_KEY, never sent back' })
  @IsOptional()
  @IsString()
  token?: string;
}

export class UpdateRepositoryDto {
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;
  @ApiPropertyOptional() @IsOptional() @IsString() @IsNotEmpty() url?: string;

  @ApiPropertyOptional({ nullable: true, type: String, description: '`null`: the default branch' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  ref?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  username?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, description: 'A new token; `null` removes the stored one' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  token?: string | null;
}

export class RepositoryDto {
  @ApiProperty() id: string;
  @ApiProperty() description: string;
  @ApiProperty() url: string;
  @ApiProperty({ nullable: true, type: String, description: 'null: the default branch' }) ref: string | null;
  @ApiProperty({ nullable: true, type: String }) username: string | null;
  @ApiProperty({ description: 'Whether a token is stored' }) tokenSet: boolean;
  @ApiProperty({ nullable: true, type: String, description: "The token's last characters" }) tokenHint: string | null;
  @ApiProperty() createdAt: string;

  static from(r: SavedRepository): RepositoryDto {
    return {
      id: r.id,
      description: r.description,
      url: r.url,
      ref: r.ref,
      username: r.username,
      tokenSet: Boolean(r.tokenSealed),
      tokenHint: r.tokenHint,
      createdAt: r.createdAt,
    };
  }
}
