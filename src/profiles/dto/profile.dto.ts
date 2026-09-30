import { ApiProperty } from '@nestjs/swagger';

export class ProfileDto {
  @ApiProperty() name: string;
  @ApiProperty() description: string;
  @ApiProperty({ description: 'Whether Scans of this profile produce Findings (findings.json)' }) producesFindings: boolean;
}
