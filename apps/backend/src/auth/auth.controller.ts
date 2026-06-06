import {
    Controller, Post, Get, Delete, Body, Param,
    UseGuards, Req, HttpCode, HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
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
    @Public()
    @HttpCode(HttpStatus.OK)
    login(@Body() dto: LoginDto, @Req() req: Request) {
        return this.auth.login(
            dto.email, dto.password, dto.totpCode,
            req.ip ?? '', req.headers['user-agent'] ?? '',
        );
    }

    @Post('refresh')
    @Public()
    @UseGuards(AuthGuard('jwt-refresh'))
    @HttpCode(HttpStatus.OK)
    refresh(@CurrentUser() user: any, @Req() req: Request) {
        return this.auth.refresh(user.id, user.sessionId, req.ip ?? '', req.headers['user-agent'] ?? '');
    }

    @Post('logout')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @HttpCode(HttpStatus.NO_CONTENT)
    logout(@CurrentUser() user: any) {
        return this.auth.logout(user.sessionId);
    }

    @Post('logout-all')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @HttpCode(HttpStatus.NO_CONTENT)
    logoutAll(@CurrentUser() user: any) {
        return this.auth.logoutAll(user.id);
    }

    @Get('sessions')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    getSessions(@CurrentUser() user: any) {
        return this.auth.getSessions(user.id);
    }

    @Delete('sessions/:id')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @HttpCode(HttpStatus.NO_CONTENT)
    revokeSession(@CurrentUser() user: any, @Param('id') id: string) {
        return this.auth.revokeSession(user.id, id);
    }

    @Get('me')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    me(@CurrentUser() user: any) {
        const { passwordHash, twoFactorSecret, ...safe } = user;
        return safe;
    }

    @Post('change-password')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @HttpCode(HttpStatus.NO_CONTENT)
    changePassword(@CurrentUser() user: any, @Body() dto: ChangePasswordDto, @Req() req: Request) {
        return this.auth.changePassword(user.id, dto, req.ip ?? '');
    }

    @Post('setup-2fa')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    setup2fa(@CurrentUser() user: any) {
        return this.auth.setup2fa(user.id);
    }

    @Post('confirm-2fa')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @HttpCode(HttpStatus.NO_CONTENT)
    confirm2fa(@CurrentUser() user: any, @Body() dto: Setup2faDto) {
        return this.auth.confirm2fa(user.id, dto.totpCode);
    }

    @Delete('disable-2fa')
    @UseGuards(JwtAuthGuard)
    @ApiBearerAuth()
    @HttpCode(HttpStatus.NO_CONTENT)
    disable2fa(@CurrentUser() user: any, @Body() dto: Setup2faDto) {
        return this.auth.disable2fa(user.id, dto.totpCode);
    }
}
