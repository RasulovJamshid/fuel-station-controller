import { StationsService } from './stations.service';

describe('StationsService', () => {
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
});
