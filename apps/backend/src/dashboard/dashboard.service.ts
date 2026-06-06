import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class DashboardService {
    constructor(private prisma: PrismaService) {}

    async getOverview(companyId: string) {
        const now   = new Date();
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());

        const [stations, todayTx, activeShifts] = await this.prisma.$transaction([
            this.prisma.station.findMany({
                where: { companyId, deletedAt: null },
                select: {
                    id: true, name: true, active: true,
                    lastSyncAt: true, lastSeenAt: true,
                },
            }),
            this.prisma.transaction.aggregate({
                where: {
                    companyId,
                    startedAt:  { gte: today },
                    deletedAt:  null,
                    status:     { in: ['COMPLETED', 'STOPPED'] },
                },
                _sum:   { volume: true },
                _count: { id: true },
            }),
            this.prisma.shift.findMany({
                where: { companyId, status: 'ACTIVE', deletedAt: null },
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
