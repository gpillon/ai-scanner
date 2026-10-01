import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
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
import { CreateProviderDto, DiscoveredModelDto, ProviderDto, ProviderKindDto, UpdateProviderDto } from './dto/admin.dto';
import { Provider } from './entities/provider.entity';
import { ModelPool } from './model-pool.service';
import { ProvidersService } from './providers.service';

@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing or wrong bearer token' })
@AdminOnly()
@Controller('api/admin')
@ApiTags('admin')
export class ProvidersController {
  constructor(
    private readonly providers: ProvidersService,
    private readonly pool: ModelPool,
  ) {}

  private async dto(p: Provider): Promise<ProviderDto> {
    return ProviderDto.from(p, this.providers.baseUrlOf(p), await this.providers.modelCount(p.id));
  }

  @Get('provider-kinds')
  @ApiOperation({ summary: 'The kinds of Provider, with their defaults' })
  @ApiOkResponse({ type: [ProviderKindDto] })
  kinds(): ProviderKindDto[] {
    return ProviderKindDto.all();
  }

  @Get('providers')
  @ApiOperation({ summary: 'List Providers' })
  @ApiOkResponse({ type: [ProviderDto] })
  async list(): Promise<ProviderDto[]> {
    return Promise.all((await this.providers.list()).map((p) => this.dto(p)));
  }

  @Post('providers')
  @ApiOperation({ summary: 'Add a Provider' })
  @ApiCreatedResponse({ type: ProviderDto })
  @ApiConflictResponse({ description: 'A Provider with this id exists' })
  async create(@Body() body: CreateProviderDto): Promise<ProviderDto> {
    return this.dto(await this.providers.create(body));
  }

  @Get('providers/:id')
  @ApiOperation({ summary: 'A Provider' })
  @ApiOkResponse({ type: ProviderDto })
  @ApiNotFoundResponse()
  async get(@Param('id') id: string): Promise<ProviderDto> {
    return this.dto(await this.providers.get(id));
  }

  @Patch('providers/:id')
  @ApiOperation({ summary: "Change a Provider's base URL or API key" })
  @ApiOkResponse({ type: ProviderDto })
  @ApiNotFoundResponse()
  async update(@Param('id') id: string, @Body() body: UpdateProviderDto): Promise<ProviderDto> {
    return this.dto(await this.providers.update(id, body));
  }

  @Delete('providers/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a Provider that serves no model' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  @ApiConflictResponse({ description: 'Models of the pool still use it' })
  async remove(@Param('id') id: string): Promise<void> {
    await this.providers.remove(id);
  }

  @Get('providers/:id/models')
  @ApiOperation({ summary: 'The models the Provider offers, asked from its API' })
  @ApiOkResponse({ type: [DiscoveredModelDto] })
  @ApiNotFoundResponse()
  @ApiBadGatewayResponse({ description: 'The Provider could not be reached, or refused' })
  async discover(@Param('id') id: string): Promise<DiscoveredModelDto[]> {
    const offered = await this.providers.discover(id);
    const inPool = new Map((await this.pool.all()).filter((m) => m.providerId === id).map((m) => [m.name, m.id]));
    return offered.map((m) => ({ ...m, ...(inPool.has(m.name) && { inPool: inPool.get(m.name) }) }));
  }
}
