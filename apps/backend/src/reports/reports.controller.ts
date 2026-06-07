import { Controller, Get, Post, Query, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { IsOptional, IsString, IsEnum, IsDateString, IsArray } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ReportsService } from './reports.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

class ReportQueryDto {
    @ApiPropertyOptional()  @IsOptional() @IsDateString() from?: string;
    @ApiPropertyOptional()  @IsOptional() @IsDateString() to?: string;
    @ApiPropertyOptional()  @IsOptional() @IsString()     oilBaseId?: string;
    @ApiPropertyOptional()  @IsOptional() @IsString()     stationId?: string;
    @ApiPropertyOptional()  @IsOptional() @IsArray() @IsString({ each: true }) @Type(() => String) stationIds?: string[];
    @ApiPropertyOptional({ enum: ['day', 'week', 'month'] }) @IsOptional() @IsEnum(['day', 'week', 'month']) groupBy?: 'day' | 'week' | 'month';
}

@ApiTags('reports')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('reports')
export class ReportsController {
    constructor(
        private reports: ReportsService,
        private prisma: PrismaService,
    ) {}

    private async resolveIds(companyId: string, q: ReportQueryDto): Promise<string[]> {
        if (q.oilBaseId) {
            const rows = await this.prisma.station.findMany({
                where: { companyId, oilBaseId: q.oilBaseId, deletedAt: null },
                select: { id: true },
            });
            return rows.map(r => r.id);
        }
        return q.stationIds ?? (q.stationId ? [q.stationId] : []);
    }

    @Get('revenue')
    async revenue(@CurrentUser() user: any, @Query() q: ReportQueryDto) {
        const from = q.from ? new Date(q.from) : new Date(Date.now() - 30 * 86_400_000);
        const to   = q.to   ? new Date(q.to)   : new Date();
        const ids  = await this.resolveIds(user.companyId, q);
        return this.reports.getRevenueSummary(user.companyId, ids, from, to, q.groupBy ?? 'day');
    }

    @Get('operators')
    async operators(@CurrentUser() user: any, @Query() q: ReportQueryDto) {
        const from = q.from ? new Date(q.from) : new Date(Date.now() - 30 * 86_400_000);
        const to   = q.to   ? new Date(q.to)   : new Date();
        const ids  = await this.resolveIds(user.companyId, q);
        return this.reports.getOperatorReport(user.companyId, from, to, ids);
    }

    @Get('products')
    async products(@CurrentUser() user: any, @Query() q: ReportQueryDto) {
        const from = q.from ? new Date(q.from) : new Date(Date.now() - 30 * 86_400_000);
        const to   = q.to   ? new Date(q.to)   : new Date();
        const ids  = await this.resolveIds(user.companyId, q);
        return this.reports.getProductReport(user.companyId, from, to, ids);
    }

    @Post('export')
    requestExport(@CurrentUser() user: any, @Body() params: any) {
        return this.reports.requestExport(user.id, user.companyId, params);
    }
}
