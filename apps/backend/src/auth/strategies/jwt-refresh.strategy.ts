import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { Request } from 'express';
import { PrismaService } from '../../prisma/prisma.service';

@Injectable()
export class JwtRefreshStrategy extends PassportStrategy(Strategy, 'jwt-refresh') {
    constructor(config: ConfigService, private prisma: PrismaService) {
        super({
            jwtFromRequest: ExtractJwt.fromBodyField('refreshToken'),
            secretOrKey:    config.get<string>('JWT_REFRESH_SECRET'),
            passReqToCallback: true,
            ignoreExpiration: false,
        });
    }

    async validate(req: Request, payload: any) {
        const refreshToken = req.body?.refreshToken as string;
        const session = await this.prisma.session.findFirst({
            where: { refreshToken, userId: payload.sub, expiresAt: { gt: new Date() } },
            include: { user: true },
        });
        if (!session || !session.user.active) {
            throw new UnauthorizedException('Invalid or expired refresh token');
        }
        return { ...session.user, sessionId: session.id };
    }
}
