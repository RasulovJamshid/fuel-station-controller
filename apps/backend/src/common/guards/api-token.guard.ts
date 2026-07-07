import {
    Injectable,
    CanActivate,
    ExecutionContext,
    UnauthorizedException,
    ForbiddenException,
    HttpException,
    HttpStatus,
    Logger,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PrismaService } from '../../prisma/prisma.service';
import { hashApiToken } from '../helpers/api-token.util';
import { API_SCOPES_KEY, ApiScope } from '../decorators/api-scopes.decorator';

/**
 * Per-token fixed-window rate limiter. In-memory (per instance), matching
 * the express-rate-limit memory store used elsewhere; swap for a Redis
 * store if the backend is scaled horizontally.
 */
const rateWindows = new Map<string, { windowStart: number; count: number }>();

function checkRateLimit(tokenId: string, limitPerMin: number): { ok: boolean; retryAfter: number } {
    const now = Date.now();
    const win = rateWindows.get(tokenId);
    if (!win || now - win.windowStart >= 60_000) {
        rateWindows.set(tokenId, { windowStart: now, count: 1 });
        return { ok: true, retryAfter: 0 };
    }
    win.count += 1;
    if (win.count > limitPerMin) {
        return { ok: false, retryAfter: Math.ceil((win.windowStart + 60_000 - now) / 1000) };
    }
    return { ok: true, retryAfter: 0 };
}

/**
 * Authenticates external integrations via the `X-Api-Token` header.
 * Validates the token (active, not revoked, not expired, IP-allowed),
 * enforces the endpoint's required scopes, and attaches the resolved
 * token context to `req.apiToken`.
 */
@Injectable()
export class ApiTokenGuard implements CanActivate {
    private readonly logger = new Logger(ApiTokenGuard.name);

    constructor(private prisma: PrismaService, private reflector: Reflector) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req       = context.switchToHttp().getRequest();
        const presented = (req.headers['x-api-token'] as string | undefined)?.trim();

        if (!presented) throw new UnauthorizedException('Missing X-Api-Token');

        const token = await this.prisma.apiToken.findUnique({
            where: { tokenHash: hashApiToken(presented) },
        });

        if (!token || !token.active || token.revokedAt) {
            throw new UnauthorizedException('Invalid API token');
        }
        if (token.expiresAt && token.expiresAt.getTime() < Date.now()) {
            throw new UnauthorizedException('API token expired');
        }

        // ── IP allowlist (empty = any source) ───────────────────────
        if (token.ipAllowlist.length > 0) {
            const ip = (req.ip ?? req.socket?.remoteAddress ?? '').replace(/^::ffff:/, '');
            if (!token.ipAllowlist.includes(ip)) {
                this.logger.warn(`Token ${token.tokenPrefix} rejected from IP ${ip}`);
                throw new ForbiddenException('Source IP not allowed');
            }
        }

        // ── Scope enforcement ───────────────────────────────────────
        const required = this.reflector.getAllAndOverride<ApiScope[]>(API_SCOPES_KEY, [
            context.getHandler(),
            context.getClass(),
        ]) ?? [];
        const missing = required.filter(s => !token.scopes.includes(s));
        if (missing.length > 0) {
            throw new ForbiddenException(`Token missing required scope(s): ${missing.join(', ')}`);
        }

        // ── Per-token rate limit ────────────────────────────────────
        const { ok, retryAfter } = checkRateLimit(token.id, token.rateLimitPerMin);
        if (!ok) {
            const res = context.switchToHttp().getResponse();
            res?.setHeader?.('Retry-After', String(retryAfter));
            throw new HttpException(
                `Rate limit exceeded (${token.rateLimitPerMin}/min)`,
                HttpStatus.TOO_MANY_REQUESTS,
            );
        }

        req.apiToken = {
            id:         token.id,
            companyId:  token.companyId,
            scopes:     token.scopes,
            oilBaseIds: token.oilBaseIds,
            stationIds: token.stationIds,
        };

        // Best-effort last-used stamp; never block or fail the request on it.
        this.prisma.apiToken
            .update({ where: { id: token.id }, data: { lastUsedAt: new Date() } })
            .catch(() => undefined);

        return true;
    }
}
