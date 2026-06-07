import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type GroupBy = 'day' | 'week' | 'month';

const BUCKET: Record<GroupBy, string> = {
    day:   '1 day',
    week:  '1 week',
    month: '1 month',
};

@Injectable()
export class ReportsService {
    constructor(
        private prisma: PrismaService,
        @InjectQueue('reports') private queue: Queue,
    ) {}

    async getRevenueSummary(
        companyId:  string,
        stationIds: string[],
        from:       Date,
        to:         Date,
        groupBy:    GroupBy = 'day',
    ) {
        const bucket = BUCKET[groupBy];
        const stationFilter = stationIds.length > 0
            ? Prisma.sql`AND "stationId" = ANY(${stationIds})`
            : Prisma.empty;

        return this.prisma.$queryRaw<any[]>`
            SELECT
                date_trunc(${bucket}, "startedAt")   AS period,
                "stationId",
                "productName",
                COUNT(*)::int                         AS tx_count,
                COALESCE(SUM(volume), 0)              AS total_volume,
                COALESCE(SUM(amount::numeric), 0)     AS total_amount
            FROM "Transaction"
            WHERE
                "companyId" = ${companyId}
                ${stationFilter}
                AND "startedAt" BETWEEN ${from} AND ${to}
                AND status IN ('COMPLETED', 'STOPPED')
                AND "deletedAt" IS NULL
            GROUP BY 1, 2, 3
            ORDER BY 1 DESC
        `;
    }

    async getOperatorReport(companyId: string, from: Date, to: Date, stationIds: string[] = []) {
        const stationFilter = stationIds.length > 0
            ? Prisma.sql`AND "stationId" = ANY(${stationIds})`
            : Prisma.empty;

        return this.prisma.$queryRaw<any[]>`
            SELECT
                "operatorName",
                "stationId",
                COUNT(*)::int                     AS tx_count,
                COALESCE(SUM(volume), 0)          AS total_volume,
                COALESCE(SUM(amount::numeric), 0) AS total_amount
            FROM "Transaction"
            WHERE
                "companyId" = ${companyId}
                ${stationFilter}
                AND "startedAt" BETWEEN ${from} AND ${to}
                AND status IN ('COMPLETED', 'STOPPED')
                AND "deletedAt" IS NULL
            GROUP BY "operatorName", "stationId"
            ORDER BY total_amount DESC
        `;
    }

    async getProductReport(companyId: string, from: Date, to: Date, stationIds: string[] = []) {
        const stationFilter = stationIds.length > 0
            ? Prisma.sql`AND "stationId" = ANY(${stationIds})`
            : Prisma.empty;

        return this.prisma.$queryRaw<any[]>`
            SELECT
                "productName",
                "productId",
                COUNT(*)::int                     AS tx_count,
                COALESCE(SUM(volume), 0)          AS total_volume,
                COALESCE(SUM(amount::numeric), 0) AS total_amount
            FROM "Transaction"
            WHERE
                "companyId" = ${companyId}
                ${stationFilter}
                AND "startedAt" BETWEEN ${from} AND ${to}
                AND status IN ('COMPLETED', 'STOPPED')
                AND "deletedAt" IS NULL
            GROUP BY "productName", "productId"
            ORDER BY total_volume DESC
        `;
    }

    async requestExport(userId: string, companyId: string, params: any) {
        const job = await this.queue.add('export', { userId, companyId, params });
        return { jobId: job.id, message: 'Export started — you will be notified when ready' };
    }
}
