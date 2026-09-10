import { StationsService } from './stations.service';

const serviceConfig = {
    site: { id: 'station-1', name: 'Station 1', timezone: 'Asia/Tashkent' },
    service: { port: 3001 },
    connection: { protocol: 'mock', port: 'mock' },
    polling: { interval_ms: 200 },
    products: [{ id: 1, name: 'AI-92' }],
    fueling_positions: [{ id: 'FP1', nozzles: [{ index: 1, product_id: 1, price: 10000 }] }],
    sync: { enabled: true, backend_url: 'https://old.example', api_key: 'local-secret' },
};

describe('StationsService', () => {
    it('saves a new installation template, increments its version and strips only the sync key', async () => {
        const prisma: any = {
            station: {
                findFirst: jest.fn().mockResolvedValue({ id: 'station-1', name: 'Station 1', timezone: 'Asia/Tashkent', address: null, apiKey: 'secret' }),
                update: jest.fn().mockResolvedValue({ serviceConfigVersion: 1, serviceConfigUpdatedAt: new Date() }),
            },
        };
        const service = new StationsService(prisma, {} as any, {} as any, {} as any);
        const draft = await service.getServiceConfig('station-1', 'company-1', 'https://server.example');
        expect(draft.source).toBe('template');
        const result = await service.saveServiceConfig('station-1', 'company-1', draft.config);
        expect(result.version).toBe(1);
        expect(prisma.station.update).toHaveBeenCalledWith(expect.objectContaining({ data: {
            serviceConfig: { ...draft.config, sync: { ...draft.config.sync, api_key: '' } },
            serviceConfigVersion: { increment: 1 }, serviceConfigUpdatedAt: expect.any(Date),
        } }));
        expect(draft.config.sync.api_key).toBe('secret');
    });

    it('rejects malformed dashboard configs and mismatched station identity before writing', async () => {
        const prisma: any = { station: { findFirst: jest.fn().mockResolvedValue({ id: 'station-1' }), update: jest.fn() } };
        const service = new StationsService(prisma, {} as any, {} as any, {} as any);
        await expect(service.saveServiceConfig('station-1', 'company-1', serviceConfig)).rejects.toThrow();
        await expect(service.saveServiceConfig('station-1', 'company-1', { ...serviceConfig, site: { id: 'other-site' } })).rejects.toThrow('site.id');
        expect(prisma.station.update).not.toHaveBeenCalled();
    });

    it('computes today totals from an aggregate instead of the 20 recent rows', async () => {
        const recent = Array.from({ length: 20 }, (_, i) => ({
            id: `tx-${i}`, startedAt: new Date(), status: 'COMPLETED', volume: 1, amount: 100,
        }));
        const prisma: any = {
            station: { findFirst: jest.fn().mockResolvedValue({ id: 'station-1', timezone: 'Asia/Tashkent' }) },
            transaction: {
                findMany: jest.fn().mockResolvedValue(recent),
                aggregate: jest.fn().mockResolvedValue({
                    _count: { id: 47 },
                    _sum: { volume: 5180, amount: BigInt(5_180_000) },
                }),
            },
            priceSetting: { findMany: jest.fn().mockResolvedValue([]) },
            shift: { findFirst: jest.fn().mockResolvedValue(null) },
            stationHealthEvent: { findMany: jest.fn().mockResolvedValue([]) },
            $queryRaw: jest.fn().mockResolvedValue([]),
        };
        const prices: any = { getCurrentPrices: jest.fn().mockResolvedValue([]) };
        const service = new StationsService(prisma, {} as any, {} as any, prices);

        const result = await service.getDetail('station-1', 'company-1');

        expect(result.transactions).toHaveLength(20);
        expect(result.stats).toEqual({
            todayTransactions: 47,
            todayVolume: 5180,
            todayAmount: 5_180_000,
        });
        expect(prisma.transaction.aggregate).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                stationId: 'station-1',
                status: { in: ['COMPLETED', 'STOPPED'] },
                startedAt: { gte: expect.any(Date), lt: expect.any(Date) },
            }),
        }));
    });

    it('stores station backups separately and removes the API key', async () => {
        const prisma: any = {
            station: {
                findFirst: jest.fn().mockResolvedValue({ id: 'station-1' }),
                update: jest.fn().mockResolvedValue({
                    serviceConfigBackupVersion: 3,
                    serviceConfigBackupUpdatedAt: new Date('2026-09-08T05:00:00Z'),
                }),
            },
        };
        const service = new StationsService(prisma, {} as any, {} as any, {} as any);

        const result = await service.backupServiceConfig('station-1', 'company-1', serviceConfig);

        expect(result.version).toBe(3);
        expect(prisma.station.update).toHaveBeenCalledWith(expect.objectContaining({
            data: expect.objectContaining({
                serviceConfigBackup: expect.objectContaining({
                    sync: expect.objectContaining({ api_key: '' }),
                }),
            }),
        }));
    });

    it('downloads the dashboard config with current station identity and credentials', async () => {
        const prisma: any = {
            station: {
                findFirst: jest.fn().mockResolvedValue({
                    id: 'station-1',
                    name: 'Current Station Name',
                    address: 'Tashkent',
                    timezone: 'Asia/Tashkent',
                    apiKey: 'current-api-key',
                    serviceConfig,
                    serviceConfigVersion: 4,
                    serviceConfigUpdatedAt: new Date('2026-09-08T05:00:00Z'),
                    serviceConfigBackup: { ...serviceConfig, ui: { default_auth_mode: 'postpay' } },
                    serviceConfigBackupVersion: 9,
                    serviceConfigBackupUpdatedAt: new Date('2026-09-08T06:00:00Z'),
                }),
            },
        };
        const service = new StationsService(prisma, {} as any, {} as any, {} as any);

        const result = await service.getServiceConfig(
            'station-1',
            'company-1',
            'https://dashboard.example/',
        );

        expect(result.source).toBe('dashboard');
        expect(result.version).toBe(4);
        expect(result.config.site).toEqual(expect.objectContaining({
            id: 'station-1',
            name: 'Current Station Name',
            address: 'Tashkent',
        }));
        expect(result.config.sync).toEqual(expect.objectContaining({
            enabled: true,
            backend_url: 'https://dashboard.example',
            api_key: 'current-api-key',
        }));
        expect(result.config.ui).toBeUndefined();
    });
});
