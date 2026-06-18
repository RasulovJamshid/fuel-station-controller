import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PaginatedResponse } from '../common/dto/pagination.dto';
import { QueryTransactionsDto } from './dto/query-transactions.dto';

@Injectable()
export class TransactionsService {
    constructor(private prisma: PrismaService) {}

    private async stationIdsForOilBase(companyId: string, oilBaseId: string): Promise<string[]> {
        const rows = await this.prisma.station.findMany({
            where: { companyId, oilBaseId, deletedAt: null },
            select: { id: true },
        });
        return rows.map(r => r.id);
    }

    async findAll(companyId: string, q: QueryTransactionsDto, allowedStationIds?: string[]) {
        if (allowedStationIds && allowedStationIds.length === 0) return { data: [], total: 0, page: 1, pages: 1 };
        const oilBaseIds = q.oilBaseId
            ? await this.stationIdsForOilBase(companyId, q.oilBaseId)
            : null;
        if (oilBaseIds !== null && oilBaseIds.length === 0) return { data: [], total: 0, page: 1, pages: 1 };

        const stationIds = allowedStationIds
            ? (oilBaseIds ?? allowedStationIds).filter(id => allowedStationIds.includes(id))
            : oilBaseIds;
        if (stationIds && stationIds.length === 0) return { data: [], total: 0, page: 1, pages: 1 };

        const where: any = {
            companyId,
            deletedAt: null,
            ...(stationIds       ? { stationId: { in: stationIds } } :
                q.stationId     ? { stationId: q.stationId }        : {}),
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

    async findOne(id: string, companyId: string, allowedStationIds?: string[]) {
        if (allowedStationIds && allowedStationIds.length === 0) {
            throw new NotFoundException('Transaction not found');
        }
        const tx = await this.prisma.transaction.findFirst({
            where: {
                id,
                companyId,
                deletedAt: null,
                ...(allowedStationIds ? { stationId: { in: allowedStationIds } } : {}),
            },
        });
        if (!tx) throw new NotFoundException('Transaction not found');
        return tx;
    }

    async summarize(companyId: string, q: QueryTransactionsDto, allowedStationIds?: string[]) {
        if (allowedStationIds && allowedStationIds.length === 0) return { count: 0, totalVolume: 0 };
        const oilBaseIds = q.oilBaseId
            ? await this.stationIdsForOilBase(companyId, q.oilBaseId)
            : null;
        if (oilBaseIds !== null && oilBaseIds.length === 0) return { count: 0, totalVolume: 0 };

        const stationIds = allowedStationIds
            ? (oilBaseIds ?? allowedStationIds).filter(id => allowedStationIds.includes(id))
            : oilBaseIds;
        if (stationIds && stationIds.length === 0) return { count: 0, totalVolume: 0 };

        const where: any = {
            companyId,
            deletedAt: null,
            ...(stationIds       ? { stationId: { in: stationIds } } :
                q.stationId     ? { stationId: q.stationId }        : {}),
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
