import { UserRole } from '@prisma/client';
import { resolveStationIds } from './station-access.helper';

describe('resolveStationIds', () => {
    it('returns active company stations for admins when no station filter is requested', async () => {
        const prisma: any = {
            station: {
                findMany: jest.fn().mockResolvedValue([{ id: 'st-1' }, { id: 'st-2' }]),
            },
        };

        await expect(resolveStationIds(prisma, {
            id: 'u-1',
            companyId: 'c-1',
            role: UserRole.COMPANY_ADMIN,
        })).resolves.toEqual(['st-1', 'st-2']);

        expect(prisma.station.findMany).toHaveBeenCalledWith({
            where: { companyId: 'c-1', deletedAt: null, active: true },
            select: { id: true },
        });
    });

    it('validates requested admin station ids against the company', async () => {
        const prisma: any = {
            station: {
                findMany: jest.fn().mockResolvedValue([{ id: 'st-1' }]),
            },
        };

        await expect(resolveStationIds(prisma, {
            id: 'u-1',
            companyId: 'c-1',
            role: UserRole.COMPANY_ADMIN,
        }, ['st-1', 'other-company-station'])).resolves.toEqual(['st-1']);

        expect(prisma.station.findMany).toHaveBeenCalledWith({
            where: {
                companyId: 'c-1',
                deletedAt: null,
                active: true,
                id: { in: ['st-1', 'other-company-station'] },
            },
            select: { id: true },
        });
    });

    it('intersects requested stations with granted stations for restricted users', async () => {
        const prisma: any = {
            stationAccess: {
                findMany: jest.fn().mockResolvedValue([{ stationId: 'st-1' }, { stationId: 'st-2' }]),
            },
        };

        await expect(resolveStationIds(prisma, {
            id: 'u-1',
            companyId: 'c-1',
            role: UserRole.ACCOUNTANT,
        }, ['st-2', 'st-3'])).resolves.toEqual(['st-2']);
    });
});
