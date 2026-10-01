import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
  ApiBadRequestResponse,
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
import { PoolModel } from './entities/pool-model.entity';
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
    const kinds = await this.pool.providerKinds();
    return (await this.pool.all()).map((m) => AdminModelDto.from(m, kinds.get(m.providerId)));
  }

  @Post()
  @ApiOperation({ summary: 'Add a model of a Provider to the pool' })
  @ApiCreatedResponse({ type: AdminModelDto })
  @ApiBadRequestResponse({ description: 'Unknown Provider, invalid id, or model options its Provider does not take' })
  @ApiConflictResponse({ description: 'A model with this id exists' })
  async create(@Body() body: CreateModelDto): Promise<AdminModelDto> {
    return this.dto(await this.pool.create(body));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Enable or disable a model, make it the Default Model, or set how it thinks' })
  @ApiOkResponse({ type: AdminModelDto })
  @ApiBadRequestResponse({ description: 'Model options its Provider does not take, or a thinking level without thinking on' })
  @ApiNotFoundResponse()
  async update(@Param('id') id: string, @Body() body: UpdateModelDto): Promise<AdminModelDto> {
    return this.dto(await this.pool.update(id, body));
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

  private async dto(model: PoolModel): Promise<AdminModelDto> {
    return AdminModelDto.from(model, (await this.pool.providerKinds()).get(model.providerId));
  }
}
