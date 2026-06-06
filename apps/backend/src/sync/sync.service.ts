import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DashboardGateway } from '../dashboard/dashboard.gateway';
import { SyncBatchDto, SyncRecordDto } from './dto/sync-batch.dto';

@Injectable()
export class SyncService {
    private readonly logger = new Logger(SyncService.name);

    constructor(
        private prisma:  PrismaService,
        private gateway: DashboardGateway,
    ) {}

    async processBatch(stationId: string, companyId: string, dto: SyncBatchDto, ipAddress: string) {
        const accepted: string[]  = [];
        const rejected: string[]  = [];

        for (const record of dto.records) {
            try {
                const exists = await this.prisma.processedSyncRecord.findUnique({
                    where: { id: record.id },
                });
                if (exists) {
                    accepted.push(record.id);
                    continue;
                }

                await this.processRecord(stationId, companyId, record);

                await this.prisma.processedSyncRecord.create({
                    data: { id: record.id, stationId },
                });
                accepted.push(record.id);
            } catch (e: any) {
                this.logger.error(`Failed record ${record.id} [${record.entity_type}]: ${e.message}`);
                rejected.push(record.id);
            }
        }

        await this.prisma.station.update({
            where: { id: stationId },
            data:  { lastSyncAt: new Date(), lastSeenAt: new Date(), syncLagAlerted: false },
        });

        return { accepted, rejected };
    }

    private async processRecord(stationId: string, companyId: string, record: SyncRecordDto) {
        switch (record.entity_type) {
            case 'transaction':       return this.upsertTransaction(stationId, companyId, record.payload);
            case 'shift':             return this.upsertShift(stationId, companyId, record.payload);
            case 'reservoir_reading': return this.upsertReservoirReading(stationId, companyId, record.payload);
            case 'price_change':      return this.recordPriceChange(stationId, companyId, record.payload);
            case 'health_event':      return this.recordHealthEvent(stationId, companyId, record.payload);
            default:
                this.logger.warn(`Unknown entity_type: ${record.entity_type}`);
        }
    }

    private async upsertTransaction(stationId: string, companyId: string, p: any) {
        const startedAt   = new Date(p.started_at);
        const completedAt = p.completed_at ? new Date(p.completed_at) : null;

        // CONTINUED_FROM is internal to station — skip, only final resolved records arrive
        if (p.status === 'CONTINUED_FROM') return;

        await this.prisma.transaction.upsert({
            where: { id: p.id },
            create: {
                id:             p.id,
                companyId,
                stationId,
                fpId:           p.fp_id,
                label:          p.label,
                addressByte:    p.address_byte,
                startedAt,
                completedAt,
                volume:         p.volume ?? 0,
                amount:         BigInt(p.amount ?? 0),
                price:          p.price ?? 0,
                nozzleIndex:    p.nozzle_index ?? 0,
                productId:      p.product_id ?? 0,
                productName:    p.product_name ?? '',
                status:         p.status,
                parentTxId:     p.parent_tx_id ?? null,
                combinedVolume: p.combined_volume ?? null,
                combinedAmount: p.combined_amount != null ? BigInt(p.combined_amount) : null,
                shiftId:        p.shift_id ?? null,
                operatorName:   p.operator_name ?? null,
            },
            update: {
                completedAt,
                volume:         p.volume ?? 0,
                amount:         BigInt(p.amount ?? 0),
                status:         p.status,
                combinedVolume: p.combined_volume ?? null,
                combinedAmount: p.combined_amount != null ? BigInt(p.combined_amount) : null,
                operatorName:   p.operator_name ?? null,
            },
        });

        this.gateway.broadcast('transaction.synced', { stationId, txId: p.id });
    }

