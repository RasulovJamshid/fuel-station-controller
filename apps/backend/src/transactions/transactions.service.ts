import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PaginatedResponse } from '../common/dto/pagination.dto';
import { QueryTransactionsDto } from './dto/query-transactions.dto';

@Injectable()
export class TransactionsService {
    constructor(private prisma: PrismaService) {}

    async findAll(companyId: string, q: QueryTransactionsDto) {
        const where: any = {
            companyId,
            deletedAt: null,
            ...(q.stationId     ? { stationId: q.stationId }     : {}),
            ...(q.fpId          ? { fpId: q.fpId }               : {}),
            ...(q.shiftId       ? { shiftId: q.shiftId }         : {}),
            ...(q.operatorName  ? { operatorName: { contains: q.operatorName, mode: 'insensitive' } } : {}),
            ...(q.status?.length ? { status: { in: q.status } }  : {}),
            ...(q.from || q.to  ? {
                startedAt: {
                    ...(q.from ? { gte: new Date(q.from) } : {}),
                    ...(q.to   ? { lte: new Date(q.to)   } : {}),
                }
            } : {}),
        };

        const [data, total] = await this.prisma.$transaction([
            this.prisma.transaction.findMany({
                where,
                orderBy: { startedAt: 'desc' },
                skip:    q.skip,
                take:    q.limit,
            }),
            this.prisma.transaction.count({ where }),
        ]);

        return PaginatedResponse.of(data, total, q);
    }

    async findOne(id: string, companyId: string) {
        const tx = await this.prisma.transaction.findFirst({
            where: { id, companyId, deletedAt: null },
        });
        if (!tx) throw new NotFoundException('Transaction not found');
        return tx;
    }

    async summarize(companyId: string, q: QueryTransactionsDto) {
        const where: any = {
            companyId,
            deletedAt: null,
            ...(q.stationId     ? { stationId: q.stationId }    : {}),
            ...(q.fpId          ? { fpId: q.fpId }              : {}),
            ...(q.shiftId       ? { shiftId: q.shiftId }        : {}),
            ...(q.status?.length ? { status: { in: q.status } } : {}),
            ...(q.from || q.to  ? {
                startedAt: {
                    ...(q.from ? { gte: new Date(q.from) } : {}),
                    ...(q.to   ? { lte: new Date(q.to)   } : {}),
                }
            } : {}),
        };

        const agg = await this.prisma.transaction.aggregate({
            where,
            _count: { id: true },
            _sum:   { volume: true },
        });

        return {
            count:       agg._count.id,
            totalVolume: agg._sum.volume ?? 0,
        };
    }
}
