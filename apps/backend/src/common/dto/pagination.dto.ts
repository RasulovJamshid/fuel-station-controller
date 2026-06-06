import { IsOptional, IsInt, Min, Max } from 'class-validator';
import { Type } from 'class-transformer';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class PaginationDto {
    @ApiPropertyOptional({ default: 1 })
    @IsOptional()
    @IsInt()
    @Min(1)
    @Type(() => Number)
    page?: number = 1;

    @ApiPropertyOptional({ default: 50 })
    @IsOptional()
    @IsInt()
    @Min(1)
    @Max(100)
    @Type(() => Number)
    limit?: number = 50;

    get skip(): number {
        return ((this.page ?? 1) - 1) * (this.limit ?? 50);
    }
}

export class PaginatedResponse<T> {
    data:  T[];
    total: number;
    page:  number;
    limit: number;
    pages: number;

    static of<T>(data: T[], total: number, dto: PaginationDto): PaginatedResponse<T> {
        const r  = new PaginatedResponse<T>();
        r.data   = data;
        r.total  = total;
        r.page   = dto.page ?? 1;
        r.limit  = dto.limit ?? 50;
        r.pages  = Math.ceil(total / (dto.limit ?? 50));
        return r;
    }
}
