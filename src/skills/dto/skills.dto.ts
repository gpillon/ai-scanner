import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { ArrayNotEmpty, IsArray, IsBoolean, IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { LibrarySkill } from '../entities/library-skill.entity';
import { SkillPack } from '../entities/skill-pack.entity';

/** Multipart booleans arrive as strings. */
const booleanField = () => Transform(({ value }) => value === true || value === 'true' || value === '1');

export class SkillDto {
  @ApiProperty() name: string;
  @ApiProperty() description: string;
  @ApiProperty({ description: '`upload:<file>`, or the `skills add` source' }) source: string;
  @ApiProperty({ description: 'sha256 of its files' }) hash: string;
  @ApiProperty() files: number;
  @ApiProperty() bytes: number;
  @ApiProperty() importedAt: string;
  @ApiProperty({ type: [String], description: 'Skill Packs it is in' }) packs: string[];

  static from(s: LibrarySkill, packs: SkillPack[]): SkillDto {
    return {
      name: s.name,
      description: s.description,
      source: s.source,
      hash: s.hash,
      files: s.files,
      bytes: s.bytes,
      importedAt: s.importedAt,
      packs: packs.filter((p) => p.skills.includes(s.name)).map((p) => p.id),
    };
  }
}

export class SkillDetailDto extends SkillDto {
  @ApiProperty({ description: 'Its SKILL.md' }) instructions: string;
}

export class UploadSkillsDto {
  @ApiPropertyOptional({ description: 'Replace skills the library already has' })
  @booleanField()
  @IsOptional()
  @IsBoolean()
  replace?: boolean;
}

export class InstallSkillsDto {
  @ApiProperty({ description: 'What `skills add` takes: `owner/repo`, a Git or GitHub tree URL, ...' })
  @IsString()
  @IsNotEmpty()
  source: string;

  @ApiPropertyOptional({ type: [String], description: 'Only these skills of the source; all of them by default' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  skills?: string[];

  @ApiPropertyOptional({ description: 'Replace skills the library already has' })
  @IsOptional()
  @IsBoolean()
  replace?: boolean;
}

export class ImportResultDto {
  @ApiProperty({ type: [SkillDto] }) imported: SkillDto[];
}

export class CreateSkillPackDto {
  @ApiProperty({ description: 'Lowercase letters, digits and dashes, e.g. `java`' })
  @IsString()
  @IsNotEmpty()
  id: string;

  @ApiProperty() @IsString() description: string;

  @ApiProperty({ type: [String], description: 'Skill Library names' })
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  skills: string[];
}

export class UpdateSkillPackDto {
  @ApiPropertyOptional() @IsOptional() @IsString() description?: string;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayNotEmpty()
  @IsString({ each: true })
  skills?: string[];
}

export class PackSkillDto {
  @ApiProperty() name: string;
  @ApiProperty() description: string;
}

export class SkillPackDto {
  @ApiProperty() id: string;
  @ApiProperty() description: string;
  @ApiProperty({ type: [PackSkillDto] }) skills: PackSkillDto[];

  static from(p: SkillPack, library: LibrarySkill[]): SkillPackDto {
    const byName = new Map(library.map((s) => [s.name, s]));
    return { id: p.id, description: p.description, skills: p.skills.map((name) => ({ name, description: byName.get(name)?.description ?? '' })) };
  }
}
