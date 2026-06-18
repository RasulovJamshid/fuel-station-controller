import { HealthController } from './health.controller';

describe('HealthController', () => {
    it('returns liveness metadata without external dependencies', () => {
        const controller = new HealthController(
            {} as any,
            {} as any,
            {} as any,
            {} as any,
        );

        expect(controller.live()).toEqual(expect.objectContaining({
            status: 'ok',
            uptimeSeconds: expect.any(Number),
            startedAt: expect.any(String),
        }));
    });

    it('returns process metrics', () => {
        const controller = new HealthController(
            {} as any,
            {} as any,
            {} as any,
            {} as any,
        );

        expect(controller.metrics()).toEqual(expect.objectContaining({
            process: expect.objectContaining({ pid: process.pid }),
            memory: expect.objectContaining({ heapUsed: expect.any(Number) }),
        }));
    });
});
