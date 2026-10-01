import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { AuthenticatedRequest } from '../auth/bearer.guard';
import { GitRefsDto } from '../scans/git.controller';
import { CreateRepositoryDto, RepositoryDto, UpdateRepositoryDto } from './dto/repository.dto';
import { SavedRepositories } from './saved-repositories.service';

@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing or wrong bearer token' })
@Controller('api/repositories')
@ApiTags('repositories')
@ApiForbiddenResponse({ description: 'A private repository (with a stored token) needs the admin token' })
export class RepositoriesController {
  constructor(private readonly repos: SavedRepositories) {}

  @Get()
  @ApiOperation({ summary: 'List Saved Repositories' })
  @ApiOkResponse({ type: [RepositoryDto] })
  async list(): Promise<RepositoryDto[]> {
    return (await this.repos.list()).map(RepositoryDto.from);
  }

  @Post()
  @ApiOperation({ summary: 'Save a repository, with its credentials when private' })
  @ApiCreatedResponse({ type: RepositoryDto })
  @ApiBadRequestResponse({ description: 'Invalid id, URL or ref, or a token without SCANNER_SECRET_KEY' })
  @ApiConflictResponse({ description: 'A Saved Repository with this id exists' })
  async create(@Body() body: CreateRepositoryDto, @Req() req: AuthenticatedRequest): Promise<RepositoryDto> {
    return RepositoryDto.from(await this.repos.create(body, req.role));
  }

  @Get(':id')
  @ApiOperation({ summary: 'A Saved Repository' })
  @ApiOkResponse({ type: RepositoryDto })
  @ApiNotFoundResponse()
  async get(@Param('id') id: string): Promise<RepositoryDto> {
    return RepositoryDto.from(await this.repos.get(id));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Change a Saved Repository' })
  @ApiOkResponse({ type: RepositoryDto })
  @ApiNotFoundResponse()
  async update(@Param('id') id: string, @Body() body: UpdateRepositoryDto, @Req() req: AuthenticatedRequest): Promise<RepositoryDto> {
    return RepositoryDto.from(await this.repos.update(id, body, req.role));
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a Saved Repository no Scan Schedule uses; its past Scans stay' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  @ApiConflictResponse({ description: 'Scan Schedules still use it' })
  async remove(@Param('id') id: string, @Req() req: AuthenticatedRequest): Promise<void> {
    await this.repos.remove(id, req.role);
  }

  @Post(':id/refs')
  @HttpCode(200)
  @ApiOperation({ summary: "A Saved Repository's branches and tags, fetched with its stored credentials" })
  @ApiOkResponse({ type: GitRefsDto })
  @ApiNotFoundResponse()
  @ApiBadGatewayResponse({ description: 'The repository could not be read' })
  refs(@Param('id') id: string, @Req() req: AuthenticatedRequest): Promise<GitRefsDto> {
    return this.repos.refs(id, req.role);
  }
}
