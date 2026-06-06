import { Controller, Get } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { HealthCheck, HealthCheckService, HttpHealthIndicator } from '@nestjs/terminus';
import { Public } from '../common/decorators/roles.decorator';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
    constructor(
        private health: HealthCheckService,
        private prisma: PrismaService,
    ) {}

    @Get()
    @Public()
    @HealthCheck()
    async check() {
        return this.health.check([
            async () => {
                await this.prisma.$queryRaw`SELECT 1`;
                return { database: { status: 'up' } };
            },
        ]);
    }
}
