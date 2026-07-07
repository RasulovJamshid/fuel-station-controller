import { IsEmail, IsString, MinLength, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class LoginDto {
    @ApiProperty({ description: 'Account email address', example: 'admin@ung.uz' })
    @IsEmail()
    email: string;

    @ApiProperty({ description: 'Account password', minLength: 8, example: 'S3curePass' })
    @IsString()
    @MinLength(8)
    password: string;

    @ApiPropertyOptional({ description: 'TOTP code if 2FA is enabled', example: '123456' })
    @IsOptional()
    @IsString()
    totpCode?: string;
}

export class RefreshDto {
    @ApiProperty({ description: 'Valid refresh token issued at login' })
    @IsString()
    refreshToken: string;
}

export class ChangePasswordDto {
    @ApiProperty({ description: 'The user current password', example: 'S3curePass' })
    @IsString()
    currentPassword: string;

    @ApiProperty({ description: 'New password (min 8 chars, upper, lower, digit)', minLength: 8, example: 'N3wSecret1' })
    @IsString()
    @MinLength(8)
    newPassword: string;
}

export class Setup2faDto {
    @ApiProperty({ description: '6-digit TOTP code to confirm setup', example: '123456' })
    @IsString()
    totpCode: string;
}
