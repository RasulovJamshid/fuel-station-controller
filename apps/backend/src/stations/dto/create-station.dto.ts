import {
    IsString, IsOptional, IsArray, IsBoolean, MinLength,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateStationDto {
    @ApiProperty({ description: 'Must match site.config.json site.id' })
    @IsString()
    id: string;

    @ApiProperty()
    @IsString()
    companyId: string;

    @ApiProperty()
    @IsString()
    @MinLength(2)
    name: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    address?: string;

    @ApiPropertyOptional({ default: 'Asia/Tashkent' })
    @IsOptional()
    @IsString()
    timezone?: string;

    @ApiPropertyOptional({ type: [String], description: 'IP allowlist — empty means allow all' })
    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    ipAllowlist?: string[];
}

export class UpdateStationDto {
    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    name?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    address?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsBoolean()
    active?: boolean;

    @ApiPropertyOptional({ type: [String] })
    @IsOptional()
    @IsArray()
    @IsString({ each: true })
    ipAllowlist?: string[];
}
