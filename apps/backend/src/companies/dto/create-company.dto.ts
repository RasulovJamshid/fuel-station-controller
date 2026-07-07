import { IsString, MinLength, Matches, IsOptional, IsBoolean } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateCompanyDto {
    @ApiProperty({ description: 'Display name of the company', example: 'UNG Fuel' })
    @IsString()
    @MinLength(2)
    name: string;

    @ApiProperty({ description: 'URL-safe unique identifier (lowercase, digits, dashes)', example: 'ung' })
    @IsString()
    @Matches(/^[a-z0-9-]+$/, { message: 'slug must be lowercase alphanumeric with dashes' })
    slug: string;
}

export class UpdateCompanyDto {
    @ApiPropertyOptional({ description: 'Display name of the company', example: 'UNG Fuel' })
    @IsOptional()
    @IsString()
    @MinLength(2)
    name?: string;

    @ApiPropertyOptional({ description: 'Whether the company is active', example: true })
    @IsOptional()
    @IsBoolean()
    active?: boolean;
}
