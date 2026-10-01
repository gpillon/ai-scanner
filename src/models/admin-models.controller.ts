import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AdminOnly } from '../auth/admin-only.decorator';
import { AdminModelDto, CreateModelDto, UpdateModelDto } from './dto/admin.dto';
import { ModelPool } from './model-pool.service';

@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing or wrong bearer token' })
@AdminOnly()
@Controller('api/admin/models')
@ApiTags('admin')
export class AdminModelsController {
  constructor(private readonly pool: ModelPool) {}

  @Get()
  @ApiOperation({ summary: 'Every model of the pool, enabled or not' })
  @ApiOkResponse({ type: [AdminModelDto] })
  async list(): Promise<AdminModelDto[]> {
    return (await this.pool.all()).map(AdminModelDto.from);
  }

  @Post()
  @ApiOperation({ summary: 'Add a model of a Provider to the pool' })
  @ApiCreatedResponse({ type: AdminModelDto })
  @ApiConflictResponse({ description: 'A model with this id exists' })
  async create(@Body() body: CreateModelDto): Promise<AdminModelDto> {
    return AdminModelDto.from(await this.pool.create(body));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Enable or disable a model, or make it the Default Model' })
  @ApiOkResponse({ type: AdminModelDto })
  @ApiNotFoundResponse()
  async update(@Param('id') id: string, @Body() body: UpdateModelDto): Promise<AdminModelDto> {
    return AdminModelDto.from(await this.pool.update(id, body));
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a model from the pool' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  @ApiConflictResponse({ description: 'Queued or running Scans use it' })
  async remove(@Param('id') id: string): Promise<void> {
    await this.pool.remove(id);
  }
}
