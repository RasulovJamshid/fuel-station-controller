import { IsString, MinLength, Matches, IsOptional, IsBoolean } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CreateCompanyDto {
    @ApiProperty({ example: 'UNG Fuel' })
    @IsString()
    @MinLength(2)
    name: string;

    @ApiProperty({ example: 'ung', description: 'URL-safe identifier' })
    @IsString()
    @Matches(/^[a-z0-9-]+$/, { message: 'slug must be lowercase alphanumeric with dashes' })
    slug: string;
}

export class UpdateCompanyDto {
    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    @MinLength(2)
    name?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsBoolean()
    active?: boolean;
}
