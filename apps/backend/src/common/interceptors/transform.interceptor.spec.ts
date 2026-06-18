import { of, lastValueFrom } from 'rxjs';
import { TransformInterceptor } from './transform.interceptor';

describe('TransformInterceptor', () => {
    it('serializes BigInt values in wrapped responses', async () => {
        const interceptor = new TransformInterceptor();
        const context: any = {
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

        const response = await lastValueFrom(interceptor.intercept(context, next));

        expect(response.data).toEqual({
            amount: 123,
            nested: { totalAmount: 456 },
            rows: [{ value: 789 }],
        });
        expect(response.meta.requestId).toBe('req-1');
    });
});
