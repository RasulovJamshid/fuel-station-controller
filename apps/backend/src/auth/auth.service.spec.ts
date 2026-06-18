import * as bcrypt from 'bcrypt';
import { JwtService } from '@nestjs/jwt';
import { UnauthorizedException } from '@nestjs/common';
import { AuthService } from './auth.service';

describe('AuthService', () => {
    const config: any = {
        get: jest.fn((key: string, fallback?: any) => ({
            JWT_SECRET: 'access-secret-access-secret-access-secret',
            JWT_REFRESH_SECRET: 'refresh-secret-refresh-secret-refresh',
            JWT_EXPIRES_IN: '15m',
            JWT_REFRESH_EXPIRES_IN: '30d',
            MAX_LOGIN_ATTEMPTS: 2,
            LOGIN_LOCKOUT_MINUTES: 15,
        }[key] ?? fallback)),
    };

    function makeService(prisma: any) {
        return new AuthService(
            prisma,
            new JwtService(),
            config,
            { log: jest.fn() } as any,
        );
    }

    it('issues tokens and creates a session on valid login', async () => {
        const passwordHash = await bcrypt.hash('Secret123', 4);
        const prisma: any = {
            user: {
                findFirst: jest.fn().mockResolvedValue({
                    id: 'user-1',
                    companyId: 'company-1',
                    email: 'admin@example.com',
                    role: 'SUPER_ADMIN',
                    passwordHash,
                    loginAttempts: 0,
                    lockedUntil: null,
                    twoFactorEnabled: false,
                }),
                update: jest.fn().mockResolvedValue({}),
            },
            session: {
                create: jest.fn().mockResolvedValue({}),
            },
        };

        const result = await makeService(prisma).login(
            'admin@example.com',
            'Secret123',
            undefined,
            '127.0.0.1',
            'jest',
        );

        expect(result.accessToken).toEqual(expect.any(String));
        expect(result.refreshToken).toEqual(expect.any(String));
        expect(prisma.session.create).toHaveBeenCalledWith({
            data: expect.objectContaining({
                userId: 'user-1',
                userAgent: 'jest',
                ipAddress: '127.0.0.1',
            }),
        });
    });

    it('increments failed attempts and locks the account at threshold', async () => {
        const passwordHash = await bcrypt.hash('Secret123', 4);
        const prisma: any = {
            user: {
                findFirst: jest.fn().mockResolvedValue({
                    id: 'user-1',
                    passwordHash,
                    loginAttempts: 1,
                    lockedUntil: null,
                }),
                update: jest.fn().mockResolvedValue({}),
            },
            session: { create: jest.fn() },
        };

        await expect(makeService(prisma).login(
            'admin@example.com',
            'Wrong123',
            undefined,
            '127.0.0.1',
            'jest',
        )).rejects.toBeInstanceOf(UnauthorizedException);

        expect(prisma.user.update).toHaveBeenCalledWith({
            where: { id: 'user-1' },
            data: expect.objectContaining({
                loginAttempts: 2,
                lockedUntil: expect.any(Date),
            }),
        });
    });
});
