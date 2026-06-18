import { DashboardService } from './dashboard.service';

describe('DashboardService', () => {
    it('builds an overview from stations, today transactions, and active shifts', async () => {
        const prisma: any = {
            station: {
                findMany: jest.fn().mockResolvedValue([
                    { id: 'st-1', name: 'Station 1', active: true },
                    { id: 'st-2', name: 'Station 2', active: true },
                ]),
            },
            transaction: {
                aggregate: jest.fn().mockResolvedValue({
                    _count: { id: 3 },
                    _sum: { volume: 42.5 },
                }),
            },
            shift: {
                findMany: jest.fn().mockResolvedValue([
                    { id: 'shift-1', stationId: 'st-1', operatorName: 'Ali' },
                ]),
            },
            $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
        };

        await expect(new DashboardService(prisma).getOverview('company-1')).resolves.toMatchObject({
            stations: 2,
            activeShifts: 1,
            todayTransactions: 3,
            todayVolume: 42.5,
        });
    });

    it('returns empty overview when the user has no accessible stations', async () => {
        const prisma: any = {};

        await expect(new DashboardService(prisma).getOverview('company-1', [])).resolves.toEqual({
            stations: 0,
            activeShifts: 0,
            todayTransactions: 0,
            todayVolume: 0,
            stationSummaries: [],
            activeShiftsList: [],
        });
    });
});
