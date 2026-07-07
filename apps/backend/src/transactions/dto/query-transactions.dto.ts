import { IsOptional, IsString, IsEnum, IsDateString, IsArray } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { TxStatus } from '@prisma/client';

export class QueryTransactionsDto extends PaginationDto {
    @ApiPropertyOptional({ description: 'Filter by oil base; expands to all its stations', example: 'oilbase-uuid' })
    @IsOptional()
    @IsString()
    oilBaseId?: string;

    @ApiPropertyOptional({ description: 'Filter by a single station ID', example: 'station-uuid' })
    @IsOptional()
    @IsString()
    stationId?: string;

    @ApiPropertyOptional({ description: 'Filter by fuelling point (pump) ID', example: 'fp-1' })
    @IsOptional()
    @IsString()
    fpId?: string;

    @ApiPropertyOptional({ description: 'Filter by shift ID', example: 'shift-uuid' })
    @IsOptional()
    @IsString()
    shiftId?: string;

    @ApiPropertyOptional({ description: 'Filter by one or more transaction statuses', enum: TxStatus, isArray: true })
    @IsOptional()
    @IsArray()
    @IsEnum(TxStatus, { each: true })
    @Type(() => String)
    status?: TxStatus[];

    @ApiPropertyOptional({ description: 'Include transactions started on or after this ISO date-time', example: '2026-01-01T00:00:00.000Z' })
    @IsOptional()
    @IsDateString()
    from?: string;

    @ApiPropertyOptional({ description: 'Include transactions started on or before this ISO date-time', example: '2026-01-31T23:59:59.000Z' })
    @IsOptional()
    @IsDateString()
    to?: string;

    @ApiPropertyOptional({ description: 'Filter by operator name (case-insensitive partial match)', example: 'Ivan' })
    @IsOptional()
    @IsString()
    operatorName?: string;
}
