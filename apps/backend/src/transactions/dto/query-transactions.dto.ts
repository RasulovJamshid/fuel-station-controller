import { IsOptional, IsString, IsEnum, IsDateString, IsArray } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { TxStatus } from '@prisma/client';

export class QueryTransactionsDto extends PaginationDto {
    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    oilBaseId?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    stationId?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    fpId?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    shiftId?: string;

    @ApiPropertyOptional({ enum: TxStatus, isArray: true })
    @IsOptional()
    @IsArray()
    @IsEnum(TxStatus, { each: true })
    @Type(() => String)
    status?: TxStatus[];

    @ApiPropertyOptional()
    @IsOptional()
    @IsDateString()
    from?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsDateString()
    to?: string;

    @ApiPropertyOptional()
    @IsOptional()
    @IsString()
    operatorName?: string;
}
