import { TransactionsService } from './transactions.service';

describe('TransactionsService', () => {
    it('filters by oil base station IDs before querying transactions', async () => {
        const prisma: any = {
            station: {
                findMany: jest.fn().mockResolvedValue([{ id: 'st-1' }, { id: 'st-2' }]),
            },
            transaction: {
                findMany: jest.fn().mockResolvedValue([{ id: 'tx-1' }]),
                count: jest.fn().mockResolvedValue(1),
            },
            $transaction: jest.fn((ops: Promise<unknown>[]) => Promise.all(ops)),
        };

        const result = await new TransactionsService(prisma).findAll('company-1', {
            oilBaseId: 'base-1',
            limit: 20,
            page: 1,
            skip: 0,
        } as any);

        expect(result.total).toBe(1);
        expect(prisma.transaction.findMany).toHaveBeenCalledWith(expect.objectContaining({
            where: expect.objectContaining({
                companyId: 'company-1',
                stationId: { in: ['st-1', 'st-2'] },
                deletedAt: null,
            }),
        }));
    });

    it('returns an empty page when oil base has no stations', async () => {
        const prisma: any = {
            station: { findMany: jest.fn().mockResolvedValue([]) },
        };

        await expect(new TransactionsService(prisma).findAll('company-1', {
            oilBaseId: 'empty-base',
        } as any)).resolves.toEqual({ data: [], total: 0, page: 1, pages: 1 });
    });

    it('returns an empty page when the user has no accessible stations', async () => {
        const prisma: any = {};

        await expect(new TransactionsService(prisma).findAll('company-1', {} as any, [])).resolves.toEqual({
            data: [],
            total: 0,
            page: 1,
            pages: 1,
        });
    });
});
