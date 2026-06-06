import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from './notifications.service';

@Injectable()
export class AlertsService {
    private readonly logger = new Logger(AlertsService.name);

    constructor(
        private prisma:  PrismaService,
        private notify:  NotificationsService,
    ) {}

    @Cron('*/10 * * * *')
    async checkAlerts() {
        await Promise.all([
            this.checkTankLevels(),
        ]);
    }

    private async checkTankLevels() {
        const latestReadings: any[] = await this.prisma.$queryRaw`
            SELECT DISTINCT ON (r.id)
                r.id, r."stationId", r."companyId", r.label, r."productName",
                rr."fillPercent"
            FROM "Reservoir" r
            JOIN "ReservoirReading" rr ON rr."reservoirId" = r.id
            WHERE r.active = true AND r."deletedAt" IS NULL
            ORDER BY r.id, rr."readingAt" DESC
        `;

        for (const reading of latestReadings) {
            if (reading.fillPercent == null) continue;

            const rules = await this.prisma.alertRule.findMany({
                where: {
                    companyId: reading.companyId,
                    type: 'tank_low',
                    enabled: true,
                    OR: [{ stationId: reading.stationId }, { stationId: null }],
                },
            });

            for (const rule of rules) {
                if (rule.threshold != null && reading.fillPercent < rule.threshold) {
                    await this.notify.sendAlert({
                        type:      'tank_low',
                        stationId: reading.stationId,
                        message:   `⚠️ Tank <b>${reading.label}</b> (${reading.productName}) at ${reading.fillPercent.toFixed(0)}%`,
                    });
                }
            }
        }
    }
}