    private async upsertShift(stationId: string, companyId: string, p: any) {
        const startedAt = new Date(p.started_at);
        const endedAt   = p.ended_at ? new Date(p.ended_at) : null;

        await this.prisma.shift.upsert({
            where: { id: p.id },
            create: {
                id:                p.id,
                companyId,
                stationId,
                operatorName:      p.operator_name,
                shiftName:         p.shift_name ?? null,
                scheduledStart:    p.scheduled_start ?? null,
                scheduledEnd:      p.scheduled_end ?? null,
                startedAt,
                endedAt,
                totalTransactions: p.total_transactions ?? 0,
                totalVolume:       p.total_volume ?? 0,
                totalAmount:       BigInt(p.total_amount ?? 0),
                status:            p.status,
                notes:             p.notes ?? null,
            },
            update: {
                endedAt,
                totalTransactions: p.total_transactions ?? 0,
                totalVolume:       p.total_volume ?? 0,
                totalAmount:       BigInt(p.total_amount ?? 0),
                status:            p.status,
                notes:             p.notes ?? null,
            },
        });

        if (p.position_totals?.length) {
            await this.prisma.shiftPositionTotal.deleteMany({ where: { shiftId: p.id } });
            await this.prisma.shiftPositionTotal.createMany({
                data: p.position_totals.map((t: any) => ({
                    shiftId:           p.id,
                    fpId:              t.fp_id,
                    label:             t.label,
                    transactionsCount: t.transactions_count ?? 0,
                    totalVolume:       t.total_volume ?? 0,
                    totalAmount:       BigInt(t.total_amount ?? 0),
                })),
            });
        }

        this.gateway.broadcast('shift.synced', { stationId, shiftId: p.id, status: p.status });
    }

    private async upsertReservoirReading(stationId: string, companyId: string, p: any) {
        const reservoir = await this.prisma.reservoir.findFirst({
            where: { stationId, tankId: p.tank_id },
        });
        if (!reservoir) {
            this.logger.warn(`Unknown reservoir tank_id=${p.tank_id} on station ${stationId}`);
            return;
        }

        await this.prisma.reservoirReading.create({
            data: {
                reservoirId:  reservoir.id,
                stationId,
                companyId,
                readingAt:    new Date(p.reading_at),
                volumeLitres: p.volume_litres,
                levelMm:      p.level_mm ?? null,
                temperatureC: p.temperature_c ?? null,
                waterMm:      p.water_mm ?? null,
                fillPercent:  p.fill_percent ?? null,
            },
        });

        this.gateway.broadcast('tank.updated', { stationId, tankId: p.tank_id });
    }

    private async recordPriceChange(stationId: string, companyId: string, p: any) {
        await this.prisma.priceChangeLog.create({
            data: {
                companyId,
                stationId,
                fpId:        p.fp_id,
                nozzleIndex: p.nozzle_index,
                productName: p.product_name,
                oldPrice:    p.old_price,
                newPrice:    p.new_price,
                changedAt:   new Date(p.changed_at),
                changedBy:   p.changed_by ?? 'station',
                source:      'station',
            },
        });

        await this.prisma.priceSetting.upsert({
            where: { stationId_fpId_nozzleIndex: { stationId, fpId: p.fp_id, nozzleIndex: p.nozzle_index } },
            create: {
                stationId,
                fpId:        p.fp_id,
                nozzleIndex: p.nozzle_index,
                productId:   p.product_id ?? 0,
                productName: p.product_name,
                price:       p.new_price,
                updatedBy:   p.changed_by ?? 'station',
            },
            update: {
                price:     p.new_price,
                updatedBy: p.changed_by ?? 'station',
                updatedAt: new Date(p.changed_at),
            },
        });
    }

    private async recordHealthEvent(stationId: string, companyId: string, p: any) {
        await this.prisma.stationHealthEvent.create({
            data: {
                stationId,
                companyId,
                eventType:  p.event_type,
                fpId:       p.fp_id ?? null,
                detail:     p.detail ?? null,
                occurredAt: new Date(p.occurred_at),
            },
        });
    }
}
