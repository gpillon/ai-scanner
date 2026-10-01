import { Body, Controller, Delete, Get, HttpCode, Param, Patch, Post, Req } from '@nestjs/common';
import {
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
import { ScanStatusDto } from '../scans/dto/scan-status.dto';
import { CreateScheduleDto, ScheduleDto, UpdateScheduleDto } from './dto/schedule.dto';
import { ScanSchedules } from './scan-schedules.service';

@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing or wrong bearer token' })
@Controller('api/schedules')
@ApiTags('schedules')
@ApiForbiddenResponse({ description: 'A schedule of a private Saved Repository needs the admin token' })
export class SchedulesController {
  constructor(private readonly schedules: ScanSchedules) {}

  @Get()
  @ApiOperation({ summary: 'List Scan Schedules' })
  @ApiOkResponse({ type: [ScheduleDto] })
  async list(): Promise<ScheduleDto[]> {
    return (await this.schedules.list()).map(ScheduleDto.from);
  }

  @Post()
  @ApiOperation({ summary: 'Schedule Scans of a Saved Repository' })
  @ApiCreatedResponse({ type: ScheduleDto })
  @ApiBadRequestResponse({ description: 'Invalid id, timing, repository, profile, model, Skill Packs or instructions' })
  @ApiConflictResponse({ description: 'A Scan Schedule with this id exists' })
  async create(@Body() body: CreateScheduleDto, @Req() req: AuthenticatedRequest): Promise<ScheduleDto> {
    return ScheduleDto.from(await this.schedules.create(body, req.role));
  }

  @Get(':id')
  @ApiOperation({ summary: 'A Scan Schedule' })
  @ApiOkResponse({ type: ScheduleDto })
  @ApiNotFoundResponse()
  async get(@Param('id') id: string): Promise<ScheduleDto> {
    return ScheduleDto.from(await this.schedules.get(id));
  }

  @Patch(':id')
  @ApiOperation({ summary: 'Change a Scan Schedule; a new timing, or enabling it, counts from now' })
  @ApiOkResponse({ type: ScheduleDto })
  @ApiNotFoundResponse()
  async update(@Param('id') id: string, @Body() body: UpdateScheduleDto, @Req() req: AuthenticatedRequest): Promise<ScheduleDto> {
    return ScheduleDto.from(await this.schedules.update(id, body, req.role));
  }

  @Delete(':id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a Scan Schedule; the Scans it started stay' })
  @ApiNoContentResponse()
  @ApiNotFoundResponse()
  async remove(@Param('id') id: string, @Req() req: AuthenticatedRequest): Promise<void> {
    await this.schedules.remove(id, req.role);
  }

  @Post(':id/run')
  @ApiOperation({ summary: 'Start a Scan of the schedule now; its next run does not move' })
  @ApiCreatedResponse({ type: ScanStatusDto, description: 'Scan accepted, in state `queued`' })
  @ApiNotFoundResponse()
  async run(@Param('id') id: string, @Req() req: AuthenticatedRequest): Promise<ScanStatusDto> {
    return ScanStatusDto.from(await this.schedules.runNow(id, req.role), []);
  }
}
