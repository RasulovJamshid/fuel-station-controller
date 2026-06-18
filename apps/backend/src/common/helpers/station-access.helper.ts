import { PrismaService } from '../../prisma/prisma.service';
import { UserRole } from '@prisma/client';

/**
 * Returns the list of station IDs this user is allowed to access.
 * SUPER_ADMIN and COMPANY_ADMIN see all stations.
 * STATION_MANAGER and ACCOUNTANT only see their granted stations.
 * Pass an empty array as `requestedIds` to mean "all accessible".
 */
export async function resolveStationIds(
    prisma: PrismaService,
    user: { id: string; companyId: string; role: string },
    requestedIds: string[] = [],
): Promise<string[]> {
    const adminRoles: string[] = [UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN];
    const isAdmin = adminRoles.includes(user.role);

    if (isAdmin) {
        const stations = await prisma.station.findMany({
            where: {
                companyId: user.companyId,
                deletedAt: null,
                active: true,
                ...(requestedIds.length > 0 ? { id: { in: requestedIds } } : {}),
            },
            select: { id: true },
        });
        return stations.map(s => s.id);
    }

    // Restricted users: intersection of requested and granted
    const granted = await prisma.stationAccess.findMany({
        where: { userId: user.id },
        select: { stationId: true },
    });
    const grantedIds = granted.map(g => g.stationId);

    if (requestedIds.length === 0) return grantedIds;
    return requestedIds.filter(id => grantedIds.includes(id));
}
