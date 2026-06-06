import { IsEmail, IsString, MinLength, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class LoginDto {
    @ApiProperty({ example: 'admin@ung.uz' })
    @IsEmail()
    email: string;

    @ApiProperty({ minLength: 8 })
    @IsString()
    @MinLength(8)
    password: string;

    @ApiPropertyOptional({ description: 'TOTP code if 2FA is enabled' })
    @IsOptional()
    @IsString()
    totpCode?: string;
}

export class RefreshDto {
    @ApiProperty()
    @IsString()
    refreshToken: string;
}

export class ChangePasswordDto {
    @ApiProperty()
    @IsString()
    currentPassword: string;

    @ApiProperty({ minLength: 8 })
    @IsString()
    @MinLength(8)
    newPassword: string;
}

export class Setup2faDto {
    @ApiProperty({ description: '6-digit TOTP code to confirm setup' })
    @IsString()
    totpCode: string;
}
