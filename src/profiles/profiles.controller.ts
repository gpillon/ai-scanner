import { Controller, Get } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { ProfileDto } from './dto/profile.dto';
import { ProfileRegistry } from './profile-registry.service';

@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing or wrong bearer token' })
@Controller('api/profiles')
@ApiTags('discovery')
export class ProfilesController {
  constructor(private readonly profiles: ProfileRegistry) {}

  @Get()
  // operationId as before the split of DiscoveryController, for clients generated from the OpenAPI.
  @ApiOperation({ summary: 'List Scan Profiles', operationId: 'DiscoveryController_listProfiles' })
  @ApiOkResponse({ type: [ProfileDto] })
  list(): ProfileDto[] {
    return this.profiles.list().map(({ name, description, producesFindings }) => ({ name, description, producesFindings }));
  }
}
