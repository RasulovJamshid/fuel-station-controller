import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
    private readonly logger = new Logger(PrismaService.name);

    constructor() {
        super({
            log: [
                { emit: 'event', level: 'query' },
                { emit: 'stdout', level: 'error' },
                { emit: 'stdout', level: 'warn' },
            ],
        });

        this.$use(this.softDeleteMiddleware);
    }

    async onModuleInit() {
        await this.$connect();
        this.logger.log('Database connected');
    }

    async onModuleDestroy() {
        await this.$disconnect();
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
