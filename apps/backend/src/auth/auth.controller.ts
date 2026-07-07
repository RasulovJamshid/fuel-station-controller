import {
    Controller, Post, Get, Delete, Body, Param,
    UseGuards, Req, HttpCode, HttpStatus,
} from '@nestjs/common';
import {
    ApiTags, ApiBearerAuth, ApiOperation, ApiOkResponse, ApiCreatedResponse,
    ApiNoContentResponse, ApiBadRequestResponse, ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { AuthGuard } from '@nestjs/passport';
import { Request } from 'express';
import { AuthService } from './auth.service';
import { LoginDto, RefreshDto, ChangePasswordDto, Setup2faDto } from './dto/login.dto';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Public } from '../common/decorators/roles.decorator';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
    constructor(private auth: AuthService) {}

    @Post('login')
    @ApiOperation({ summary: 'Authenticate user and issue access and refresh tokens' })
    @ApiOkResponse({ description: 'Login succeeded; returns access and refresh tokens' })
    @ApiBadRequestResponse({ description: 'Validation failed' })
    @ApiUnauthorizedResponse({ description: 'Invalid credentials, locked account, or invalid TOTP code' })
    @Public()
    @HttpCode(HttpStatus.OK)
    login(@Body() dto: LoginDto, @Req() req: Request) {
        return this.auth.login(
            dto.email, dto.password, dto.totpCode,
            req.ip ?? '', req.headers['user-agent'] ?? '',
        );
    }

    @Post('refresh')
    @ApiOperation({ summary: 'Rotate refresh token and issue a new token pair' })
    @ApiOkResponse({ description: 'Returns a fresh access and refresh token pair' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid refresh token' })
    @Public()
    @UseGuards(AuthGuard('jwt-refresh'))
    @HttpCode(HttpStatus.OK)
    refresh(@CurrentUser() user: any, @Req() req: Request) {
        return this.auth.refresh(user.id, user.sessionId, req.ip ?? '', req.headers['user-agent'] ?? '');
    }

    @Post('logout')
    @ApiOperation({ summary: 'Revoke the current session' })
    @ApiNoContentResponse({ description: 'Session revoked' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @HttpCode(HttpStatus.NO_CONTENT)
    logout(@CurrentUser() user: any) {
        return this.auth.logout(user.sessionId);
    }

    @Post('logout-all')
    @ApiOperation({ summary: 'Revoke all sessions for the current user' })
    @ApiNoContentResponse({ description: 'All sessions revoked' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @HttpCode(HttpStatus.NO_CONTENT)
    logoutAll(@CurrentUser() user: any) {
        return this.auth.logoutAll(user.id);
    }

    @Get('sessions')
    @ApiOperation({ summary: 'List active sessions for the current user' })
    @ApiOkResponse({ description: 'List of active sessions' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    getSessions(@CurrentUser() user: any) {
        return this.auth.getSessions(user.id);
    }

    @Delete('sessions/:id')
    @ApiOperation({ summary: 'Revoke a specific session by ID' })
    @ApiNoContentResponse({ description: 'Session revoked' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @HttpCode(HttpStatus.NO_CONTENT)
    revokeSession(@CurrentUser() user: any, @Param('id') id: string) {
        return this.auth.revokeSession(user.id, id);
    }

    @Get('me')
    @ApiOperation({ summary: 'Get the authenticated user profile' })
    @ApiOkResponse({ description: 'Current user profile' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    me(@CurrentUser() user: any) {
        const { passwordHash, twoFactorSecret, ...safe } = user;
        return safe;
    }

    @Post('change-password')
    @ApiOperation({ summary: 'Change the current user password and revoke all sessions' })
    @ApiNoContentResponse({ description: 'Password changed; all sessions revoked' })
    @ApiBadRequestResponse({ description: 'Validation failed' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token, or current password incorrect' })
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @HttpCode(HttpStatus.NO_CONTENT)
    changePassword(@CurrentUser() user: any, @Body() dto: ChangePasswordDto, @Req() req: Request) {
        return this.auth.changePassword(user.id, dto, req.ip ?? '');
    }

    @Post('setup-2fa')
    @ApiOperation({ summary: 'Generate a 2FA secret and QR code for authenticator setup' })
    @ApiCreatedResponse({ description: 'Returns a QR code data URL and the shared secret' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    setup2fa(@CurrentUser() user: any) {
        return this.auth.setup2fa(user.id);
    }

    @Post('confirm-2fa')
    @ApiOperation({ summary: 'Confirm the TOTP code and enable two-factor authentication' })
    @ApiNoContentResponse({ description: 'Two-factor authentication enabled' })
    @ApiBadRequestResponse({ description: 'Validation failed' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @HttpCode(HttpStatus.NO_CONTENT)
    confirm2fa(@CurrentUser() user: any, @Body() dto: Setup2faDto) {
        return this.auth.confirm2fa(user.id, dto.totpCode);
    }

    @Delete('disable-2fa')
    @ApiOperation({ summary: 'Disable two-factor authentication' })
    @ApiNoContentResponse({ description: 'Two-factor authentication disabled' })
    @ApiBadRequestResponse({ description: 'Validation failed' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token, or invalid TOTP code' })
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @HttpCode(HttpStatus.NO_CONTENT)
    disable2fa(@CurrentUser() user: any, @Body() dto: Setup2faDto) {
        return this.auth.disable2fa(user.id, dto.totpCode);
    }
}
