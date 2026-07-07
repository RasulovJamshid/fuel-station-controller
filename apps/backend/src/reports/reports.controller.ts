import { Controller, Get, Post, Query, Body, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiOkResponse, ApiCreatedResponse, ApiUnauthorizedResponse, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsEnum, IsDateString, IsArray } from 'class-validator';
import { Type } from 'class-transformer';
import { ReportsService } from './reports.service';
import { PrismaService } from '../prisma/prisma.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { resolveStationIds } from '../common/helpers/station-access.helper';

class ReportQueryDto {
    @ApiPropertyOptional({ description: 'Range start (ISO date-time); defaults to 30 days ago', example: '2026-01-01T00:00:00.000Z' })  @IsOptional() @IsDateString() from?: string;
    @ApiPropertyOptional({ description: 'Range end (ISO date-time); defaults to now', example: '2026-01-31T23:59:59.000Z' })  @IsOptional() @IsDateString() to?: string;
    @ApiPropertyOptional({ description: 'Filter by oil base; expands to all its stations', example: 'oilbase-uuid' })  @IsOptional() @IsString()     oilBaseId?: string;
    @ApiPropertyOptional({ description: 'Filter by a single station ID', example: 'station-uuid' })  @IsOptional() @IsString()     stationId?: string;
    @ApiPropertyOptional({ description: 'Filter by multiple station IDs', type: [String], example: ['station-a', 'station-b'] })  @IsOptional() @IsArray() @IsString({ each: true }) @Type(() => String) stationIds?: string[];
    @ApiPropertyOptional({ description: 'Time bucket granularity for grouping', enum: ['day', 'week', 'month'], example: 'day' }) @IsOptional() @IsEnum(['day', 'week', 'month']) groupBy?: 'day' | 'week' | 'month';
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

    private async resolveIds(user: any, q: ReportQueryDto): Promise<string[]> {
        if (q.oilBaseId) {
            const rows = await this.prisma.station.findMany({
                where: { companyId: user.companyId, oilBaseId: q.oilBaseId, deletedAt: null },
                select: { id: true },
            });
            return resolveStationIds(this.prisma, user, rows.map(r => r.id));
        }
        return resolveStationIds(this.prisma, user, q.stationIds ?? (q.stationId ? [q.stationId] : []));
    }

    @Get('revenue')
    @ApiOperation({ summary: 'Get revenue summary bucketed by day/week/month, station and product' })
    @ApiOkResponse({ description: 'Revenue rows grouped by period, station and product' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    async revenue(@CurrentUser() user: any, @Query() q: ReportQueryDto) {
        const from = q.from ? new Date(q.from) : new Date(Date.now() - 30 * 86_400_000);
        const to   = q.to   ? new Date(q.to)   : new Date();
        const ids  = await this.resolveIds(user, q);
        return this.reports.getRevenueSummary(user.companyId, ids, from, to, q.groupBy ?? 'day');
    }

    @Get('operators')
    @ApiOperation({ summary: 'Get per-operator transaction totals over the given range' })
    @ApiOkResponse({ description: 'Aggregated totals grouped by operator and station' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    async operators(@CurrentUser() user: any, @Query() q: ReportQueryDto) {
        const from = q.from ? new Date(q.from) : new Date(Date.now() - 30 * 86_400_000);
        const to   = q.to   ? new Date(q.to)   : new Date();
        const ids  = await this.resolveIds(user, q);
        return this.reports.getOperatorReport(user.companyId, from, to, ids);
    }

    @Get('products')
    @ApiOperation({ summary: 'Get per-product transaction totals over the given range' })
    @ApiOkResponse({ description: 'Aggregated totals grouped by product' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    async products(@CurrentUser() user: any, @Query() q: ReportQueryDto) {
        const from = q.from ? new Date(q.from) : new Date(Date.now() - 30 * 86_400_000);
        const to   = q.to   ? new Date(q.to)   : new Date();
        const ids  = await this.resolveIds(user, q);
        return this.reports.getProductReport(user.companyId, from, to, ids);
    }

    @Post('export')
    @ApiOperation({ summary: 'Queue a background report export job and return its job ID' })
    @ApiCreatedResponse({ description: 'Export job queued; returns the job ID' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    async requestExport(@CurrentUser() user: any, @Body() params: any) {
        const requested = params.stationIds ?? (params.stationId ? [params.stationId] : []);
        const allowed = await resolveStationIds(this.prisma, user, requested);
        return this.reports.requestExport(user.id, user.companyId, params, allowed);
    }
}
