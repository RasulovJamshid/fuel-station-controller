import { Injectable } from '@nestjs/common';
import { IsString, IsNumber } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export class CreateReservoirDto {
    @ApiProperty({ description: 'Station the reservoir belongs to', example: 'stn_abc123' }) @IsString() stationId: string;
    @ApiProperty({ description: 'Tank identifier unique within the station', example: 'tank1' }) @IsString() tankId: string;
    @ApiProperty({ description: 'Human-readable reservoir label', example: 'Tank 1 - AI-92' }) @IsString() label: string;
    @ApiProperty({ description: 'Numeric product code stored in the tank', example: 92 }) @IsNumber() productId: number;
    @ApiProperty({ description: 'Human-readable product name', example: 'AI-92' }) @IsString() productName: string;
    @ApiProperty({ description: 'Tank capacity in litres', example: 50000 }) @IsNumber() capacity: number;
}

@Injectable()
export class ReservoirsService {
    constructor(private prisma: PrismaService) {}

    create(dto: CreateReservoirDto) {
        return this.prisma.reservoir.upsert({
            where: { stationId_tankId: { stationId: dto.stationId, tankId: dto.tankId } },
            create: dto,
            update: {
                label:       dto.label,
                capacity:    dto.capacity,
                productId:   dto.productId,
                productName: dto.productName,
            },
        });
    }

    findAll(companyId: string, stationId?: string, allowedStationIds?: string[]) {
        if (allowedStationIds && allowedStationIds.length === 0) return [];
        return this.prisma.reservoir.findMany({
            where: {
                deletedAt: null,
                station: {
                    companyId,
                    ...(allowedStationIds ? { id: { in: allowedStationIds } } :
                        stationId ? { id: stationId } : {}),
                },
            },
            include: {
                readings: {
                    orderBy: { readingAt: 'desc' },
                    take: 1,
                },
            },
        });
    }

    async latestReadings(companyId: string, stationId?: string, allowedStationIds?: string[]) {
        if (allowedStationIds && allowedStationIds.length === 0) return [];
        const stationFilter = allowedStationIds
            ? Prisma.sql`AND r."stationId" = ANY(${allowedStationIds})`
            : stationId
            ? Prisma.sql`AND r."stationId" = ${stationId}`
            : Prisma.empty;

        const result: any[] = await this.prisma.$queryRaw`
            SELECT DISTINCT ON (r.id)
                r.id, r."stationId", r."tankId", r.label, r."productId", r."productName",
                r.capacity, rr."volumeLitres", rr."fillPercent",
                rr."levelMm", rr."temperatureC", rr."readingAt"
            FROM "Reservoir" r
            LEFT JOIN "ReservoirReading" rr ON rr."reservoirId" = r.id
            JOIN "Station" s ON s.id = r."stationId"
            WHERE r."deletedAt" IS NULL AND r.active = true
              AND s."companyId" = ${companyId}
              ${stationFilter}
            ORDER BY r.id, rr."readingAt" DESC NULLS LAST
        `;
        return result;
    }
}
