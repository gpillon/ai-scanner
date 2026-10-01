import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, ValidateIf } from 'class-validator';
import { PoolModel } from '../entities/pool-model.entity';
import { Provider } from '../entities/provider.entity';
import { ModelOptions, modelOptionsOf, THINKING_LEVELS, ThinkingLevel } from '../model-options';
import { KIND_INFO, PROVIDER_KINDS, ProviderKind } from '../provider-kinds';

export class ProviderKindDto {
  @ApiProperty({ enum: PROVIDER_KINDS }) kind: ProviderKind;
  @ApiPropertyOptional({ description: 'Where its API is unless the Provider says otherwise; absent when a baseUrl is required' })
  defaultBaseUrl?: string;
  @ApiPropertyOptional({ description: 'Server environment variable the key is read from when none is stored' })
  apiKeyEnv?: string;

  static all(): ProviderKindDto[] {
    return PROVIDER_KINDS.map((kind) => ({ kind, defaultBaseUrl: KIND_INFO[kind].defaultBaseUrl, apiKeyEnv: KIND_INFO[kind].apiKeyEnv }));
  }
}

export class CreateProviderDto {
  @ApiProperty({ description: 'Lowercase letters, digits and dashes, e.g. `anthropic` or `local-vllm`' })
  @IsString()
  @IsNotEmpty()
  id: string;

  @ApiProperty({ enum: PROVIDER_KINDS })
  @IsIn(PROVIDER_KINDS)
  kind: ProviderKind;

  @ApiPropertyOptional({ description: 'Required for openai-compatible, e.g. `http://host:8000/v1`' })
  @IsOptional()
  @IsString()
  baseUrl?: string;

  @ApiPropertyOptional({ description: 'Stored encrypted; never returned' })
  @IsOptional()
  @IsString()
  apiKey?: string;
}

export class UpdateProviderDto {
  @ApiPropertyOptional({ nullable: true, type: String, description: '`null` falls back to the kind default' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  baseUrl?: string | null;

  @ApiPropertyOptional({ nullable: true, type: String, description: 'A new key; `null` removes the stored one' })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsString()
  apiKey?: string | null;
}

export class ProviderDto {
  @ApiProperty() id: string;
  @ApiProperty({ enum: PROVIDER_KINDS }) kind: ProviderKind;
  @ApiProperty({ nullable: true, type: String }) baseUrl: string | null;
  @ApiProperty({ description: 'Where its API is: baseUrl, or the kind default', nullable: true, type: String })
  effectiveBaseUrl: string | null;
  @ApiProperty({ description: 'Whether an API key is stored' }) apiKeySet: boolean;
  @ApiProperty({ nullable: true, type: String, description: 'Last characters of the stored key' }) apiKeyHint: string | null;
  @ApiProperty({ nullable: true, type: String, description: 'Server environment variable holding the key, if set that way' })
  apiKeyEnv: string | null;
  @ApiProperty({ description: 'Models of the pool it serves' }) models: number;
  @ApiProperty() createdAt: string;

  static from(p: Provider, effectiveBaseUrl: string | undefined, models: number): ProviderDto {
    return {
      id: p.id,
      kind: p.kind,
      baseUrl: p.baseUrl,
      effectiveBaseUrl: effectiveBaseUrl ?? null,
      apiKeySet: Boolean(p.apiKeySealed),
      apiKeyHint: p.apiKeyHint,
      apiKeyEnv: p.apiKeyEnv,
      models,
      createdAt: p.createdAt,
    };
  }
}

export class DiscoveredModelDto {
  @ApiProperty({ description: "The model's name at the Provider" }) name: string;
  @ApiPropertyOptional() displayName?: string;
  @ApiPropertyOptional({ description: 'Model Pool id, when the pool already has it' }) inPool?: string;
}

export class CreateModelDto {
  @ApiProperty({ description: 'Provider id' })
  @IsString()
  @IsNotEmpty()
  provider: string;

  @ApiProperty({ description: "The model's name at the Provider" })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiPropertyOptional({ description: 'Model Pool id; defaults to the name' })
  @IsOptional()
  @IsString()
  id?: string;

  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;

  @ApiPropertyOptional({ description: 'Make it the Default Model' }) @IsOptional() @IsBoolean() default?: boolean;

  @ApiPropertyOptional({
    enum: ['on', 'off'],
    description:
      "Model option: whether the model thinks (reasons) before answering. Left out: the model's own behaviour, and nothing is sent. " +
      "Taken by models of the anthropic, openai and openai-compatible provider kinds; a model that cannot honour it fails its Attempts with the provider's message.",
  })
  @IsOptional()
  @IsIn(['on', 'off'], { message: 'thinking must be "on" or "off"' })
  thinking?: 'on' | 'off';

  @ApiPropertyOptional({ enum: THINKING_LEVELS, description: "Model option, with thinking=on: how much the model thinks. Left out: the model's own level." })
  @IsOptional()
  @IsIn(THINKING_LEVELS, { message: `thinkingLevel must be one of: ${THINKING_LEVELS.join(', ')}` })
  thinkingLevel?: ThinkingLevel;
}

export class UpdateModelDto {
  @ApiPropertyOptional() @IsOptional() @IsBoolean() enabled?: boolean;
  @ApiPropertyOptional({ description: 'true makes it the Default Model' }) @IsOptional() @IsBoolean() default?: boolean;

  @ApiPropertyOptional({
    enum: ['on', 'off'],
    nullable: true,
    description: "Model option: whether the model thinks. Given, it replaces the thinking level too; `null` is the model's own behaviour",
  })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsIn(['on', 'off'], { message: 'thinking must be "on" or "off"' })
  thinking?: 'on' | 'off' | null;

  @ApiPropertyOptional({ enum: THINKING_LEVELS, nullable: true, description: "Model option, with thinking on: how much; `null` is the model's own level" })
  @IsOptional()
  @ValidateIf((_o, v) => v !== null)
  @IsIn(THINKING_LEVELS, { message: `thinkingLevel must be one of: ${THINKING_LEVELS.join(', ')}` })
  thinkingLevel?: ThinkingLevel | null;
}

export class AdminModelDto {
  @ApiProperty() id: string;
  @ApiProperty({ description: 'Provider id' }) provider: string;
  @ApiProperty({ description: "The model's name at the Provider" }) name: string;
  @ApiProperty() enabled: boolean;
  @ApiProperty() default: boolean;
  @ApiPropertyOptional({ enum: ['on', 'off'], description: "Whether the model thinks, when set; the model's own behaviour otherwise" })
  thinking?: 'on' | 'off';
  @ApiPropertyOptional({ enum: THINKING_LEVELS, description: "How much, when set with thinking on; the model's own level otherwise" })
  thinkingLevel?: ThinkingLevel;
  @ApiProperty({
    type: [String],
    description: "The model options its Provider's kind takes, e.g. thinking and thinkingLevel; empty when none",
    example: ['thinking', 'thinkingLevel'],
  })
  options: (keyof ModelOptions)[];

  static from(m: PoolModel, kind: ProviderKind | undefined): AdminModelDto {
    return {
      id: m.id,
      provider: m.providerId,
      name: m.name,
      enabled: m.enabled,
      default: m.isDefault,
      ...m.modelOptions,
      options: kind ? modelOptionsOf(kind) : [],
    };
  }
}
