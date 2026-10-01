import { Body, Controller, HttpCode, Post } from '@nestjs/common';
import {
  ApiBadGatewayResponse,
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiPropertyOptional,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString } from 'class-validator';
import { GitSources } from './git-sources.service';

export class GitRefsRequestDto {
  @ApiProperty({ description: 'https URL of the repository, without credentials' })
  @IsString()
  @IsNotEmpty()
  url: string;

  @ApiPropertyOptional({ description: 'For a private repository; defaults to `oauth2`' })
  @IsOptional()
  @IsString()
  username?: string;

  @ApiPropertyOptional({ description: 'Token or password for a private repository; never stored' })
  @IsOptional()
  @IsString()
  token?: string;
}

export class GitRefsDto {
  @ApiProperty({ nullable: true, type: String, description: 'The default branch, when the server says' }) default: string | null;
  @ApiProperty({ type: [String] }) branches: string[];
  @ApiProperty({ type: [String], description: 'Newest first, by name' }) tags: string[];
}

@ApiBearerAuth()
@ApiUnauthorizedResponse({ description: 'Missing or wrong bearer token' })
@Controller('api/git')
@ApiTags('scans')
export class GitController {
  constructor(private readonly git: GitSources) {}

  /** POST, not GET: the credentials stay out of URLs and logs. */
  @Post('refs')
  @HttpCode(200)
  @ApiOperation({ summary: "A Git repository's branches and tags, to choose the `ref` of a Scan" })
  @ApiOkResponse({ type: GitRefsDto })
  @ApiBadRequestResponse({ description: 'URL not allowed, or the repository refused the credentials' })
  @ApiBadGatewayResponse({ description: 'The repository could not be read' })
  refs(@Body() body: GitRefsRequestDto): Promise<GitRefsDto> {
    return this.git.refs(body.url.trim(), { username: body.username, token: body.token });
  }
}
