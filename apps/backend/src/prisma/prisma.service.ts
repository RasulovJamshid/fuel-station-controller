import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

// Maximum time (ms) a query is allowed to run before it's logged as slow.
const SLOW_QUERY_THRESHOLD_MS = 1_000;

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(PrismaService.name);

    constructor() {
        super({
            datasources: {
                db: {
                    // Allow overriding pool size and timeout via env.
                    // Example: DATABASE_URL=postgresql://...?connection_limit=10&pool_timeout=30
                    url: process.env.DATABASE_URL,
                },
            },
            log: [
                { emit: 'event', level: 'query' },
                { emit: 'event', level: 'error' },
                { emit: 'stdout', level: 'warn' },
            ],
        });

        // Log slow queries so they appear in pino output alongside request IDs.
        (this as any).$on('query', (e: any) => {
            if (e.duration >= SLOW_QUERY_THRESHOLD_MS) {
                this.logger.warn(
                    `Slow query (${e.duration}ms): ${e.query.substring(0, 200)}`,
                );
            }
        });

        (this as any).$on('error', (e: any) => {
            this.logger.error(`Prisma error: ${e.message}`);
        });

        this.$use(this.softDeleteMiddleware);
    }

    async onModuleInit() {
        let retries = 5;
        while (retries > 0) {
            try {
                await this.$connect();
                this.logger.log('Database connected');
                return;
            } catch (e: any) {
                retries--;
                this.logger.error(
                    `Database connection failed (${5 - retries}/5): ${e.message}`,
                );
                if (retries === 0) throw e;
                await new Promise(r => setTimeout(r, 3_000));
            }
        }
    }

    async onModuleDestroy() {
        await this.$disconnect();
        this.logger.log('Database disconnected');
    }

    private softDeleteMiddleware: Parameters<PrismaClient['$use']>[0] = async (params, next) => {
        const softDeleteModels = [
            'User', 'Company', 'Station', 'FuelingPosition',
            'Reservoir', 'Transaction', 'Shift',
        ];

        if (!softDeleteModels.includes(params.model ?? '')) return next(params);

        if (params.action === 'findMany' || params.action === 'findFirst') {
            params.args ??= {};
            params.args.where = { deletedAt: null, ...params.args.where };
        }

        if (params.action === 'findUnique') {
            params.action = 'findFirst';
            params.args ??= {};
            params.args.where = { deletedAt: null, ...params.args.where };
        }

        if (params.action === 'delete') {
            params.action    = 'update';
            params.args.data = { deletedAt: new Date() };
        }

        if (params.action === 'deleteMany') {
            params.action    = 'updateMany';
            params.args.data = { deletedAt: new Date() };
        }

        return next(params);
    };
}
