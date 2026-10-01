import { Controller, Get, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiProperty, ApiTags, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { AuthenticatedRequest, Role } from './bearer.guard';

export class MeDto {
  @ApiProperty({ enum: ['admin', 'caller'], description: '`admin` for the admin token, `caller` for the shared one' })
  role: Role;
}

@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing or wrong bearer token' })
@Controller('api/me')
@ApiTags('discovery')
export class MeController {
  @Get()
  @ApiOperation({ summary: 'What the presented token may do' })
  @ApiOkResponse({ type: MeDto })
  me(@Req() request: AuthenticatedRequest): MeDto {
    return { role: request.role };
  }
}
