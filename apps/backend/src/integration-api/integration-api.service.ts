import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PaginatedResponse } from '../common/dto/pagination.dto';
import { AuthenticatedToken } from '../common/decorators/current-token.decorator';
import {
    QueryIntegrationTransactionsDto,
    QueryIntegrationSummaryDto,
    QueryIntegrationShiftsDto,
    QueryIntegrationPricesDto,
    QueryIntegrationStationsDto,
    QueryIntegrationReadingsDto,
} from './dto/integration-query.dto';

/**
 * Read-only data access for external integrations. Every query is
 * hard-scoped to the token's company and to the station set the token
 * is permitted to see (`resolveStationScope`), so a token can never
 * reach another company's data regardless of the filters it passes.
 */
@Injectable()
export class IntegrationApiService {
    constructor(private prisma: PrismaService) {}

    /**
     * Resolve the concrete set of station IDs this token may read,
     * intersected with any station/oil-base filter on the request.
     * Returns [] when the intersection is empty (⇒ no rows).
     */
    private async resolveStationScope(
        token: AuthenticatedToken,
        q: { stationId?: string; oilBaseId?: string },
    ): Promise<string[]> {
        const where: any = { companyId: token.companyId, deletedAt: null };

        // Token-level station restriction
        if (token.stationIds.length > 0) where.id = { in: token.stationIds };

        // Token-level oil-base restriction, narrowed further by a requested oil base
        if (q.oilBaseId) {
            where.oilBaseId = token.oilBaseIds.length > 0
                ? { in: token.oilBaseIds.filter(id => id === q.oilBaseId) }
                : q.oilBaseId;
        } else if (token.oilBaseIds.length > 0) {
            where.oilBaseId = { in: token.oilBaseIds };
        }

        // Requested single station, narrowed by the token restriction above
        if (q.stationId) {
            where.id = token.stationIds.length > 0
                ? { in: token.stationIds.filter(id => id === q.stationId) }
                : q.stationId;
        }

        const rows = await this.prisma.station.findMany({ where, select: { id: true } });
        return rows.map(r => r.id);
    }

    // ── Transactions ────────────────────────────────────────────
    async transactions(token: AuthenticatedToken, q: QueryIntegrationTransactionsDto) {
        const stationIds = await this.resolveStationScope(token, q);
        if (stationIds.length === 0) return PaginatedResponse.of([], 0, q);

        const where: any = {
            companyId: token.companyId,
            deletedAt: null,
            stationId: { in: stationIds },
            ...(q.fpId          ? { fpId: q.fpId }                : {}),
            ...(q.productId != null ? { productId: q.productId }  : {}),
            ...(q.shiftId       ? { shiftId: q.shiftId }          : {}),
            ...(q.operatorName  ? { operatorName: { contains: q.operatorName, mode: 'insensitive' } } : {}),
            ...(q.status?.length ? { status: { in: q.status } }   : {}),
            ...(q.from || q.to  ? { startedAt: {
                ...(q.from ? { gte: new Date(q.from) } : {}),
                ...(q.to   ? { lte: new Date(q.to)   } : {}),
            } } : {}),
        };

        const [data, total] = await this.prisma.$transaction([
            this.prisma.transaction.findMany({
                where, orderBy: { [q.sort]: q.order }, skip: q.skip, take: q.limit,
            }),
            this.prisma.transaction.count({ where }),
        ]);
        return PaginatedResponse.of(data, total, q);
    }

    /**
     * Aggregated totals for a station over a period: overall count/volume/amount,
     * plus breakdowns by product (with weighted avg + min/max price) and by status.
     */
    async transactionsSummary(token: AuthenticatedToken, q: QueryIntegrationSummaryDto) {
        const stationIds = await this.resolveStationScope(token, q);
        const empty = {
            period:     { from: q.from ?? null, to: q.to ?? null },
            stationIds,
            totals:     { transactions: 0, volume: 0, amount: 0 },
            byProduct:  [] as any[],
            byStatus:   [] as any[],
        };
        if (stationIds.length === 0) return empty;

        const where: any = {
            companyId: token.companyId,
            deletedAt: null,
            stationId: { in: stationIds },
            ...(q.from || q.to ? { startedAt: {
                ...(q.from ? { gte: new Date(q.from) } : {}),
                ...(q.to   ? { lte: new Date(q.to)   } : {}),
            } } : {}),
        };

        const [byProductRaw, byStatusRaw] = await Promise.all([
            this.prisma.transaction.groupBy({
                by:      ['productId', 'productName'],
                where,
                _count:  { _all: true },
                _sum:    { volume: true, amount: true },
                _min:    { price: true },
                _max:    { price: true },
                orderBy: { productId: 'asc' },
            }),
            this.prisma.transaction.groupBy({
                by:      ['status'],
                where,
                _count:  { _all: true },
                _sum:    { volume: true, amount: true },
                orderBy: { status: 'asc' },
            }),
        ]);

        const byProduct = byProductRaw.map(g => {
            const volume = g._sum.volume ?? 0;
            const amount = Number(g._sum.amount ?? 0);
            return {
                productId:    g.productId,
                productName:  g.productName,
                transactions: g._count._all,
                volume,
                amount,
                avgPrice:     volume > 0 ? Math.round(amount / volume) : 0,
                minPrice:     g._min.price ?? 0,
                maxPrice:     g._max.price ?? 0,
            };
        }).sort((a, b) => b.amount - a.amount);

        const byStatus = byStatusRaw.map(g => ({
            status:       g.status,
            transactions: g._count._all,
            volume:       g._sum.volume ?? 0,
            amount:       Number(g._sum.amount ?? 0),
        }));

        return {
            period:    { from: q.from ?? null, to: q.to ?? null },
            stationIds,
            totals: {
                transactions: byProduct.reduce((s, p) => s + p.transactions, 0),
                volume:       byProduct.reduce((s, p) => s + p.volume, 0),
                amount:       byProduct.reduce((s, p) => s + p.amount, 0),
            },
            byProduct,
            byStatus,
        };
    }

