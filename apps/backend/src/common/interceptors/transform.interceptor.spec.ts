import { of, lastValueFrom } from 'rxjs';
import { ApiResponse, TransformInterceptor } from './transform.interceptor';
import { SyncController } from '../../sync/sync.controller';

describe('TransformInterceptor', () => {
    it('serializes BigInt values in wrapped responses', async () => {
        const interceptor = new TransformInterceptor();
        const context: any = {
            getHandler: () => function dashboardHandler() {},
            switchToHttp: () => ({
                getRequest: () => ({ requestId: 'req-1' }),
            }),
        };
        const next: any = {
            handle: () => of({
                amount: BigInt(123),
                nested: { totalAmount: BigInt(456) },
                rows: [{ value: BigInt(789) }],
            }),
        };

        const response = await lastValueFrom(interceptor.intercept(context, next)) as ApiResponse<any>;

        expect(response.data).toEqual({
            amount: 123,
            nested: { totalAmount: 456 },
            rows: [{ value: 789 }],
        });
        expect(response.meta.requestId).toBe('req-1');
    });

    it('returns the same sync verdict to old root readers and newer envelope readers', async () => {
        const context: any = {
            getHandler: () => SyncController.prototype.batch,
            switchToHttp: () => ({ getRequest: () => ({ requestId: 'legacy' }) }),
        };
        const verdict = { accepted: ['record-1'], rejected: ['record-2'] };
        const response: any = await lastValueFrom(new TransformInterceptor().intercept(context, { handle: () => of(verdict) }));
        expect({ accepted: response.accepted, rejected: response.rejected }).toEqual(verdict);
        expect(response.data).toEqual(verdict);
        expect(response.meta.requestId).toBe('legacy');
    });

    it('returns station prices as the original array supported by both station decoders', async () => {
        const context: any = {
            getHandler: () => SyncController.prototype.prices,
            switchToHttp: () => ({ getRequest: () => ({}) }),
        };
        const prices = [{ fp_id: 'FP1', nozzle_index: 1, product_id: 1, product_name: 'AI-92', price: 10000 }];
        const response: any = await lastValueFrom(new TransformInterceptor().intercept(context, { handle: () => of(prices) }));
        expect(response).toEqual(prices);
        expect(response.data ?? response).toEqual(prices);
    });
});
