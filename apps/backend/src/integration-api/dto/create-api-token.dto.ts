import {
    IsString, IsNotEmpty, IsArray, IsIn, IsOptional, IsDateString,
    ArrayNotEmpty, IsInt, Min, Max, IsBoolean,
} from 'class-validator';
import { Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional, PartialType } from '@nestjs/swagger';
import { ALL_API_SCOPES, ApiScope } from '../../common/decorators/api-scopes.decorator';

export class CreateApiTokenDto {
    @ApiProperty({ description: 'Human-readable label for the token', example: 'Acme BI export' })
    @IsString() @IsNotEmpty()
    name: string;

    @ApiProperty({
        description: 'Read scopes granted to this token',
        enum: ALL_API_SCOPES, isArray: true,
        example: ['read:transactions', 'read:shifts'],
    })
    @IsArray() @ArrayNotEmpty() @IsIn(ALL_API_SCOPES, { each: true })
    scopes: ApiScope[];

    @ApiPropertyOptional({
        description: 'Restrict the token to these oil bases (empty = all oil bases in the company)',
        isArray: true, type: String, example: [],
    })
    @IsOptional() @IsArray() @IsString({ each: true })
    oilBaseIds?: string[];

    @ApiPropertyOptional({
        description: 'Restrict the token to these stations (empty = all stations in the allowed oil bases)',
        isArray: true, type: String, example: [],
    })
    @IsOptional() @IsArray() @IsString({ each: true })
    stationIds?: string[];

    @ApiPropertyOptional({
        description: 'Restrict the token to these source IPs (empty = any IP)',
        isArray: true, type: String, example: ['203.0.113.10'],
    })
    @IsOptional() @IsArray() @IsString({ each: true })
    ipAllowlist?: string[];

    @ApiPropertyOptional({ description: 'Max requests per minute for this token', example: 120, default: 120, minimum: 1, maximum: 100000 })
    @IsOptional() @Type(() => Number) @IsInt() @Min(1) @Max(100000)
    rateLimitPerMin?: number;

    @ApiPropertyOptional({ description: 'Optional expiry as an ISO date-time', example: '2027-01-01T00:00:00.000Z' })
    @IsOptional() @IsDateString()
    expiresAt?: string;
}

/**
 * Update an existing token. Every field is optional; only the provided
 * fields are changed. `active` toggles the token on/off (a reversible
 * enable/disable, distinct from a permanent revoke via DELETE).
 */
export class UpdateApiTokenDto extends PartialType(CreateApiTokenDto) {
    @ApiPropertyOptional({ description: 'Enable (true) or disable (false) the token', example: true })
    @IsOptional() @IsBoolean()
    active?: boolean;
}
