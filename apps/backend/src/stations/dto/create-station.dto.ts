import {
    IsString, IsOptional, IsArray, IsBoolean, MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateStationDto {
    @ApiProperty({ description: 'Station ID — must match site.config.json site.id', example: 'azs-001' })
    @IsString()
    id: string;

    @ApiProperty({ description: 'Owning company ID', example: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' })
    @IsString()
    companyId: string;

    @ApiProperty({ description: 'Display name of the station', example: 'Chilonzor AZS' })
    @IsString()
    @MinLength(2)
    name: string;

    @ApiPropertyOptional({ description: 'Physical address', example: 'Chilonzor 12, Tashkent' })
    @IsOptional()
    @IsString()
    address?: string;

    @ApiPropertyOptional({ description: 'IANA timezone name', default: 'Asia/Tashkent', example: 'Asia/Tashkent' })
    @IsOptional()
    @IsString()
    timezone?: string;

    @ApiPropertyOptional({ type: [String], description: 'IP allowlist — empty means allow all', example: ['192.168.1.10'] })
    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    ipAllowlist?: string[];
}

export class UpdateStationDto {
    @ApiPropertyOptional({ description: 'Display name of the station', example: 'Chilonzor AZS' })
    @IsOptional()
    @IsString()
    name?: string;

    @ApiPropertyOptional({ description: 'Physical address', example: 'Chilonzor 12, Tashkent' })
    @IsOptional()
    @IsString()
    address?: string;

    @ApiPropertyOptional({ description: 'Whether the station is active', example: true })
    @IsOptional()
    @IsBoolean()
    active?: boolean;

    @ApiPropertyOptional({ type: [String], description: 'IP allowlist — empty means allow all', example: ['192.168.1.10'] })
    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    ipAllowlist?: string[];
}
