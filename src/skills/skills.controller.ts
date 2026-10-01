import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req, UseInterceptors } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBearerAuth,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AdminOnly } from '../auth/admin-only.decorator';
import { ArchiveUploadInterceptor } from '../scans/archive-upload.interceptor';
import {
  CreateSkillPackDto,
  ImportResultDto,
  InstallSkillsDto,
  SkillDetailDto,
  SkillDto,
  SkillPackDto,
  UpdateSkillPackDto,
  UploadSkillsDto,
} from './dto/skills.dto';
import { ImportResult, SkillLibrary } from './skill-library.service';
import { SkillPacks } from './skill-packs.service';

/** What callers may add to a Scan. */
@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing or wrong bearer token' })
@Controller('api/skill-packs')
@ApiTags('discovery')
export class SkillPacksController {
  constructor(
    private readonly packs: SkillPacks,
    private readonly library: SkillLibrary,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List Skill Packs, which a Scan can add to its Scan Profile' })
  @ApiOkResponse({ type: [SkillPackDto] })
  async list(): Promise<SkillPackDto[]> {
    const library = await this.library.list();
    return (await this.packs.list()).map((p) => SkillPackDto.from(p, library));
  }
}

@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing or wrong bearer token' })
@AdminOnly()
@Controller('api/admin')
@ApiTags('admin')
export class AdminSkillsController {
  constructor(
    private readonly library: SkillLibrary,
    private readonly packs: SkillPacks,
  ) {}

  private async result(result: ImportResult): Promise<ImportResultDto> {
    const packs = await this.packs.list();
    return { imported: result.imported.map((s) => SkillDto.from(s, packs)) };
  }

  @Get('skills')
  @ApiOperation({ summary: 'The Skill Library' })
  @ApiOkResponse({ type: [SkillDto] })
  async list(): Promise<SkillDto[]> {
    const packs = await this.packs.list();
    return (await this.library.list()).map((s) => SkillDto.from(s, packs));
  }

  @Post('skills')
  @UseInterceptors(ArchiveUploadInterceptor)
  @ApiOperation({ summary: 'Import the skills of a zip: each a directory holding a SKILL.md' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file'],
      properties: { file: { type: 'string', format: 'binary' }, replace: { type: 'boolean' } },
    },
  })
  @ApiCreatedResponse({ type: ImportResultDto })
  @ApiConflictResponse({ description: 'The library already has a skill of that name' })
  async upload(@Body() body: UploadSkillsDto, @Req() req: { file?: { path: string; originalname: string } }): Promise<ImportResultDto> {
    if (!req.file) throw new BadRequestException('The zip is required (multipart field "file")');
    return this.result(await this.library.importArchive(req.file.path, req.file.originalname, body.replace ?? false));
  }

  @Post('skills/install')
  @ApiOperation({ summary: 'Import skills with `skills add <source>`, e.g. a GitHub owner/repo' })
  @ApiCreatedResponse({ type: ImportResultDto })
  @ApiConflictResponse({ description: 'The library already has a skill of that name' })
  @ApiBadGatewayResponse({ description: 'The skills CLI failed, or installed nothing' })
  async install(@Body() body: InstallSkillsDto): Promise<ImportResultDto> {
    return this.result(await this.library.importFromSource(body.source.trim(), body.skills ?? [], body.replace ?? false));
  }

  @Get('skills/:name')
  @ApiOperation({ summary: 'A skill, with its SKILL.md' })
  @ApiOkResponse({ type: SkillDetailDto })
  @ApiNotFoundResponse()
  async get(@Param('name') name: string): Promise<SkillDetailDto> {
    const skill = await this.library.get(name);
    return { ...SkillDto.from(skill, await this.packs.list()), instructions: await this.library.instructions(name) };
  }

  @Delete('skills/:name')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a skill that no Skill Pack uses' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  @ApiConflictResponse({ description: 'Skill Packs use it' })
  async remove(@Param('name') name: string): Promise<void> {
    await this.library.remove(name);
  }

  @Get('skill-packs')
  @ApiOperation({ summary: 'List Skill Packs' })
  @ApiOkResponse({ type: [SkillPackDto] })
  async listPacks(): Promise<SkillPackDto[]> {
    const library = await this.library.list();
    return (await this.packs.list()).map((p) => SkillPackDto.from(p, library));
  }

  @Post('skill-packs')
  @ApiOperation({ summary: 'Create a Skill Pack' })
  @ApiCreatedResponse({ type: SkillPackDto })
  @ApiConflictResponse({ description: 'A Skill Pack with this id exists' })
  async createPack(@Body() body: CreateSkillPackDto): Promise<SkillPackDto> {
    return SkillPackDto.from(await this.packs.create(body), await this.library.list());
  }

  @Patch('skill-packs/:id')
  @ApiOperation({ summary: "Change a Skill Pack's description or skills" })
  @ApiOkResponse({ type: SkillPackDto })
  @ApiNotFoundResponse()
  async updatePack(@Param('id') id: string, @Body() body: UpdateSkillPackDto): Promise<SkillPackDto> {
    return SkillPackDto.from(await this.packs.update(id, body), await this.library.list());
  }

  @Delete('skill-packs/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a Skill Pack; Scans that used it keep their copy' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async removePack(@Param('id') id: string): Promise<void> {
    await this.packs.remove(id);
  }
}
