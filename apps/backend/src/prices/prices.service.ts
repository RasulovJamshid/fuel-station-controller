import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PaginationDto, PaginatedResponse } from '../common/dto/pagination.dto';
import { Prisma } from '@prisma/client';
import { ProductsService } from '../products/products.service';

@Injectable()
export class PricesService {
    constructor(private prisma: PrismaService, private products: ProductsService) {}

    async getCurrentPrices(companyId: string, stationId?: string, allowedStationIds?: string[]) {
        if (allowedStationIds && allowedStationIds.length === 0) return [];
        const stationFilter = allowedStationIds
            ? Prisma.sql`AND c."stationId" = ANY(${allowedStationIds})`
            : stationId ? Prisma.sql`AND c."stationId" = ${stationId}` : Prisma.empty;
        return this.prisma.$queryRaw<any[]>`
            WITH candidates AS (
                SELECT ps."stationId", ps."fpId", ps."nozzleIndex", ps."productId", ps."productName",
                       ps."canonicalProductId", ps.price, ps."updatedAt" AS "observedAt",
                       ps."updatedBy", 'price_setting'::text AS source
                FROM "PriceSetting" ps
                UNION ALL
                SELECT t."stationId", t."fpId", t."nozzleIndex", t."productId", t."productName",
                       t."canonicalProductId", t.price, COALESCE(t."completedAt", t."startedAt") AS "observedAt",
                       'transaction'::text AS "updatedBy", 'transaction'::text AS source
                FROM "Transaction" t
                WHERE t.price > 0 AND t.status IN ('COMPLETED', 'STOPPED') AND t."deletedAt" IS NULL
            ), latest AS (
                SELECT DISTINCT ON (c."stationId", c."fpId", c."nozzleIndex") c.*
                FROM candidates c
                JOIN "Station" s ON s.id = c."stationId"
                WHERE s."companyId" = ${companyId} AND s."deletedAt" IS NULL ${stationFilter}
                ORDER BY c."stationId", c."fpId", c."nozzleIndex", c."observedAt" DESC
            )
            SELECT l.*, l."observedAt" AS "updatedAt", p.name AS "canonicalProductName", p.code AS "canonicalProductCode",
                   s.name AS "stationName"
            FROM latest l
            JOIN "Station" s ON s.id = l."stationId"
            LEFT JOIN "Product" p ON p.id = l."canonicalProductId" AND p."deletedAt" IS NULL
            ORDER BY s.name, COALESCE(p.name, l."productName"), l."fpId", l."nozzleIndex"
        `;
    }

    async getPriceMatrix(companyId: string, stationId?: string, allowedStationIds?: string[]) {
        const current = await this.getCurrentPrices(companyId, stationId, allowedStationIds);
        const latest = new Map<string, any>();
        for (const row of current) {
            const productKey = row.canonicalProductId ?? `${row.productId}:${row.productName.toLocaleLowerCase()}`;
            const key = `${row.stationId}:${productKey}`;
            const existing = latest.get(key);
            if (!existing || new Date(row.updatedAt) > new Date(existing.updatedAt)) latest.set(key, row);
        }
        return [...latest.values()];
    }

    async getPriceHistory(companyId: string, stationId: string | undefined, pagination: PaginationDto, allowedStationIds?: string[]) {
        if (allowedStationIds && allowedStationIds.length === 0) return { data: [], total: 0, page: 1, pages: 1 };
        const where = {
            companyId,
            ...(allowedStationIds ? { stationId: { in: allowedStationIds } } :
                stationId ? { stationId } : {}),
        };
        const [data, total] = await this.prisma.$transaction([
            this.prisma.priceChangeLog.findMany({
                where,
                orderBy: { changedAt: 'desc' },
                skip: pagination.skip,
                take: pagination.limit,
            }),
            this.prisma.priceChangeLog.count({ where }),
        ]);
        return PaginatedResponse.of(data, total, pagination);
    }

    async setPrice(
        companyId: string,
        updatedBy: string,
        stationId: string,
        fpId: string,
        nozzleIndex: number,
        productId: number,
        productName: string,
        price: number,
    ) {
        // Verify the station belongs to this company.
        const station = await this.prisma.station.findFirst({
            where: { id: stationId, companyId, deletedAt: null },
        });
        if (!station) throw new Error('Station not found');
        const mapping = await this.products.resolve(companyId, stationId, productId, productName);

        const existing = await this.prisma.priceSetting.findUnique({
            where: { stationId_fpId_nozzleIndex: { stationId, fpId, nozzleIndex } },
        });

        const [setting] = await this.prisma.$transaction([
            this.prisma.priceSetting.upsert({
                where: { stationId_fpId_nozzleIndex: { stationId, fpId, nozzleIndex } },
                create: { stationId, fpId, nozzleIndex, productId, productName, price, updatedBy, canonicalProductId: mapping?.productId ?? null },
                update: { price, productId, productName, updatedBy, updatedAt: new Date(), canonicalProductId: mapping?.productId ?? null },
            } as any),
            this.prisma.priceChangeLog.create({
                data: {
                    companyId,
                    stationId,
                    fpId,
                    nozzleIndex,
                    productName,
                    oldPrice: existing?.price ?? 0,
                    newPrice: price,
                    changedBy: updatedBy,
                    source: 'dashboard',
                },
            }),
        ]);
        return setting;
    }
}
