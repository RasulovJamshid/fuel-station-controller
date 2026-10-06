import { BadRequestException, Injectable } from '@nestjs/common';
import { IsString, IsNumber, IsInt, Min, Max, IsNotEmpty, IsPositive } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export class CreateReservoirDto {
    @ApiProperty({ description: 'Station the reservoir belongs to', example: 'stn_abc123' }) @IsString() stationId: string;
    @ApiProperty({ description: 'Tank identifier unique within the station', example: 'tank1' }) @IsString() @IsNotEmpty() tankId: string;
    @ApiProperty({ description: 'Human-readable reservoir label', example: 'Tank 1 - AI-92' }) @IsString() @IsNotEmpty() label: string;
    @ApiProperty({ description: 'Numeric product code stored in the tank', example: 92 }) @IsInt() @Min(0) @Max(255) productId: number;
    @ApiProperty({ description: 'Human-readable product name', example: 'AI-92' }) @IsString() productName: string;
    @ApiProperty({ description: 'Tank capacity in litres', example: 50000 }) @IsNumber() @IsPositive() capacity: number;
}

@Injectable()
export class ReservoirsService {
    constructor(private prisma: PrismaService) {}

    async create(dto: CreateReservoirDto) {
        const existing = await this.prisma.reservoir.findUnique({where:{stationId_tankId:{stationId:dto.stationId,tankId:dto.tankId}}});
        if (existing?.managedByStation) throw new BadRequestException('This tank is managed by the station configuration. Update it in the station ATG settings.');
        const reservoir = await this.prisma.reservoir.upsert({
            where: { stationId_tankId: { stationId: dto.stationId, tankId: dto.tankId } },
            create: dto,
            update: {
                label:       dto.label,
                capacity:    dto.capacity,
                productId:   dto.productId,
                productName: dto.productName,
            },
        });
        // fillPercent is denormalized in incoming readings. Recalculate it when
        // capacity is corrected so every API consumer sees a consistent value.
        await this.prisma.$executeRaw`
            UPDATE "ReservoirReading"
            SET "fillPercent" = CASE
                WHEN ${reservoir.capacity} > 0 THEN "volumeLitres" / ${reservoir.capacity} * 100
                ELSE NULL
            END
            WHERE "reservoirId" = ${reservoir.id}
        `;
        return reservoir;
    }

    stockRecords(companyId: string, stationIds: string[], tankId?: string) {
        return this.prisma.stationStockRecord.findMany({where:{companyId,stationId:{in:stationIds},...(tankId?{tankId}:{})},orderBy:{occurredAt:'desc'},take:500});
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
                r.capacity, r."managedByStation", r."monitoringEnabled", r."staleAfterSecs", rr."volumeLitres",
                CASE
                    WHEN rr."volumeLitres" IS NULL OR r.capacity <= 0 THEN NULL
                    ELSE rr."volumeLitres" / r.capacity * 100
                END AS "fillPercent",
                rr."levelMm", rr."waterMm", rr."temperatureC", rr."readingAt"
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
