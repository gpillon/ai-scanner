import { ApiProperty } from '@nestjs/swagger';
import type { ModelOptions } from '../model-options';

export class ModelDto {
  @ApiProperty() id: string;
  @ApiProperty() provider: string;
  @ApiProperty({ description: 'True for the Default Model' }) default: boolean;
  @ApiProperty({
    type: [String],
    description: 'The model options POST /api/scan/<id> takes with this model, e.g. thinking and thinkingLevel; empty when none',
    example: ['thinking', 'thinkingLevel'],
  })
  options: (keyof ModelOptions)[];
}
