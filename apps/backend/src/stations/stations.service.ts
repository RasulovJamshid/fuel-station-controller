import { Injectable, BadRequestException, ConflictException, NotFoundException, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from '../notifications/notifications.service';
import { CreateStationDto, UpdateStationDto } from './dto/create-station.dto';
import { ConfigService } from '@nestjs/config';
import { currentDayUtcRange } from '../common/utils/timezone';
import { Prisma, TxStatus } from '@prisma/client';
import { PricesService } from '../prices/prices.service';
import { validateDashboardServiceConfig } from './service-config.validation';

const stationPublicSelect = {
    id: true,
    companyId: true,
    oilBaseId: true,
    name: true,
    address: true,
    timezone: true,
    active: true,
    ipAllowlist: true,
    lastSyncAt: true,
    lastSeenAt: true,
    syncLagAlerted: true,
    serviceConfigVersion: true,
    serviceConfigUpdatedAt: true,
    serviceConfigBackupVersion: true,
    serviceConfigBackupUpdatedAt: true,
    createdAt: true,
    updatedAt: true,
    deletedAt: true,
};

function isRecord(value: unknown): value is Record<string, any> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function defaultServiceConfig(station: { id: string; name: string; address: string | null; timezone: string }) {
    return {
        site: {
            id: station.id,
            name: station.name,
            timezone: station.timezone,
            address: station.address,
        },
        service: {
            port: 3001,
            log_level: 'info',
            log_file: 'service.log',
            db_path: 'transactions.db',
            serial_log_file: null,
        },
        connection: {
            protocol: 'mock',
            port: 'mock',
            baud_rate: 9600,
            parity: 'none',
            data_bits: 8,
            stop_bits: 1,
            response_timeout_ms: 500,
        },
        polling: {
            interval_ms: 200,
            offline_threshold_polls: 5,
            reconnect_settle_rounds: 3,
        },
        products: [
            { id: 1, name: 'AI-92', color: '#2196F3', unit: 'litre' },
        ],
        fueling_positions: [
            {
                id: 'FP1',
                label: 'Pump 1',
                address_byte: 1,
                active: true,
                nozzles: [
                    { index: 1, product_id: 1, price: 10000, active: true },
                ],
            },
        ],
        sync: {
            enabled: true,
            backend_url: '',
            api_key: '',
            retry_interval_secs: 30,
            batch_size: 100,
            max_retries: 10,
            price_pull_interval_hours: 12,
            price_pull_enabled: true,
        },
        shifts: {
            mode: 'disabled',
            scheduled: [],
            require_operator_pin: false,
            warn_before_end_minutes: 15,
            allow_overlap_minutes: 30,
            auto_close_on_restart: false,
        },
        ui: {
            default_auth_mode: 'preauth',
            preauth_timeout_seconds: 300,
            use_decel_window_on_stop: false,
            use_cancel_mode: false,
        },
        tanks: [],
        atg: null,
    };
}

function validateServiceConfig(stationId: string, value: unknown): Record<string, any> {
    if (!isRecord(value)) throw new BadRequestException('Service config must be a JSON object');
    for (const key of ['site', 'service', 'connection', 'polling', 'sync']) {
        if (!isRecord(value[key])) throw new BadRequestException(`Service config is missing object: ${key}`);
    }
    for (const key of ['products', 'fueling_positions']) {
        if (!Array.isArray(value[key]) || value[key].length === 0) {
            throw new BadRequestException(`Service config requires a non-empty ${key} array`);
        }
    }
    if (value.site.id !== stationId) {
        throw new BadRequestException(`Config site.id must equal station ID "${stationId}"`);
    }
    return JSON.parse(JSON.stringify(value));
}

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
        return (this.prisma.station as any).findMany({
            where: {
                companyId,
                deletedAt: null,
                ...(stationIds ? { id: { in: stationIds } } : {}),
            },
            orderBy: { name: 'asc' },
            select: stationPublicSelect,
        });
    }

    async findOne(id: string, companyId?: string) {
        const station = await (this.prisma.station as any).findFirst({
            where: { id, ...(companyId ? { companyId } : {}), deletedAt: null },
            select: stationPublicSelect,
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

    async saveServiceConfig(id: string, companyId: string, rawConfig: unknown) {
        const station = await this.prisma.station.findFirst({
            where: { id, companyId, deletedAt: null },
            select: { id: true },
        });
        if (!station) throw new NotFoundException('Station not found');

        const config = validateServiceConfig(id, rawConfig);
        validateDashboardServiceConfig(config);
        config.sync = { ...config.sync, api_key: '' };
        const updatedAt = new Date();
        const updated = await (this.prisma.station as any).update({
            where: { id },
            data: {
                serviceConfig: config as Prisma.InputJsonValue,
                serviceConfigVersion: { increment: 1 },
                serviceConfigUpdatedAt: updatedAt,
            },
            select: { serviceConfigVersion: true, serviceConfigUpdatedAt: true },
        });
        return {
            version: updated.serviceConfigVersion,
            updatedAt: updated.serviceConfigUpdatedAt,
        };
    }

    async backupServiceConfig(id: string, companyId: string, rawConfig: unknown) {
        const station = await this.prisma.station.findFirst({
            where: { id, companyId, deletedAt: null },
            select: { id: true },
        });
        if (!station) throw new NotFoundException('Station not found');

        const config = validateServiceConfig(id, rawConfig);
        config.sync = { ...config.sync, api_key: '' };
        const updatedAt = new Date();
        const updated = await (this.prisma.station as any).update({
            where: { id },
            data: {
                serviceConfigBackup: config as Prisma.InputJsonValue,
                serviceConfigBackupVersion: { increment: 1 },
                serviceConfigBackupUpdatedAt: updatedAt,
            },
            select: {
                serviceConfigBackupVersion: true,
                serviceConfigBackupUpdatedAt: true,
            },
        });
        return {
            version: updated.serviceConfigBackupVersion,
            updatedAt: updated.serviceConfigBackupUpdatedAt,
        };
    }

    async getServiceConfig(id: string, companyId: string, backendUrl: string) {
        const station = await (this.prisma.station as any).findFirst({
            where: { id, companyId, deletedAt: null },
            select: {
                id: true,
                name: true,
                address: true,
                timezone: true,
                apiKey: true,
                serviceConfig: true,
                serviceConfigVersion: true,
                serviceConfigUpdatedAt: true,
                serviceConfigBackup: true,
                serviceConfigBackupVersion: true,
                serviceConfigBackupUpdatedAt: true,
            },
        });
        if (!station) throw new NotFoundException('Station not found');

        const dashboardConfig = isRecord(station.serviceConfig) ? station.serviceConfig : null;
        const backupConfig = isRecord(station.serviceConfigBackup) ? station.serviceConfigBackup : null;
        const stored = JSON.parse(JSON.stringify(dashboardConfig ?? backupConfig ?? defaultServiceConfig(station)));
        const config = {
            ...stored,
            site: {
                ...(isRecord(stored.site) ? stored.site : {}),
                id: station.id,
                name: station.name,
                timezone: station.timezone,
                address: station.address,
            },
            sync: {
                ...(isRecord(stored.sync) ? stored.sync : {}),
                enabled: true,
                backend_url: backendUrl.replace(/\/$/, ''),
                api_key: station.apiKey,
            },
        };

        return {
            config,
            version: dashboardConfig
                ? station.serviceConfigVersion
                : station.serviceConfigBackupVersion,
            updatedAt: dashboardConfig
                ? station.serviceConfigUpdatedAt
                : station.serviceConfigBackupUpdatedAt,
            source: dashboardConfig ? 'dashboard' : backupConfig ? 'station-backup' : 'template',
        };
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
