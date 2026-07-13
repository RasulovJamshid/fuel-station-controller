import { currentDayUtcRange } from './timezone';

describe('currentDayUtcRange', () => {
    it('returns station-local midnight boundaries in UTC', () => {
        const range = currentDayUtcRange(
            'Asia/Tashkent',
            new Date('2026-07-13T12:00:00.000Z'),
        );

        expect(range.start.toISOString()).toBe('2026-07-12T19:00:00.000Z');
        expect(range.end.toISOString()).toBe('2026-07-13T19:00:00.000Z');
    });
});
