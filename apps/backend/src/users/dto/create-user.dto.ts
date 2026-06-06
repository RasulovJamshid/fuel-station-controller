import {
    IsEmail, IsString, IsEnum, IsOptional, IsBoolean, MinLength, IsUUID,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';

export class CreateUserDto {
    @ApiProperty()
    @IsUUID()
    companyId: string;

    @ApiProperty()
    @IsEmail()
    email: string;

    @ApiProperty()
    @IsString()
    @MinLength(2)
    name: string;

    @ApiProperty({ minLength: 8 })
    @IsString()
    @MinLength(8)
    password: string;

    @ApiProperty({ enum: UserRole })
    @IsEnum(UserRole)
    role: UserRole;
}

export class UpdateUserDto {
    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    @MinLength(2)
    name?: string;

    @ApiPropertyOptional({ enum: UserRole })
    @IsOptional()
    @IsEnum(UserRole)
    role?: UserRole;

    @ApiPropertyOptional()
    @IsOptional()
    @IsBoolean()
    active?: boolean;
}

export class UpdatePreferencesDto {
    @ApiPropertyOptional({ enum: ['dark', 'light'] })
    @IsOptional()
    @IsString()
    theme?: 'dark' | 'light';

    @ApiPropertyOptional({ enum: ['uz', 'ru', 'en'] })
    @IsOptional()
    @IsString()
    language?: 'uz' | 'ru' | 'en';

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    timezone?: string;
}
