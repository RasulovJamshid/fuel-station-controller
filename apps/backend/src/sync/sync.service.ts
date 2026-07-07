import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DashboardGateway } from '../dashboard/dashboard.gateway';
import { IntegrationsService } from '../integrations/integrations.service';
import { SyncBatchDto, SyncRecordDto } from './dto/sync-batch.dto';

@Injectable()
export class SyncService {
    private readonly logger = new Logger(SyncService.name);

    constructor(
        private prisma:        PrismaService,
        private gateway:       DashboardGateway,
        private integrations:  IntegrationsService,
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

        await this.setTransactionPresetMetadata(p.id, p);

        this.gateway.broadcast('transaction.synced', { stationId, txId: p.id });

        if (p.status === 'COMPLETED') {
            this.integrations.dispatch(companyId, stationId, 'transaction.completed', {
                id: p.id, fpId: p.fp_id, label: p.label,
                productName: p.product_name, productId: p.product_id,
                volume: p.volume, amount: p.amount, price: p.price,
                startedAt: p.started_at, completedAt: p.completed_at,
                operatorName: p.operator_name ?? null,
            }).catch(() => {});
        }
    }

    private async setTransactionPresetMetadata(txId: string, p: any) {
        if (p.preset_type == null && p.preset_value == null && p.preset_label == null) return;
        try {
            await this.prisma.$executeRaw`
                UPDATE "Transaction"
                SET "presetType" = ${p.preset_type ?? null},
                    "presetValue" = ${p.preset_value ?? null},
                    "presetLabel" = ${p.preset_label ?? null}
                WHERE "id" = ${txId}
            `;
        } catch (e) {
            this.logger.warn(`Transaction preset metadata update skipped for ${txId}: ${e}`);
        }
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

        if (p.status === 'CLOSED') {
            this.integrations.dispatch(companyId, stationId, 'shift.closed', {
                id: p.id, operatorName: p.operator_name,
                startedAt: p.started_at, endedAt: p.ended_at,
                totalTransactions: p.total_transactions,
                totalVolume: p.total_volume, totalAmount: p.total_amount,
            }).catch(() => {});
        }
    }

    private async upsertReservoirReading(stationId: string, companyId: string, p: any) {
        let reservoir = await this.prisma.reservoir.findFirst({
            where: { stationId, tankId: p.tank_id },
        });
        if (!reservoir) {
            // Auto-provision the tank on its first reading so ATG data is never
            // dropped. The label/capacity are placeholders an admin can edit later.
            reservoir = await this.autoCreateReservoir(stationId, p);
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

        this.integrations.dispatch(companyId, stationId, 'tank.reading', {
            tankId: p.tank_id, reservoirId: reservoir.id,
            volumeLitres: p.volume_litres, fillPercent: p.fill_percent ?? null,
            levelMm: p.level_mm ?? null, readingAt: p.reading_at,
        }).catch(() => {});
    }

    /**
     * Create a reservoir for a tank we've never seen before. The product name
     * is resolved from the station's nozzles when possible; label and capacity
     * are placeholders (capacity 0 = unknown) that an admin can edit afterwards.
     */
    private async autoCreateReservoir(stationId: string, p: any) {
        const productId = p.product_id ?? 0;
        const nozzle = await this.prisma.nozzle.findFirst({
            where:  { productId, position: { stationId } },
            select: { productName: true },
        });
        const reservoir = await this.prisma.reservoir.upsert({
            where:  { stationId_tankId: { stationId, tankId: p.tank_id } },
            create: {
                stationId,
                tankId:      p.tank_id,
                label:       `Tank ${p.tank_id}`,
                productId,
                productName: nozzle?.productName ?? '',
                capacity:    0,
            },
            update: {},
        });
        this.logger.log(`Auto-created reservoir tank_id=${p.tank_id} on station ${stationId}`);
        return reservoir;
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

        this.integrations.dispatch(companyId, stationId, 'price.changed', {
            fpId: p.fp_id, nozzleIndex: p.nozzle_index,
            productName: p.product_name, productId: p.product_id,
            oldPrice: p.old_price, newPrice: p.new_price,
            changedAt: p.changed_at, changedBy: p.changed_by ?? 'station',
        }).catch(() => {});
    }

    async getCurrentPricesForStation(stationId: string) {
        const prices = await this.prisma.priceSetting.findMany({
            where: { stationId },
            orderBy: [{ fpId: 'asc' }, { nozzleIndex: 'asc' }],
        });
        return prices.map(p => ({
            fp_id:        p.fpId,
            nozzle_index: p.nozzleIndex,
            product_id:   p.productId,
            product_name: p.productName,
            price:        p.price,
            updated_at:   p.updatedAt.getTime(),
        }));
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

        this.integrations.dispatch(companyId, stationId, 'health.event', {
            eventType: p.event_type, fpId: p.fp_id ?? null,
            detail: p.detail ?? null, occurredAt: p.occurred_at,
        }).catch(() => {});
    }
}
