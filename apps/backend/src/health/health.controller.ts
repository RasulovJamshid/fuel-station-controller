import { Controller, Get } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiOkResponse, ApiServiceUnavailableResponse } from '@nestjs/swagger';
import { ConfigService } from '@nestjs/config';
import { HealthCheck, HealthCheckService, MemoryHealthIndicator } from '@nestjs/terminus';
import Redis from 'ioredis';
import { Public } from '../common/decorators/roles.decorator';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('health')
@Controller('health')
export class HealthController {
    private readonly startedAt = Date.now();

    constructor(
        private health: HealthCheckService,
        private prisma: PrismaService,
        private config: ConfigService,
        private memory: MemoryHealthIndicator,
    ) {}

    @Get()
    @ApiOperation({ summary: 'Readiness probe alias checking database, Redis and heap memory' })
    @ApiOkResponse({ description: 'All dependencies are healthy' })
    @ApiServiceUnavailableResponse({ description: 'One or more dependencies are unhealthy' })
    @Public()
    check() {
        return this.ready();
    }

    @Get('live')
    @ApiOperation({ summary: 'Liveness probe reporting process uptime and start time' })
    @ApiOkResponse({ description: 'Process is alive; returns uptime and start timestamp' })
    @Public()
    live() {
        return {
            status: 'ok',
            uptimeSeconds: Math.floor(process.uptime()),
            startedAt: new Date(this.startedAt).toISOString(),
        };
    }

    @Get('ready')
    @ApiOperation({ summary: 'Readiness probe checking database, Redis and heap memory' })
    @ApiOkResponse({ description: 'All dependencies are healthy' })
    @ApiServiceUnavailableResponse({ description: 'One or more dependencies are unhealthy' })
    @Public()
    @HealthCheck()
    async ready() {
        return this.health.check([
            async () => {
                await this.prisma.$queryRaw`SELECT 1`;
                return { database: { status: 'up' } };
            },
            async () => {
                const redis = new Redis(this.config.get<string>('REDIS_URL')!, {
                    maxRetriesPerRequest: 1,
                    lazyConnect: true,
                });
                try {
                    await redis.connect();
                    await redis.ping();
                    return { redis: { status: 'up' } };
                } finally {
                    redis.disconnect();
                }
            },
            () => this.memory.checkHeap('memory_heap', 512 * 1024 * 1024),
        ]);
    }

    @Get('metrics')
    @ApiOperation({ summary: 'Report process and memory usage metrics' })
    @ApiOkResponse({ description: 'Current process info and memory usage snapshot' })
    @Public()
    metrics() {
        const memory = process.memoryUsage();
        return {
            process: {
                uptimeSeconds: Math.floor(process.uptime()),
                pid: process.pid,
                node: process.version,
            },
            memory: {
                rss: memory.rss,
                heapTotal: memory.heapTotal,
                heapUsed: memory.heapUsed,
                external: memory.external,
            },
        };
    }
}
