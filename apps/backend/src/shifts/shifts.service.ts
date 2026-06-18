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

    async findAll(companyId: string, stationId: string | undefined, pagination: PaginationDto, oilBaseId?: string, allowedStationIds?: string[]) {
        if (allowedStationIds && allowedStationIds.length === 0) return { data: [], total: 0, page: 1, pages: 1 };
        const oilBaseStationIds = oilBaseId
            ? await this.stationIdsForOilBase(companyId, oilBaseId)
            : null;
        if (oilBaseStationIds !== null && oilBaseStationIds.length === 0) {
            return { data: [], total: 0, page: 1, pages: 1 };
        }
        const stationIds = allowedStationIds
            ? (oilBaseStationIds ?? allowedStationIds).filter(id => allowedStationIds.includes(id))
            : oilBaseStationIds;
        if (stationIds && stationIds.length === 0) return { data: [], total: 0, page: 1, pages: 1 };

        const where: any = {
            companyId,
            deletedAt: null,
            ...(stationIds ? { stationId: { in: stationIds } } :
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

    async findOne(id: string, companyId: string, allowedStationIds?: string[]) {
        if (allowedStationIds && allowedStationIds.length === 0) throw new NotFoundException('Shift not found');
        const shift = await this.prisma.shift.findFirst({
            where: {
                id,
                companyId,
                deletedAt: null,
                ...(allowedStationIds ? { stationId: { in: allowedStationIds } } : {}),
            },
            include: { positionTotals: true },
        });
        if (!shift) throw new NotFoundException('Shift not found');
        return shift;
    }

    async getActive(companyId: string, stationId?: string, oilBaseId?: string, allowedStationIds?: string[]) {
        if (allowedStationIds && allowedStationIds.length === 0) return [];
        const oilBaseStationIds = oilBaseId
            ? await this.stationIdsForOilBase(companyId, oilBaseId)
            : null;
        const stationIds = allowedStationIds
            ? (oilBaseStationIds ?? allowedStationIds).filter(id => allowedStationIds.includes(id))
            : oilBaseStationIds;
        if (stationIds && stationIds.length === 0) return [];

        return this.prisma.shift.findMany({
            where: {
                companyId,
                status: 'ACTIVE',
                deletedAt: null,
                ...(stationIds ? { stationId: { in: stationIds } } :
                    stationId         ? { stationId }                            : {}),
            },
            include: { positionTotals: true },
        });
    }
}
