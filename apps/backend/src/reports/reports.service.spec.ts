import { ReportsService } from './reports.service';

describe('ReportsService', () => {
    it('passes a valid date_trunc field instead of an interval literal', async () => {
        const queryRaw = jest.fn().mockResolvedValue([]);
        const service = new ReportsService({ $queryRaw: queryRaw } as any, {} as any);

        await service.getRevenueSummary(
            'company-1', ['station-1'],
            new Date('2026-07-01T00:00:00Z'),
            new Date('2026-07-14T00:00:00Z'),
            'day',
        );

        expect(queryRaw).toHaveBeenCalledTimes(1);
        const values = queryRaw.mock.calls[0].slice(1);
        expect(values).toContain('day');
        expect(values).not.toContain('1 day');
        const sql = queryRaw.mock.calls[0][0].join(' ');
        expect(sql).toContain('COALESCE(SUM(amount), 0)::bigint');
        expect(sql).not.toContain('SUM(amount::numeric)');
    });
});
