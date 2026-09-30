import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Req,
  StreamableFile,
  UseInterceptors,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiProduces,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { ArchiveUploadInterceptor } from './archive-upload.interceptor';
import { CreateScanDto } from './dto/create-scan.dto';
import { ScanStatusDto } from './dto/scan-status.dto';
import { ScansService } from './scans.service';

@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing or wrong bearer token' })
@Controller('api')
@ApiTags('scans')
export class ScansController {
  constructor(private readonly scans: ScansService) {}

  @Post('scan/:id')
  @UseInterceptors(ArchiveUploadInterceptor)
  @ApiOperation({ summary: 'Start a Scan under a caller-chosen id' })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: ['file', 'profile'],
      properties: {
        file: { type: 'string', format: 'binary', description: 'Source Archive (zip)' },
        profile: { type: 'string' },
        model: { type: 'string' },
        language: { type: 'string' },
        instructions: { type: 'string' },
      },
    },
  })
  @ApiCreatedResponse({ type: ScanStatusDto, description: 'Scan accepted, in state `queued`' })
  @ApiBadRequestResponse({ description: 'Invalid id, archive, profile, model, language or instructions' })
  @ApiConflictResponse({ description: 'A Scan with this id already exists' })
  async create(@Param('id') id: string, @Body() body: CreateScanDto, @Req() req: { file?: { path: string } }) {
    const scan = await this.scans.create({ id, archivePath: req.file?.path, ...body });
    return ScanStatusDto.from(scan, []);
  }

  @Get('scans')
  @ApiOperation({ summary: 'List every Scan, newest first' })
  @ApiOkResponse({ type: [ScanStatusDto] })
  async list() {
    const scans = await this.scans.list();
    return Promise.all(scans.map(async (scan) => ScanStatusDto.from(scan, await this.scans.artifactNames(scan))));
  }

  @Get('scan/:id')
  @ApiOperation({ summary: 'Scan status' })
  @ApiOkResponse({ type: ScanStatusDto })
  @ApiNotFoundResponse({ description: 'Unknown, deleted or expired Scan' })
  async status(@Param('id') id: string) {
    const scan = await this.scans.get(id);
    return ScanStatusDto.from(scan, await this.scans.artifactNames(scan));
  }

  @Get('scan/:id/artifacts/:name')
  @ApiOperation({ summary: 'Download an Artifact of a succeeded Scan' })
  @ApiProduces('text/markdown', 'application/pdf', 'application/json')
  @ApiOkResponse({ description: 'The Artifact file' })
  @ApiNotFoundResponse({ description: 'Unknown Scan or Artifact, or the Scan has not succeeded' })
  async artifact(@Param('id') id: string, @Param('name') name: string) {
    const { stream, contentType } = await this.scans.artifact(id, name);
    return new StreamableFile(stream as never, { type: contentType });
  }

  @Delete('scan/:id')
  @HttpCode(204)
  @ApiOperation({ summary: 'Stop (if running) and remove a Scan with all its data' })
  @ApiNoContentResponse({ description: 'Scan removed; the id is free again' })
  @ApiNotFoundResponse({ description: 'Unknown, deleted or expired Scan' })
  async remove(@Param('id') id: string): Promise<void> {
    await this.scans.delete(id);
  }
}
