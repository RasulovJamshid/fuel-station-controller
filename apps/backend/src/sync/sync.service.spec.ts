import { SyncService } from './sync.service';

describe('SyncService', () => {
    function makePrisma() {
        return {
            processedSyncRecord: {
                findUnique: jest.fn().mockResolvedValue(null),
                create: jest.fn().mockResolvedValue({}),
            },
            transaction: {
                upsert: jest.fn().mockResolvedValue({}),
                groupBy: jest.fn().mockResolvedValue([]),
            },
            shift: {
                updateMany: jest.fn().mockResolvedValue({ count: 1 }),
            },
            shiftPositionTotal: {
                deleteMany: jest.fn().mockResolvedValue({}),
                createMany: jest.fn().mockResolvedValue({ count: 0 }),
            },
            station: {
                update: jest.fn().mockResolvedValue({}),
            },
        };
    }

    it('accepts a station transaction payload and dispatches completed transaction integrations', async () => {
        const prisma: any = makePrisma();
        const gateway: any = { broadcast: jest.fn() };
        const integrations: any = { dispatch: jest.fn().mockResolvedValue(undefined) };
        const service = new SyncService(prisma, gateway, integrations);

        const result = await service.processBatch('station-1', 'company-1', {
            records: [{
                id: '2b27a2c3-ef90-4ee6-8f7d-8a98d2f8d1a1',
                entity_type: 'transaction',
                entity_id: 'tx-1',
                created_at: Date.now(),
                payload: {
                    id: 'tx-1',
                    fp_id: 'FP1',
                    label: '1',
                    address_byte: 80,
                    started_at: '2026-06-18T10:00:00.000Z',
                    completed_at: '2026-06-18T10:02:00.000Z',
                    volume: 10.5,
                    amount: 150000,
                    price: 14300,
                    nozzle_index: 1,
                    product_id: 95,
                    product_name: 'AI-95',
                    status: 'COMPLETED',
                    shift_id: 'shift-1',
                    operator_name: 'Operator',
                },
            }],
        }, '127.0.0.1');

        expect(result).toEqual({
            accepted: ['2b27a2c3-ef90-4ee6-8f7d-8a98d2f8d1a1'],
            rejected: [],
        });
        expect(prisma.transaction.upsert).toHaveBeenCalledWith(expect.objectContaining({
            create: expect.objectContaining({
                id: 'tx-1',
                companyId: 'company-1',
                stationId: 'station-1',
                amount: BigInt(150000),
                productName: 'AI-95',
            }),
        }));
        expect(gateway.broadcast).toHaveBeenCalledWith('transaction.synced', {
            stationId: 'station-1',
            txId: 'tx-1',
        });
        expect(integrations.dispatch).toHaveBeenCalledWith(
            'company-1',
            'station-1',
            'transaction.completed',
            expect.objectContaining({ id: 'tx-1', amount: 150000 }),
        );
    });

    it('treats duplicate sync records as accepted without reprocessing', async () => {
        const prisma: any = makePrisma();
        prisma.processedSyncRecord.findUnique.mockResolvedValue({ id: 'dup' });
        const service = new SyncService(prisma, { broadcast: jest.fn() } as any, { dispatch: jest.fn() } as any);

        await expect(service.processBatch('station-1', 'company-1', {
            records: [{
                id: '2b27a2c3-ef90-4ee6-8f7d-8a98d2f8d1a1',
                entity_type: 'transaction',
                entity_id: 'tx-1',
                created_at: Date.now(),
                payload: {},
            }],
        }, '127.0.0.1')).resolves.toEqual({
            accepted: ['2b27a2c3-ef90-4ee6-8f7d-8a98d2f8d1a1'],
            rejected: [],
        });

        expect(prisma.transaction.upsert).not.toHaveBeenCalled();
    });
});
