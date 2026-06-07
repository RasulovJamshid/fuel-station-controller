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
            this.checkStationOffline(),
            this.checkSyncLag(),
        ]);
    }

    private async checkStationOffline() {
        const offlineThresholdMs = 15 * 60 * 1000; // 15 minutes
        const cutoff = new Date(Date.now() - offlineThresholdMs);

        const stations = await this.prisma.station.findMany({
            where: {
                active: true,
                deletedAt: null,
                OR: [
                    { lastSeenAt: { lt: cutoff } },
                    { lastSeenAt: null },
                ],
            },
            select: { id: true, companyId: true, name: true, lastSeenAt: true },
        });

        for (const station of stations) {
            const rules = await this.prisma.alertRule.findMany({
                where: {
                    companyId: station.companyId,
                    type: 'station_offline',
                    enabled: true,
                    OR: [{ stationId: station.id }, { stationId: null }],
                },
            });

            if (rules.length > 0) {
                const ago = station.lastSeenAt
                    ? Math.round((Date.now() - station.lastSeenAt.getTime()) / 60_000) + ' мин.'
                    : 'никогда';
                await this.notify.sendAlert({
                    type: 'station_offline',
                    stationId: station.id,
                    message: `🔴 Станция <b>${station.name}</b> не выходила на связь (${ago})`,
                });
            }
        }
    }

    private async checkSyncLag() {
        const lagThresholdMs = 60 * 60 * 1000; // 1 hour without sync
        const cutoff = new Date(Date.now() - lagThresholdMs);

        const stations = await this.prisma.station.findMany({
            where: {
                active: true,
                deletedAt: null,
                OR: [
                    { lastSyncAt: { lt: cutoff } },
                    { lastSyncAt: null },
                ],
            },
            select: { id: true, companyId: true, name: true, lastSyncAt: true },
        });

        for (const station of stations) {
            const rules = await this.prisma.alertRule.findMany({
                where: {
                    companyId: station.companyId,
                    type: 'sync_lag',
                    enabled: true,
                    OR: [{ stationId: station.id }, { stationId: null }],
                },
            });

            if (rules.length > 0) {
                const ago = station.lastSyncAt
                    ? Math.round((Date.now() - station.lastSyncAt.getTime()) / 60_000) + ' мин.'
                    : 'никогда';
                await this.notify.sendAlert({
                    type: 'sync_lag',
                    stationId: station.id,
                    message: `⚠️ Станция <b>${station.name}</b>: нет синхронизации уже ${ago}`,
                });
            }
        }
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
