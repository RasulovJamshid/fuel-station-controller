import { PricesService } from './prices.service';

describe('PricesService', () => {
    it('returns one newest price per station and canonical product in the matrix', async () => {
        const service = new PricesService({} as any, {} as any);
        jest.spyOn(service, 'getCurrentPrices').mockResolvedValue([
            { stationId: 's1', canonicalProductId: 'p92', productId: 1, productName: '92', price: 12000, updatedAt: new Date('2026-07-13T10:00:00Z') },
            { stationId: 's1', canonicalProductId: 'p92', productId: 2, productName: 'AI-92', price: 12100, updatedAt: new Date('2026-07-13T11:00:00Z') },
            { stationId: 's2', canonicalProductId: 'p92', productId: 7, productName: 'АИ92', price: 11900, updatedAt: new Date('2026-07-13T09:00:00Z') },
        ]);

        const rows = await service.getPriceMatrix('company-1');

        expect(rows).toHaveLength(2);
        expect(rows).toEqual(expect.arrayContaining([
            expect.objectContaining({ stationId: 's1', price: 12100 }),
            expect.objectContaining({ stationId: 's2', price: 11900 }),
        ]));
    });
});
