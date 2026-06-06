import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PaginationDto, PaginatedResponse } from '../common/dto/pagination.dto';

@Injectable()
export class ShiftsService {
    constructor(private prisma: PrismaService) {}

    async findAll(companyId: string, stationId: string | undefined, pagination: PaginationDto) {
        const where: any = {
            companyId,
            deletedAt: null,
            ...(stationId ? { stationId } : {}),
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

    async getActive(companyId: string, stationId?: string) {
        return this.prisma.shift.findMany({
            where: {
                companyId,
                status: 'ACTIVE',
                deletedAt: null,
                ...(stationId ? { stationId } : {}),
            },
            include: { positionTotals: true },
        });
    }
}
