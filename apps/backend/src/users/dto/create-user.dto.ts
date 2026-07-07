import {
    IsEmail, IsString, IsEnum, IsOptional, IsBoolean, MinLength, IsUUID,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';

export class CreateUserDto {
    @ApiProperty({ description: 'Company the user belongs to', format: 'uuid', example: '3f2504e0-4f89-11d3-9a0c-0305e82c3301' })
    @IsUUID()
    companyId: string;

    @ApiProperty({ description: 'Login email address', example: 'operator@ung.uz' })
    @IsEmail()
    email: string;

    @ApiProperty({ description: 'Full display name', example: 'Ali Valiyev' })
    @IsString()
    @MinLength(2)
    name: string;

    @ApiProperty({ description: 'Initial password (min 8 chars)', minLength: 8, example: 'S3curePass' })
    @IsString()
    @MinLength(8)
    password: string;

    @ApiProperty({ description: 'Role assigned to the user', enum: UserRole, example: UserRole.STATION_MANAGER })
    @IsEnum(UserRole)
    role: UserRole;
}

export class UpdateUserDto {
    @ApiPropertyOptional({ description: 'Full display name', example: 'Ali Valiyev' })
    @IsOptional()
    @IsString()
    @MinLength(2)
    name?: string;

    @ApiPropertyOptional({ description: 'Role assigned to the user', enum: UserRole })
    @IsOptional()
    @IsEnum(UserRole)
    role?: UserRole;

    @ApiPropertyOptional({ description: 'Whether the account is active', example: true })
    @IsOptional()
    @IsBoolean()
    active?: boolean;
}

export class UpdatePreferencesDto {
    @ApiPropertyOptional({ description: 'UI color theme', enum: ['dark', 'light'], example: 'dark' })
    @IsOptional()
    @IsString()
    theme?: 'dark' | 'light';

    @ApiPropertyOptional({ description: 'Preferred UI language', enum: ['uz', 'ru', 'en'], example: 'uz' })
    @IsOptional()
    @IsString()
    language?: 'uz' | 'ru' | 'en';

    @ApiPropertyOptional({ description: 'IANA timezone name', example: 'Asia/Tashkent' })
    @IsOptional()
    @IsString()
    timezone?: string;
}
