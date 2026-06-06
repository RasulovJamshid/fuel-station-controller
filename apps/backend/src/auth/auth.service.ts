import {
    Injectable,
    UnauthorizedException,
    BadRequestException,
    Logger,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { authenticator } from 'otplib';
import * as qrcode from 'qrcode';
import { v4 as uuidv4 } from 'uuid';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { ChangePasswordDto } from './dto/login.dto';

const PASSWORD_REGEX = /(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}/;

@Injectable()
export class AuthService {
    private readonly logger = new Logger(AuthService.name);

    constructor(
        private prisma:  PrismaService,
        private jwt:     JwtService,
        private config:  ConfigService,
        private audit:   AuditService,
    ) {}

    async login(email: string, password: string, totpCode: string | undefined, ip: string, userAgent: string) {
        const user = await this.prisma.user.findFirst({
            where: { email, deletedAt: null },
        });

        if (user?.lockedUntil && user.lockedUntil > new Date()) {
            throw new UnauthorizedException('Account locked — too many failed attempts');
        }

        const valid = user ? await bcrypt.compare(password, user.passwordHash) : false;

        if (!user || !valid) {
            if (user) {
                const attempts = user.loginAttempts + 1;
                const maxAttempts = this.config.get<number>('MAX_LOGIN_ATTEMPTS', 5);
                const lockMinutes = this.config.get<number>('LOGIN_LOCKOUT_MINUTES', 15);
                await this.prisma.user.update({
                    where: { id: user.id },
                    data: {
                        loginAttempts: attempts,
                        lockedUntil: attempts >= maxAttempts
                            ? new Date(Date.now() + lockMinutes * 60_000)
                            : undefined,
                    },
                });
            }
            throw new UnauthorizedException('Invalid credentials');
        }

        if (user.twoFactorEnabled) {
            if (!totpCode) throw new UnauthorizedException('TOTP code required');
            const valid2fa = authenticator.verify({ token: totpCode, secret: user.twoFactorSecret! });
            if (!valid2fa) throw new UnauthorizedException('Invalid TOTP code');
        }

        await this.prisma.user.update({
            where: { id: user.id },
            data: { loginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() },
        });

        await this.audit.log({
            companyId: user.companyId,
            userId:    user.id,
            userEmail: user.email,
            action:    'LOGIN',
            entity:    'User',
            entityId:  user.id,
            ipAddress: ip,
        });

        return this.issueTokens(user.id, user.email, user.role, user.companyId, ip, userAgent);
    }

    async refresh(userId: string, sessionId: string, ip: string, userAgent: string) {
        await this.prisma.session.delete({ where: { id: sessionId } });

        const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
        return this.issueTokens(user.id, user.email, user.role, user.companyId, ip, userAgent);
    }

    async logout(sessionId: string) {
        await this.prisma.session.deleteMany({ where: { id: sessionId } });
    }

    async logoutAll(userId: string) {
        await this.prisma.session.deleteMany({ where: { userId } });
    }

    async getSessions(userId: string) {
        return this.prisma.session.findMany({
            where: { userId, expiresAt: { gt: new Date() } },
            select: { id: true, userAgent: true, ipAddress: true, createdAt: true, lastUsedAt: true },
            orderBy: { lastUsedAt: 'desc' },
        });
    }

    async revokeSession(userId: string, sessionId: string) {
        await this.prisma.session.deleteMany({ where: { id: sessionId, userId } });
    }

    async changePassword(userId: string, dto: ChangePasswordDto, ip: string) {
        const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });

        if (!await bcrypt.compare(dto.currentPassword, user.passwordHash)) {
            throw new UnauthorizedException('Current password is incorrect');
        }

        if (!PASSWORD_REGEX.test(dto.newPassword)) {
            throw new BadRequestException(
                'Password must be at least 8 characters with uppercase, lowercase, and a number',
            );
        }

        const history = await this.prisma.passwordHistory.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            take: 5,
        });
        for (const h of history) {
            if (await bcrypt.compare(dto.newPassword, h.passwordHash)) {
                throw new BadRequestException('Cannot reuse one of your last 5 passwords');
            }
        }

        const rounds = this.config.get<number>('BCRYPT_ROUNDS', 12);
        const hash   = await bcrypt.hash(dto.newPassword, rounds);

        await this.prisma.$transaction([
            this.prisma.user.update({
                where: { id: userId },
                data: { passwordHash: hash, passwordChangedAt: new Date() },
            }),
            this.prisma.passwordHistory.create({ data: { userId, passwordHash: hash } }),
            this.prisma.session.deleteMany({ where: { userId } }),
        ]);

        await this.audit.log({
            companyId: user.companyId,
            userId:    user.id,
            userEmail: user.email,
            action:    'CHANGE_PASSWORD',
            entity:    'User',
            entityId:  user.id,
            ipAddress: ip,
        });
    }

    async setup2fa(userId: string) {
        const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
        const secret = authenticator.generateSecret();
        const otpauth = authenticator.keyuri(user.email, 'AZS Manager', secret);
        const qr = await qrcode.toDataURL(otpauth);

        await this.prisma.user.update({
            where: { id: userId },
            data: { twoFactorSecret: secret, twoFactorEnabled: false },
        });

        return { qr, secret };
    }

    async confirm2fa(userId: string, totpCode: string) {
        const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
        if (!user.twoFactorSecret) throw new BadRequestException('2FA not initialized');

        if (!authenticator.verify({ token: totpCode, secret: user.twoFactorSecret })) {
            throw new BadRequestException('Invalid TOTP code');
        }

        await this.prisma.user.update({
            where: { id: userId },
            data: { twoFactorEnabled: true },
        });
    }

    async disable2fa(userId: string, totpCode: string) {
        const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
        if (!user.twoFactorEnabled || !user.twoFactorSecret) {
            throw new BadRequestException('2FA is not enabled');
        }
        if (!authenticator.verify({ token: totpCode, secret: user.twoFactorSecret })) {
            throw new UnauthorizedException('Invalid TOTP code');
        }
        await this.prisma.user.update({
            where: { id: userId },
            data: { twoFactorEnabled: false, twoFactorSecret: null },
        });
    }

    private async issueTokens(
        userId: string,
        email: string,
        role: string,
        companyId: string,
        ip: string,
        userAgent: string,
    ) {
        const sessionId = uuidv4();
        const payload = { sub: userId, email, role, companyId, sessionId };

        const accessToken = this.jwt.sign(payload, {
            secret:    this.config.get<string>('JWT_SECRET'),
            expiresIn: this.config.get<string>('JWT_EXPIRES_IN', '15m'),
        });

        const refreshToken = this.jwt.sign(payload, {
            secret:    this.config.get<string>('JWT_REFRESH_SECRET'),
            expiresIn: this.config.get<string>('JWT_REFRESH_EXPIRES_IN', '30d'),
        });

        const expiresAt = new Date(
            Date.now() + this.parseDuration(this.config.get<string>('JWT_REFRESH_EXPIRES_IN', '30d'))
        );

        await this.prisma.session.create({
            data: { id: sessionId, userId, refreshToken, userAgent, ipAddress: ip, expiresAt },
        });

        return { accessToken, refreshToken };
    }

    private parseDuration(s: string): number {
        const units: Record<string, number> = { m: 60_000, h: 3_600_000, d: 86_400_000 };
        const match = s.match(/^(\d+)([mhd])$/);
        if (!match) return 86_400_000 * 30;
        return parseInt(match[1]) * (units[match[2]] ?? 60_000);
    }
}
