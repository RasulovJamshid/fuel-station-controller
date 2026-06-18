import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

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

        const now   = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        const stationFilter = stationIds ? { id: { in: stationIds } } : {};

        const [stations, todayTx, activeShifts] = await this.prisma.$transaction([
            this.prisma.station.findMany({
                where: { companyId, deletedAt: null, ...stationFilter },
                select: {
                    id: true, name: true, active: true,
                    lastSyncAt: true, lastSeenAt: true,
                },
            }),
            this.prisma.transaction.aggregate({
                where: {
                    companyId,
                    ...(stationIds ? { stationId: { in: stationIds } } : {}),
                    startedAt:  { gte: today },
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
                select: { id: true, stationId: true, operatorName: true, startedAt: true },
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
