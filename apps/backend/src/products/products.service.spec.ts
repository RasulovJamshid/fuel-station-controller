import { normalizeProductName, ProductsService } from './products.service';

describe('ProductsService', () => {
    it('normalizes common station spelling variations consistently', () => {
        expect(normalizeProductName(' AI-92 ')).toBe('ai92');
        expect(normalizeProductName('AI_92')).toBe('ai92');
        expect(normalizeProductName('ai 92')).toBe('ai92');
    });

    it('backfills transactions and prices when a station product is mapped', async () => {
        const mappingDelegate = { upsert: jest.fn().mockResolvedValue({ id: 'mapping-1' }) };
        const productDelegate = { findFirst: jest.fn().mockResolvedValue({ id: 'product-1' }) };
        const txUpdate = jest.fn().mockResolvedValue({ count: 12 });
        const priceUpdate = jest.fn().mockResolvedValue({ count: 2 });
        const prisma: any = {
            product: productDelegate,
            stationProductMapping: mappingDelegate,
            station: { findFirst: jest.fn().mockResolvedValue({ id: 'station-1' }) },
            transaction: { updateMany: txUpdate },
            priceSetting: { updateMany: priceUpdate },
            $transaction: jest.fn((ops: any[]) => Promise.all(ops)),
        };
        const service = new ProductsService(prisma);

        await service.map('company-1', 'product-1', {
            stationId: 'station-1', stationProductId: 92, stationProductName: 'АИ 92',
        });

        expect(mappingDelegate.upsert).toHaveBeenCalledWith(expect.objectContaining({
            where: { stationId_normalizedName: { stationId: 'station-1', normalizedName: 'аи92' } },
        }));
        expect(txUpdate).toHaveBeenCalledWith(expect.objectContaining({
            data: { canonicalProductId: 'product-1' },
        }));
        expect(priceUpdate).toHaveBeenCalled();
    });
});
