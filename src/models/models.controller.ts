import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { ModelDto } from './dto/model.dto';
import { ModelPool } from './model-pool.service';

@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing or wrong bearer token' })
@Controller('api/models')
@ApiTags('discovery')
export class ModelsController {
  constructor(private readonly models: ModelPool) {}

  @Get()
  // operationId as before the split of DiscoveryController, for clients generated from the OpenAPI.
  @ApiOperation({ summary: 'List the Model Pool, with the Default Model marked', operationId: 'DiscoveryController_listModels' })
  @ApiOkResponse({ type: [ModelDto] })
  list(): ModelDto[] {
    return this.models.list();
  }
}
