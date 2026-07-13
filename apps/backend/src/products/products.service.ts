import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

export type ProductInput = { code: string; name: string; active?: boolean };
export type MappingInput = {
    stationId: string;
    stationProductId?: number;
    stationProductName: string;
};

export const normalizeProductName = (name: string) =>
    name.trim().toLocaleLowerCase().replace(/[\s_-]+/g, '');

@Injectable()
export class ProductsService {
    constructor(private prisma: PrismaService) {}

    list(companyId: string) {
        return (this.prisma as any).product.findMany({
            where: { companyId, deletedAt: null },
            include: {
                mappings: {
                    include: { station: { select: { id: true, name: true } } },
                    orderBy: [{ stationId: 'asc' }, { stationProductName: 'asc' }],
                },
            },
            orderBy: { name: 'asc' },
        });
    }

    async create(companyId: string, input: ProductInput) {
        const code = input.code.trim().toUpperCase();
        const exists = await (this.prisma as any).product.findUnique({ where: { companyId_code: { companyId, code } } });
        if (exists) throw new ConflictException(`Product code "${code}" already exists`);
        return (this.prisma as any).product.create({
            data: { companyId, code, name: input.name.trim(), active: input.active ?? true },
        });
    }

    async update(companyId: string, id: string, input: Partial<ProductInput>) {
        await this.requireProduct(companyId, id);
        return (this.prisma as any).product.update({
            where: { id },
            data: {
                ...(input.code != null ? { code: input.code.trim().toUpperCase() } : {}),
                ...(input.name != null ? { name: input.name.trim() } : {}),
                ...(input.active != null ? { active: input.active } : {}),
            },
        });
    }

    async remove(companyId: string, id: string) {
        await this.requireProduct(companyId, id);
        return (this.prisma as any).product.update({ where: { id }, data: { active: false, deletedAt: new Date() } });
    }

    async discovered(companyId: string, allowedStationIds: string[]) {
        if (allowedStationIds.length === 0) return [];
        return this.prisma.$queryRaw<any[]>`
            WITH station_products AS (
                SELECT DISTINCT t."stationId", t."productId" AS "stationProductId", t."productName" AS "stationProductName"
                FROM "Transaction" t
                WHERE t."companyId" = ${companyId} AND t."stationId" = ANY(${allowedStationIds}) AND t."deletedAt" IS NULL
                UNION
                SELECT DISTINCT ps."stationId", ps."productId", ps."productName"
                FROM "PriceSetting" ps JOIN "Station" s ON s.id = ps."stationId"
                WHERE s."companyId" = ${companyId} AND ps."stationId" = ANY(${allowedStationIds})
            )
            SELECT sp.*, s.name AS "stationName", m.id AS "mappingId", m."productId" AS "canonicalProductId"
            FROM station_products sp
            JOIN "Station" s ON s.id = sp."stationId"
            LEFT JOIN "StationProductMapping" m
              ON m."stationId" = sp."stationId"
             AND m."normalizedName" = regexp_replace(lower(trim(sp."stationProductName")), '[\\s_-]+', '', 'g')
            ORDER BY s.name, sp."stationProductName"
        `;
    }

    async map(companyId: string, productId: string, input: MappingInput) {
        await this.requireProduct(companyId, productId);
        const station = await this.prisma.station.findFirst({ where: { id: input.stationId, companyId, deletedAt: null } });
        if (!station) throw new NotFoundException('Station not found');
        const normalizedName = normalizeProductName(input.stationProductName);
        const mapping = await (this.prisma as any).stationProductMapping.upsert({
            where: { stationId_normalizedName: { stationId: input.stationId, normalizedName } },
            create: { companyId, productId, normalizedName, ...input },
            update: { productId, stationProductId: input.stationProductId ?? null, stationProductName: input.stationProductName },
        });

        const rawWhere: any = {
            stationId: input.stationId,
            OR: [
                ...(input.stationProductId != null ? [{ productId: input.stationProductId }] : []),
                { productName: { equals: input.stationProductName, mode: 'insensitive' } },
            ],
        };
        await this.prisma.$transaction([
            (this.prisma.transaction as any).updateMany({ where: rawWhere, data: { canonicalProductId: productId } }),
            (this.prisma.priceSetting as any).updateMany({ where: rawWhere, data: { canonicalProductId: productId } }),
        ]);
        return mapping;
    }

    async unmap(companyId: string, mappingId: string) {
        const mapping = await (this.prisma as any).stationProductMapping.findFirst({ where: { id: mappingId, companyId } });
        if (!mapping) throw new NotFoundException('Product mapping not found');
        const rawWhere: any = {
            stationId: mapping.stationId,
            canonicalProductId: mapping.productId,
            OR: [
                ...(mapping.stationProductId != null ? [{ productId: mapping.stationProductId }] : []),
                { productName: { equals: mapping.stationProductName, mode: 'insensitive' } },
            ],
        };
        await this.prisma.$transaction([
            (this.prisma.transaction as any).updateMany({ where: rawWhere, data: { canonicalProductId: null } }),
            (this.prisma.priceSetting as any).updateMany({ where: rawWhere, data: { canonicalProductId: null } }),
            (this.prisma as any).stationProductMapping.delete({ where: { id: mappingId } }),
        ]);
        return { deleted: true };
    }

    async resolve(companyId: string, stationId: string, stationProductId: number | null, name: string) {
        const normalizedName = normalizeProductName(name || '');
        const byName = normalizedName ? await (this.prisma as any).stationProductMapping.findFirst({
            where: {
                companyId, stationId, normalizedName,
            },
            select: { productId: true },
        }) : null;
        if (byName || stationProductId == null) return byName;
        return (this.prisma as any).stationProductMapping.findFirst({
            where: { companyId, stationId, stationProductId },
            select: { productId: true },
        });
    }

    private async requireProduct(companyId: string, id: string) {
        const product = await (this.prisma as any).product.findFirst({ where: { id, companyId, deletedAt: null } });
        if (!product) throw new NotFoundException('Product not found');
        return product;
    }
}
