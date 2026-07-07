import { IsString, IsUrl, IsIn, IsOptional, IsBoolean, IsInt, IsArray, Min, Max, ArrayUnique, IsNotEmpty } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export const INTEGRATION_EVENTS = [
    'transaction.completed',
    'shift.closed',
    'price.changed',
    'health.event',
    'tank.reading',
] as const;

export class CreateIntegrationDto {
    @ApiProperty({ description: 'Human-readable name for the integration', example: 'Accounting webhook' })
    @IsString()
    @IsNotEmpty()
    name: string;

    @ApiProperty({ description: 'Destination URL that webhook events are POSTed to', example: 'https://example.com/hooks/azs' })
    @IsUrl({ require_tld: false })
    url: string;

    @ApiPropertyOptional({ description: 'Authentication scheme applied to outgoing requests', enum: ['none', 'bearer', 'hmac'], default: 'none', example: 'hmac' })
    @IsIn(['none', 'bearer', 'hmac'])
    @IsOptional()
    authType?: string;

    @ApiPropertyOptional({ description: 'Secret used for the chosen auth scheme (bearer token or HMAC signing key)', example: 's3cr3t-signing-key' })
    @IsString()
    @IsOptional()
    authSecret?: string;

    @ApiProperty({ description: 'Event types this integration subscribes to', isArray: true, enum: INTEGRATION_EVENTS, example: ['transaction.completed', 'shift.closed'] })
    @IsArray()
    @IsString({ each: true })
    @ArrayUnique()
    events: string[];

    @ApiPropertyOptional({ description: 'Whether the integration is enabled and receives events', default: true, example: true })
    @IsBoolean()
    @IsOptional()
    active?: boolean;

    @ApiPropertyOptional({ description: 'Maximum number of delivery retry attempts', minimum: 0, maximum: 10, default: 3, example: 3 })
    @IsInt()
    @Min(0)
    @Max(10)
    @IsOptional()
    retryLimit?: number;

    @ApiPropertyOptional({ description: 'Per-request delivery timeout in milliseconds', minimum: 1000, maximum: 30000, default: 5000, example: 5000 })
    @IsInt()
    @Min(1000)
    @Max(30000)
    @IsOptional()
    timeoutMs?: number;
}

export class UpdateIntegrationDto {
    @ApiPropertyOptional({ description: 'Human-readable name for the integration', example: 'Accounting webhook' })
    @IsString()
    @IsOptional()
    name?: string;

    @ApiPropertyOptional({ description: 'Destination URL that webhook events are POSTed to', example: 'https://example.com/hooks/azs' })
    @IsUrl({ require_tld: false })
    @IsOptional()
    url?: string;

    @ApiPropertyOptional({ description: 'Authentication scheme applied to outgoing requests', enum: ['none', 'bearer', 'hmac'], example: 'hmac' })
    @IsIn(['none', 'bearer', 'hmac'])
    @IsOptional()
    authType?: string;

    @ApiPropertyOptional({ description: 'Secret used for the chosen auth scheme (bearer token or HMAC signing key)', example: 's3cr3t-signing-key' })
    @IsString()
    @IsOptional()
    authSecret?: string;

    @ApiPropertyOptional({ description: 'Event types this integration subscribes to', isArray: true, enum: INTEGRATION_EVENTS, example: ['transaction.completed', 'shift.closed'] })
    @IsArray()
    @IsString({ each: true })
    @ArrayUnique()
    @IsOptional()
    events?: string[];

    @ApiPropertyOptional({ description: 'Whether the integration is enabled and receives events', example: true })
    @IsBoolean()
    @IsOptional()
    active?: boolean;

    @ApiPropertyOptional({ description: 'Maximum number of delivery retry attempts', minimum: 0, maximum: 10, example: 3 })
    @IsInt()
    @Min(0)
    @Max(10)
    @IsOptional()
    retryLimit?: number;

    @ApiPropertyOptional({ description: 'Per-request delivery timeout in milliseconds', minimum: 1000, maximum: 30000, example: 5000 })
    @IsInt()
    @Min(1000)
    @Max(30000)
    @IsOptional()
    timeoutMs?: number;
}
