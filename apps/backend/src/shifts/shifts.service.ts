import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PaginationDto, PaginatedResponse } from '../common/dto/pagination.dto';

@Injectable()
export class ShiftsService {
    constructor(private prisma: PrismaService) {}

    private async stationIdsForOilBase(companyId: string, oilBaseId: string): Promise<string[]> {
        const rows = await this.prisma.station.findMany({
            where: { companyId, oilBaseId, deletedAt: null },
            select: { id: true },
        });
        return rows.map(r => r.id);
    }

    async findAll(companyId: string, stationId: string | undefined, pagination: PaginationDto, oilBaseId?: string) {
        const oilBaseStationIds = oilBaseId
            ? await this.stationIdsForOilBase(companyId, oilBaseId)
            : null;
        if (oilBaseStationIds !== null && oilBaseStationIds.length === 0) {
            return { data: [], total: 0, page: 1, pages: 1 };
        }

        const where: any = {
            companyId,
            deletedAt: null,
            ...(oilBaseStationIds ? { stationId: { in: oilBaseStationIds } } :
                stationId         ? { stationId }                            : {}),
        };
        const [data, total] = await this.prisma.$transaction([
            this.prisma.shift.findMany({
                where,
                include: { positionTotals: true },
                orderBy: { startedAt: 'desc' },
                skip:    pagination.skip,
                take:    pagination.limit,
            }),
            this.prisma.shift.count({ where }),
        ]);
        return PaginatedResponse.of(data, total, pagination);
    }

    async findOne(id: string, companyId: string) {
        const shift = await this.prisma.shift.findFirst({
            where: { id, companyId, deletedAt: null },
            include: { positionTotals: true },
        });
        if (!shift) throw new NotFoundException('Shift not found');
        return shift;
    }

    async getActive(companyId: string, stationId?: string, oilBaseId?: string) {
        const oilBaseStationIds = oilBaseId
            ? await this.stationIdsForOilBase(companyId, oilBaseId)
            : null;

        return this.prisma.shift.findMany({
            where: {
                companyId,
                status: 'ACTIVE',
                deletedAt: null,
                ...(oilBaseStationIds ? { stationId: { in: oilBaseStationIds } } :
                    stationId         ? { stationId }                            : {}),
            },
            include: { positionTotals: true },
        });
    }
}
