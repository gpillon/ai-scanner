import { ApiProperty } from '@nestjs/swagger';

export class ModelDto {
  @ApiProperty() id: string;
  @ApiProperty() provider: string;
  @ApiProperty({ description: 'True for the Default Model' }) default: boolean;
}
