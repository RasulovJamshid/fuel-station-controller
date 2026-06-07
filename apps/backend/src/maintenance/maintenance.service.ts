import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class MaintenanceService {
    private readonly logger = new Logger(MaintenanceService.name);

    constructor(
        private prisma:  PrismaService,
        private config:  ConfigService,
    ) {}

    /** Runs at 03:15 every night — outside business hours for most time zones. */
    @Cron('15 3 * * *')
    async runRetention() {
        this.logger.log('Data retention job started');
        await Promise.all([
            this.purgeTransactions(),
            this.purgeReservoirReadings(),
            this.purgeHealthEvents(),
            this.purgeProcessedSyncRecords(),
            this.purgeWebhookDeliveries(),
            this.purgeAuditLogs(),
        ]);
        this.logger.log('Data retention job complete');
    }

    private async purgeTransactions() {
        const days = this.config.get<number>('TRANSACTION_RETENTION_DAYS', 1825);
        if (days <= 0) return;
        const cutoff = new Date(Date.now() - days * 86_400_000);
        const { count } = await this.prisma.transaction.deleteMany({
            where: { startedAt: { lt: cutoff } },
        });
        if (count > 0) this.logger.log(`Purged ${count} transactions older than ${days} days`);
    }

    private async purgeReservoirReadings() {
        const days = this.config.get<number>('ATG_READINGS_RAW_RETENTION_DAYS', 90);
        if (days <= 0) return;
        const cutoff = new Date(Date.now() - days * 86_400_000);
        const { count } = await this.prisma.reservoirReading.deleteMany({
            where: { readingAt: { lt: cutoff } },
        });
        if (count > 0) this.logger.log(`Purged ${count} reservoir readings older than ${days} days`);
    }

    private async purgeHealthEvents() {
        const days = this.config.get<number>('HEALTH_EVENTS_RETENTION_DAYS', 30);
        if (days <= 0) return;
        const cutoff = new Date(Date.now() - days * 86_400_000);
        const { count } = await this.prisma.stationHealthEvent.deleteMany({
            where: { occurredAt: { lt: cutoff } },
        });
        if (count > 0) this.logger.log(`Purged ${count} health events older than ${days} days`);
    }

    private async purgeProcessedSyncRecords() {
        // Dedup records only need to be kept for the sync window (7 days).
        const cutoff = new Date(Date.now() - 7 * 86_400_000);
        const { count } = await this.prisma.processedSyncRecord.deleteMany({
            where: { processedAt: { lt: cutoff } },
        });
        if (count > 0) this.logger.log(`Purged ${count} processed sync records`);
    }

    private async purgeWebhookDeliveries() {
        // Keep delivered records for 30 days; failed for 7 days.
        const delivered30d = new Date(Date.now() - 30 * 86_400_000);
        const failed7d     = new Date(Date.now() - 7 * 86_400_000);
        const [r1, r2] = await Promise.all([
            this.prisma.webhookDelivery.deleteMany({
                where: { status: 'delivered', createdAt: { lt: delivered30d } },
            }),
            this.prisma.webhookDelivery.deleteMany({
                where: { status: 'failed', createdAt: { lt: failed7d } },
            }),
        ]);
        const total = r1.count + r2.count;
        if (total > 0) this.logger.log(`Purged ${total} webhook delivery records`);
    }

    private async purgeAuditLogs() {
        const days = this.config.get<number>('AUDIT_LOG_RETENTION_DAYS', 365);
        if (days <= 0) return;
        const cutoff = new Date(Date.now() - days * 86_400_000);
        const { count } = await this.prisma.auditLog.deleteMany({
            where: { createdAt: { lt: cutoff } },
        });
        if (count > 0) this.logger.log(`Purged ${count} audit log entries older than ${days} days`);
    }
}
