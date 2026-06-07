import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { IsString, IsOptional, MinLength } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';

export class CreateOilBaseDto {
    @ApiProperty({ example: 'Нефтебаза №1 Ташкент' })
    @IsString() @MinLength(2) name: string;

    @ApiPropertyOptional()
    @IsOptional() @IsString() address?: string;
}

export class UpdateOilBaseDto {
    @ApiPropertyOptional() @IsOptional() @IsString() @MinLength(2) name?: string;
    @ApiPropertyOptional() @IsOptional() @IsString() address?: string;
    @ApiPropertyOptional() @IsOptional() active?: boolean;
}

@Injectable()
export class OilBasesService {
    constructor(private prisma: PrismaService) {}

    async create(companyId: string, dto: CreateOilBaseDto) {
        return this.prisma.oilBase.create({
            data: { companyId, name: dto.name, address: dto.address },
        });
    }

    findAll(companyId: string) {
        return this.prisma.oilBase.findMany({
            where: { companyId, deletedAt: null },
            include: {
                stations: {
                    where: { deletedAt: null },
                    select: {
                        id: true, name: true, active: true,
                        lastSyncAt: true, lastSeenAt: true,
                    },
                },
            },
            orderBy: { name: 'asc' },
        });
    }

    async findOne(id: string, companyId: string) {
        const ob = await this.prisma.oilBase.findFirst({
            where: { id, companyId, deletedAt: null },
            include: {
                stations: {
                    where: { deletedAt: null },
                    include: { reservoirs: { where: { deletedAt: null } } },
                },
            },
        });
        if (!ob) throw new NotFoundException('Oil base not found');
        return ob;
    }

    async update(id: string, companyId: string, dto: UpdateOilBaseDto) {
        await this.findOne(id, companyId);
        return this.prisma.oilBase.update({ where: { id }, data: dto });
    }

    async remove(id: string, companyId: string) {
        await this.findOne(id, companyId);
        // Detach stations from this oil base before soft-deleting
        await this.prisma.station.updateMany({
            where: { oilBaseId: id },
            data: { oilBaseId: null },
        });
        return this.prisma.oilBase.update({
            where: { id },
            data: { deletedAt: new Date() },
        });
    }

    async assignStation(oilBaseId: string, stationId: string, companyId: string) {
        await this.findOne(oilBaseId, companyId);
        const station = await this.prisma.station.findFirst({
            where: { id: stationId, companyId, deletedAt: null },
        });
        if (!station) throw new NotFoundException('Station not found');
        return this.prisma.station.update({
            where: { id: stationId },
            data: { oilBaseId },
        });
    }

    async detachStation(stationId: string, companyId: string) {
        const station = await this.prisma.station.findFirst({
            where: { id: stationId, companyId, deletedAt: null },
        });
        if (!station) throw new NotFoundException('Station not found');
        return this.prisma.station.update({
            where: { id: stationId },
            data: { oilBaseId: null },
        });
    }

    // Summary with aggregated stats per oil base
    async getSummary(companyId: string) {
        const oilBases = await this.prisma.oilBase.findMany({
            where: { companyId, deletedAt: null },
            include: {
                stations: {
                    where: { deletedAt: null },
                    select: { id: true, name: true, lastSyncAt: true, active: true },
                },
            },
        });

        const today = new Date();
        today.setHours(0, 0, 0, 0);

        const results = await Promise.all(oilBases.map(async ob => {
            const stationIds = ob.stations.map(s => s.id);
            if (stationIds.length === 0) {
                return { ...ob, todayVolume: 0, todayTransactions: 0, activeShifts: 0 };
            }

            const [txAgg, activeShifts] = await this.prisma.$transaction([
                this.prisma.transaction.aggregate({
                    where: {
                        stationId: { in: stationIds },
                        startedAt: { gte: today },
                        deletedAt: null,
                        status: { in: ['COMPLETED', 'STOPPED'] },
                    },
                    _sum: { volume: true },
                    _count: { id: true },
                }),
                this.prisma.shift.count({
                    where: {
                        stationId: { in: stationIds },
                        status: 'ACTIVE',
                        deletedAt: null,
                    },
                }),
            ]);

            return {
                ...ob,
                todayVolume:       txAgg._sum.volume ?? 0,
                todayTransactions: txAgg._count.id,
                activeShifts,
            };
        }));

        // Standalone stations (no oil base)
        const standalone = await this.prisma.station.findMany({
            where: { companyId, oilBaseId: null, deletedAt: null },
            select: { id: true, name: true, lastSyncAt: true, active: true },
        });

        return { oilBases: results, standalone };
    }
}
