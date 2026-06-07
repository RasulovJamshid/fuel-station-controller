import { IsString, IsUrl, IsIn, IsOptional, IsBoolean, IsInt, IsArray, Min, Max, ArrayUnique, IsNotEmpty } from 'class-validator';

export const INTEGRATION_EVENTS = [
    'transaction.completed',
    'shift.closed',
    'price.changed',
    'health.event',
    'tank.reading',
] as const;

export class CreateIntegrationDto {
    @IsString()
    @IsNotEmpty()
    name: string;

    @IsUrl({ require_tld: false })
    url: string;

    @IsIn(['none', 'bearer', 'hmac'])
    @IsOptional()
    authType?: string;

    @IsString()
    @IsOptional()
    authSecret?: string;

    @IsArray()
    @IsString({ each: true })
    @ArrayUnique()
    events: string[];

    @IsBoolean()
    @IsOptional()
    active?: boolean;

    @IsInt()
    @Min(0)
    @Max(10)
    @IsOptional()
    retryLimit?: number;

    @IsInt()
    @Min(1000)
    @Max(30000)
    @IsOptional()
    timeoutMs?: number;
}

export class UpdateIntegrationDto {
    @IsString()
    @IsOptional()
    name?: string;

    @IsUrl({ require_tld: false })
    @IsOptional()
    url?: string;

    @IsIn(['none', 'bearer', 'hmac'])
    @IsOptional()
    authType?: string;

    @IsString()
    @IsOptional()
    authSecret?: string;

    @IsArray()
    @IsString({ each: true })
    @ArrayUnique()
    @IsOptional()
    events?: string[];

    @IsBoolean()
    @IsOptional()
    active?: boolean;

    @IsInt()
    @Min(0)
    @Max(10)
    @IsOptional()
    retryLimit?: number;

    @IsInt()
    @Min(1000)
    @Max(30000)
    @IsOptional()
    timeoutMs?: number;
}