    async transaction(token: AuthenticatedToken, id: string) {
        const stationIds = await this.resolveStationScope(token, {});
        const tx = stationIds.length === 0 ? null : await this.prisma.transaction.findFirst({
            where: { id, companyId: token.companyId, deletedAt: null, stationId: { in: stationIds } },
        });
        if (!tx) throw new NotFoundException('Transaction not found');
        return tx;
    }

    // ── Shifts ──────────────────────────────────────────────────
    async shifts(token: AuthenticatedToken, q: QueryIntegrationShiftsDto) {
        const stationIds = await this.resolveStationScope(token, q);
        if (stationIds.length === 0) return PaginatedResponse.of([], 0, q);

        const where: any = {
            companyId: token.companyId,
            deletedAt: null,
            stationId: { in: stationIds },
            ...(q.operatorName ? { operatorName: { contains: q.operatorName, mode: 'insensitive' } } : {}),
            ...(q.status       ? { status: q.status } : {}),
            ...(q.from || q.to ? { startedAt: {
                ...(q.from ? { gte: new Date(q.from) } : {}),
                ...(q.to   ? { lte: new Date(q.to)   } : {}),
            } } : {}),
        };

        const [data, total] = await this.prisma.$transaction([
            this.prisma.shift.findMany({
                where, orderBy: { [q.sort]: q.order }, skip: q.skip, take: q.limit,
                include: { positionTotals: true },
            }),
            this.prisma.shift.count({ where }),
        ]);
        return PaginatedResponse.of(data, total, q);
    }

    async shift(token: AuthenticatedToken, id: string) {
        const stationIds = await this.resolveStationScope(token, {});
        const shift = stationIds.length === 0 ? null : await this.prisma.shift.findFirst({
            where: { id, companyId: token.companyId, deletedAt: null, stationId: { in: stationIds } },
            include: { positionTotals: true },
        });
        if (!shift) throw new NotFoundException('Shift not found');
        return shift;
    }

    // ── Prices ──────────────────────────────────────────────────
    async prices(token: AuthenticatedToken, q: QueryIntegrationPricesDto) {
        const stationIds = await this.resolveStationScope(token, q);
        if (stationIds.length === 0) return PaginatedResponse.of([], 0, q);

        const where: any = {
            stationId: { in: stationIds },
            ...(q.productId != null ? { productId: q.productId } : {}),
            ...(q.fpId ? { fpId: q.fpId } : {}),
        };

        const [data, total] = await this.prisma.$transaction([
            this.prisma.priceSetting.findMany({
                where, orderBy: { [q.sort]: q.order }, skip: q.skip, take: q.limit,
            }),
            this.prisma.priceSetting.count({ where }),
        ]);
        return PaginatedResponse.of(data, total, q);
    }

    // ── Stations ────────────────────────────────────────────────
    async stations(token: AuthenticatedToken, q: QueryIntegrationStationsDto) {
        const stationIds = await this.resolveStationScope(token, q);
        if (stationIds.length === 0) return PaginatedResponse.of([], 0, q);

        const where: any = {
            id: { in: stationIds },
            ...(q.active != null ? { active: q.active } : {}),
        };

        const [data, total] = await this.prisma.$transaction([
            this.prisma.station.findMany({
                where, orderBy: { [q.sort]: q.order }, skip: q.skip, take: q.limit,
                select: {
                    id: true, name: true, address: true, timezone: true, oilBaseId: true,
                    active: true, lastSyncAt: true, lastSeenAt: true, createdAt: true,
                },
            }),
            this.prisma.station.count({ where }),
        ]);
        return PaginatedResponse.of(data, total, q);
    }

    async station(token: AuthenticatedToken, id: string) {
        const stationIds = await this.resolveStationScope(token, { stationId: id });
        const station = stationIds.length === 0 ? null : await this.prisma.station.findFirst({
            where: { id, companyId: token.companyId, deletedAt: null },
            select: {
                id: true, name: true, address: true, timezone: true, oilBaseId: true,
                active: true, lastSyncAt: true, lastSeenAt: true, createdAt: true,
            },
        });
        if (!station) throw new NotFoundException('Station not found');
        return station;
    }

    // ── Tank (reservoir) readings ───────────────────────────────
    async tankReadings(token: AuthenticatedToken, q: QueryIntegrationReadingsDto) {
        const stationIds = await this.resolveStationScope(token, q);
        if (stationIds.length === 0) return PaginatedResponse.of([], 0, q);

        const where: any = {
            companyId: token.companyId,
            stationId: { in: stationIds },
            ...(q.reservoirId ? { reservoirId: q.reservoirId } : {}),
            ...(q.from || q.to ? { readingAt: {
                ...(q.from ? { gte: new Date(q.from) } : {}),
                ...(q.to   ? { lte: new Date(q.to)   } : {}),
            } } : {}),
        };

        const [data, total] = await this.prisma.$transaction([
            this.prisma.reservoirReading.findMany({
                where, orderBy: { [q.sort]: q.order }, skip: q.skip, take: q.limit,
            }),
            this.prisma.reservoirReading.count({ where }),
        ]);
        return PaginatedResponse.of(data, total, q);
    }
}
