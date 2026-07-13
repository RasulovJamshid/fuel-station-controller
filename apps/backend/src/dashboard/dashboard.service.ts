import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { currentDayUtcRange } from '../common/utils/timezone';

@Injectable()
export class DashboardService {
    constructor(private prisma: PrismaService) {}

    async getOverview(companyId: string, stationIds?: string[]) {
        if (stationIds && stationIds.length === 0) {
            return {
                stations: 0,
                activeShifts: 0,
                todayTransactions: 0,
                todayVolume: 0,
                stationSummaries: [],
                activeShiftsList: [],
            };
        }

        const stationFilter = stationIds ? { id: { in: stationIds } } : {};

        const stations = await this.prisma.station.findMany({
            where: { companyId, deletedAt: null, ...stationFilter },
            select: {
                id: true, name: true, active: true,
                lastSyncAt: true, lastSeenAt: true, timezone: true,
            },
        });

        if (stations.length === 0) {
            return {
                stations: 0,
                activeShifts: 0,
                todayTransactions: 0,
                todayVolume: 0,
                stationSummaries: [],
                activeShiftsList: [],
            };
        }

        const todayByStation = stations.map(station => {
            const { start, end } = currentDayUtcRange(station.timezone ?? 'UTC');
            return { stationId: station.id, startedAt: { gte: start, lt: end } };
        });

        const [todayTx, activeShifts] = await this.prisma.$transaction([
            this.prisma.transaction.aggregate({
                where: {
                    companyId,
                    OR: todayByStation,
                    deletedAt:  null,
                    status:     { in: ['COMPLETED', 'STOPPED'] },
                },
                _sum:   { volume: true },
                _count: { id: true },
            }),
            this.prisma.shift.findMany({
                where: {
                    companyId,
                    status: 'ACTIVE',
                    deletedAt: null,
                    ...(stationIds ? { stationId: { in: stationIds } } : {}),
                },
                select: {
                    id: true, stationId: true, operatorName: true, startedAt: true,
                    totalTransactions: true, totalVolume: true, totalAmount: true,
                    station: { select: { name: true } },
                },
                orderBy: { startedAt: 'desc' },
            }),
        ]);

        return {
            stations:    stations.length,
            activeShifts: activeShifts.length,
            todayTransactions: todayTx._count.id,
            todayVolume:       todayTx._sum.volume ?? 0,
            stationSummaries:  stations,
            activeShiftsList:  activeShifts,
        };
    }
}
