import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PaginationDto, PaginatedResponse } from '../common/dto/pagination.dto';

@Injectable()
export class PricesService {
    constructor(private prisma: PrismaService) {}

    async getCurrentPrices(companyId: string, stationId?: string) {
        return this.prisma.priceSetting.findMany({
            where: {
                station: { companyId, ...(stationId ? { id: stationId } : {}), deletedAt: null },
            },
            orderBy: [{ stationId: 'asc' }, { fpId: 'asc' }, { nozzleIndex: 'asc' }],
        });
    }

    async getPriceHistory(companyId: string, stationId: string | undefined, pagination: PaginationDto) {
        const where = {
            companyId,
            ...(stationId ? { stationId } : {}),
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

        const existing = await this.prisma.priceSetting.findUnique({
            where: { stationId_fpId_nozzleIndex: { stationId, fpId, nozzleIndex } },
        });

        const [setting] = await this.prisma.$transaction([
            this.prisma.priceSetting.upsert({
                where: { stationId_fpId_nozzleIndex: { stationId, fpId, nozzleIndex } },
                create: { stationId, fpId, nozzleIndex, productId, productName, price, updatedBy },
                update: { price, productId, productName, updatedBy, updatedAt: new Date() },
            }),
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
