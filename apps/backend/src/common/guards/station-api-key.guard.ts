import {
    Injectable,
    CanActivate,
    ExecutionContext,
    UnauthorizedException,
    ForbiddenException,
} from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import { Logger } from '@nestjs/common';

@Injectable()
export class StationApiKeyGuard implements CanActivate {
    private readonly logger = new Logger(StationApiKeyGuard.name);

    constructor(private prisma: PrismaService) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const req       = context.switchToHttp().getRequest();
        const apiKey    = req.headers['x-api-key'] as string;
        const stationId = req.params.stationId;

        if (!apiKey) throw new UnauthorizedException('Missing X-Api-Key');

        const station = await this.prisma.station.findFirst({
            where: { id: stationId, apiKey, active: true, deletedAt: null },
        });

        if (!station) throw new UnauthorizedException('Invalid API key');

        if (station.ipAllowlist.length > 0) {
            const ip = req.ip ?? req.socket?.remoteAddress ?? '';
            const clean = ip.replace(/^::ffff:/, '');
            if (!station.ipAllowlist.includes(clean)) {
                this.logger.warn(`Station ${stationId} rejected from IP ${clean}`);
                throw new ForbiddenException('IP not in allowlist');
            }
        }

        req.station = station;
        return true;
    }
}
