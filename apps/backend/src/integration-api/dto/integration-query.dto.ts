import {
    IsOptional, IsString, IsIn, IsInt, IsArray, IsEnum, IsDateString, IsBoolean,
} from 'class-validator';
import { Type, Transform } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { TxStatus, ShiftStatus } from '@prisma/client';
import { PaginationDto } from '../../common/dto/pagination.dto';

/**
 * Shared base for every integration list query: pagination (page/limit),
 * a sort direction, and the station-scoping filters common to all
 * resources. Each resource DTO adds its own `sort` field (whitelisted
 * with `@IsIn`) plus resource-specific filters.
 */
export class IntegrationQueryDto extends PaginationDto {
    @ApiPropertyOptional({ description: 'Restrict to a single station ID', example: 'station-1' })
    @IsOptional() @IsString()
    stationId?: string;

    @ApiPropertyOptional({ description: 'Restrict to all stations under an oil base', example: 'oilbase-uuid' })
    @IsOptional() @IsString()
    oilBaseId?: string;

    @ApiPropertyOptional({ description: 'Sort direction', enum: ['asc', 'desc'], default: 'desc' })
    @IsOptional() @IsIn(['asc', 'desc'])
    order: 'asc' | 'desc' = 'desc';
}

// ── Transactions ────────────────────────────────────────────────
const TX_SORT = ['startedAt', 'completedAt', 'volume', 'amount', 'price', 'productName', 'status'] as const;

export class QueryIntegrationTransactionsDto extends IntegrationQueryDto {
    @ApiPropertyOptional({ description: 'Field to sort by', enum: TX_SORT, default: 'startedAt' })
    @IsOptional() @IsIn(TX_SORT as unknown as string[])
    sort: string = 'startedAt';

    @ApiPropertyOptional({ description: 'Filter by fuelling point (pump) ID', example: 'fp-1' })
    @IsOptional() @IsString()
    fpId?: string;

    @ApiPropertyOptional({ description: 'Filter by product ID', example: 95 })
    @IsOptional() @Type(() => Number) @IsInt()
    productId?: number;

    @ApiPropertyOptional({ description: 'Filter by shift ID', example: 'shift-uuid' })
    @IsOptional() @IsString()
    shiftId?: string;

    @ApiPropertyOptional({ description: 'Filter by operator name (case-insensitive partial match)', example: 'Ivan' })
    @IsOptional() @IsString()
    operatorName?: string;

    @ApiPropertyOptional({ description: 'Filter by one or more transaction statuses', enum: TxStatus, isArray: true })
    @IsOptional() @IsArray() @IsEnum(TxStatus, { each: true })
    status?: TxStatus[];

    @ApiPropertyOptional({ description: 'Include transactions started on or after this ISO date-time', example: '2026-01-01T00:00:00.000Z' })
    @IsOptional() @IsDateString()
    from?: string;

    @ApiPropertyOptional({ description: 'Include transactions started on or before this ISO date-time', example: '2026-01-31T23:59:59.000Z' })
    @IsOptional() @IsDateString()
    to?: string;
}

// ── Transaction summary (aggregates, no pagination) ─────────────
export class QueryIntegrationSummaryDto {
    @ApiPropertyOptional({ description: 'Restrict to a single station ID', example: 'station-1' })
    @IsOptional() @IsString()
    stationId?: string;

    @ApiPropertyOptional({ description: 'Restrict to all stations under an oil base', example: 'oilbase-uuid' })
    @IsOptional() @IsString()
    oilBaseId?: string;

    @ApiPropertyOptional({ description: 'Include transactions started on or after this ISO date-time', example: '2026-01-01T00:00:00.000Z' })
    @IsOptional() @IsDateString()
    from?: string;

    @ApiPropertyOptional({ description: 'Include transactions started on or before this ISO date-time', example: '2026-01-31T23:59:59.000Z' })
    @IsOptional() @IsDateString()
    to?: string;
}

// ── Shifts ──────────────────────────────────────────────────────
const SHIFT_SORT = ['startedAt', 'endedAt', 'totalVolume', 'totalAmount', 'totalTransactions'] as const;

export class QueryIntegrationShiftsDto extends IntegrationQueryDto {
    @ApiPropertyOptional({ description: 'Field to sort by', enum: SHIFT_SORT, default: 'startedAt' })
    @IsOptional() @IsIn(SHIFT_SORT as unknown as string[])
    sort: string = 'startedAt';

    @ApiPropertyOptional({ description: 'Filter by operator name (case-insensitive partial match)', example: 'Ivan' })
    @IsOptional() @IsString()
    operatorName?: string;

    @ApiPropertyOptional({ description: 'Filter by shift status', enum: ShiftStatus })
    @IsOptional() @IsEnum(ShiftStatus)
    status?: ShiftStatus;

    @ApiPropertyOptional({ description: 'Include shifts started on or after this ISO date-time', example: '2026-01-01T00:00:00.000Z' })
    @IsOptional() @IsDateString()
    from?: string;

    @ApiPropertyOptional({ description: 'Include shifts started on or before this ISO date-time', example: '2026-01-31T23:59:59.000Z' })
    @IsOptional() @IsDateString()
    to?: string;
}

// ── Prices ──────────────────────────────────────────────────────
const PRICE_SORT = ['updatedAt', 'price', 'productName'] as const;

export class QueryIntegrationPricesDto extends IntegrationQueryDto {
    @ApiPropertyOptional({ description: 'Field to sort by', enum: PRICE_SORT, default: 'updatedAt' })
    @IsOptional() @IsIn(PRICE_SORT as unknown as string[])
    sort: string = 'updatedAt';

    @ApiPropertyOptional({ description: 'Filter by product ID', example: 95 })
    @IsOptional() @Type(() => Number) @IsInt()
    productId?: number;

    @ApiPropertyOptional({ description: 'Filter by fuelling point (pump) ID', example: 'fp-1' })
    @IsOptional() @IsString()
    fpId?: string;
}

// ── Stations ────────────────────────────────────────────────────
const STATION_SORT = ['name', 'createdAt', 'lastSeenAt', 'lastSyncAt'] as const;

export class QueryIntegrationStationsDto extends IntegrationQueryDto {
    @ApiPropertyOptional({ description: 'Field to sort by', enum: STATION_SORT, default: 'name' })
    @IsOptional() @IsIn(STATION_SORT as unknown as string[])
    sort: string = 'name';

    @ApiPropertyOptional({ description: 'Filter by active state', example: true })
    @IsOptional()
    @Transform(({ value }) => value === true || value === 'true')
    @IsBoolean()
    active?: boolean;
}

// ── Tank (reservoir) readings ───────────────────────────────────
const READING_SORT = ['readingAt', 'volumeLitres', 'fillPercent', 'temperatureC'] as const;

export class QueryIntegrationReadingsDto extends IntegrationQueryDto {
    @ApiPropertyOptional({ description: 'Field to sort by', enum: READING_SORT, default: 'readingAt' })
    @IsOptional() @IsIn(READING_SORT as unknown as string[])
    sort: string = 'readingAt';

    @ApiPropertyOptional({ description: 'Filter by reservoir ID', example: 'reservoir-uuid' })
    @IsOptional() @IsString()
    reservoirId?: string;

    @ApiPropertyOptional({ description: 'Include readings taken on or after this ISO date-time', example: '2026-01-01T00:00:00.000Z' })
    @IsOptional() @IsDateString()
    from?: string;

    @ApiPropertyOptional({ description: 'Include readings taken on or before this ISO date-time', example: '2026-01-31T23:59:59.000Z' })
    @IsOptional() @IsDateString()
    to?: string;
}
