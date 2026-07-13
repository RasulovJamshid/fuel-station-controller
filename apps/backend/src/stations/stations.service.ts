import { Injectable, ConflictException, NotFoundException, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateStationDto, UpdateStationDto } from './dto/create-station.dto';
import { ConfigService } from '@nestjs/config';
import { currentDayUtcRange } from '../common/utils/timezone';
import { TxStatus } from '@prisma/client';
import { PricesService } from '../prices/prices.service';

@Injectable()
export class StationsService {
    private readonly logger = new Logger(StationsService.name);

    constructor(
        private prisma:  PrismaService,
        private config:  ConfigService,
        private notify:  NotificationsService,
        private prices:  PricesService,
    ) {}

    async create(dto: CreateStationDto) {
        const existing = await this.prisma.station.findUnique({ where: { id: dto.id } });
        if (existing) throw new ConflictException(`Station "${dto.id}" already exists`);

        return this.prisma.station.create({
            data: {
                id:          dto.id,
                companyId:   dto.companyId,
                name:        dto.name,
                address:     dto.address,
                timezone:    dto.timezone ?? 'Asia/Tashkent',
                ipAllowlist: dto.ipAllowlist ?? [],
            },
        });
    }

    findAll(companyId: string, stationIds?: string[]) {
        if (stationIds && stationIds.length === 0) return [];
        return this.prisma.station.findMany({
            where: {
                companyId,
                deletedAt: null,
                ...(stationIds ? { id: { in: stationIds } } : {}),
            },
            orderBy: { name: 'asc' },
        });
    }

    async findOne(id: string, companyId?: string) {
        const station = await this.prisma.station.findFirst({
            where: { id, ...(companyId ? { companyId } : {}), deletedAt: null },
        });
        if (!station) throw new NotFoundException('Station not found');
        return station;
    }

    async update(id: string, companyId: string, dto: UpdateStationDto) {
        await this.findOne(id, companyId);
        return this.prisma.station.update({ where: { id }, data: dto });
    }

    async remove(id: string, companyId: string) {
        await this.findOne(id, companyId);
        return this.prisma.station.update({ where: { id }, data: { deletedAt: new Date() } });
    }

    async rotateApiKey(id: string, companyId: string) {
        await this.findOne(id, companyId);
        const { v4: uuidv4 } = await import('uuid');
        return this.prisma.station.update({
            where: { id },
            data: { apiKey: uuidv4() },
            select: { id: true, apiKey: true },
        });
    }

    async getDetail(id: string, companyId: string) {
        const station = await this.findOne(id, companyId);

        const { start: todayStart, end: tomorrowStart } = currentDayUtcRange(station.timezone ?? 'UTC');
        const [transactions, todayStats, prices, shift, healthEvents, tanks] = await Promise.all([
            this.prisma.transaction.findMany({
                where: { stationId: id, deletedAt: null },
                orderBy: { startedAt: 'desc' },
                take: 20,
                select: {
                    id: true, fpId: true, label: true, nozzleIndex: true,
                    productName: true, volume: true, amount: true,
                    price: true, status: true, startedAt: true,
                    completedAt: true, operatorName: true,
                },
            }),
            this.prisma.transaction.aggregate({
                where: {
                    stationId: id,
                    deletedAt: null,
                    status: { in: [TxStatus.COMPLETED, TxStatus.STOPPED] },
                    startedAt: { gte: todayStart, lt: tomorrowStart },
                },
                _count: { id: true },
                _sum: { volume: true, amount: true },
            }),
            this.prices.getCurrentPrices(companyId, id, [id]),
            this.prisma.shift.findFirst({
                where: { stationId: id, status: 'ACTIVE' },
                select: {
                    id: true, operatorName: true, startedAt: true,
                    totalTransactions: true, totalVolume: true, totalAmount: true,
                },
            }),
            this.prisma.stationHealthEvent.findMany({
                where: { stationId: id },
                orderBy: { occurredAt: 'desc' },
                take: 10,
            }),
            (this.prisma.$queryRaw`
                SELECT DISTINCT ON (r.id)
                    r.id, r."tankId", r.label, r."productName", r.capacity,
                    rr."volumeLitres",
                    CASE
                        WHEN rr."volumeLitres" IS NULL OR r.capacity <= 0 THEN NULL
                        ELSE rr."volumeLitres" / r.capacity * 100
                    END AS "fillPercent",
                    rr."readingAt"
                FROM "Reservoir" r
                LEFT JOIN "ReservoirReading" rr ON rr."reservoirId" = r.id
                WHERE r."stationId" = ${id} AND r."deletedAt" IS NULL AND r.active = true
                ORDER BY r.id, rr."readingAt" DESC NULLS LAST
            ` as Promise<any[]>),
        ]);

        return {
            station,
            stats: {
                todayTransactions: todayStats._count.id,
                todayVolume: todayStats._sum.volume ?? 0,
                todayAmount: Number(todayStats._sum.amount ?? 0),
            },
            transactions,
            prices,
            activeShift: shift ?? null,
            healthEvents,
            tanks,
        };
    }

    async getUptimeHistory(stationId: string, companyId: string, days = 7) {
        await this.findOne(stationId, companyId);
        const since = new Date(Date.now() - days * 86_400_000);
        return this.prisma.stationUptimeEvent.findMany({
            where: { stationId, occurredAt: { gte: since } },
            orderBy: { occurredAt: 'asc' },
        });
    }

    @Cron('*/5 * * * *')
    async checkSyncLag() {
        const lagMinutes = this.config.get<number>('SYNC_LAG_ALERT_MINUTES', 30);
        const cutoff     = new Date(Date.now() - lagMinutes * 60_000);

        const lagging = await this.prisma.station.findMany({
            where: {
                active: true,
                deletedAt: null,
                lastSyncAt: { lt: cutoff },
                syncLagAlerted: false,
            },
        });

        for (const station of lagging) {
            this.logger.warn(`Station ${station.name} (${station.id}) sync lag > ${lagMinutes}m`);
            await this.notify.sendAlert({
                type:      'sync_lag',
                stationId: station.id,
                message:   `⚠️ Station <b>${station.name}</b> hasn't synced in ${lagMinutes}+ minutes`,
            });
            await this.prisma.station.update({
                where: { id: station.id },
                data:  { syncLagAlerted: true },
            });
        }
    }
}
