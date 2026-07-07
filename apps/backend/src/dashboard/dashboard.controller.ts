import { Controller, Get, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiOkResponse, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { DashboardService } from './dashboard.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { resolveStationIds } from '../common/helpers/station-access.helper';

@ApiTags('dashboard')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('dashboard')
export class DashboardController {
    constructor(private dashboard: DashboardService, private prisma: PrismaService) {}

    @Get('overview')
    @ApiOperation({ summary: 'Get dashboard overview with station, shift and today\'s transaction totals' })
    @ApiOkResponse({ description: 'Aggregated overview: station count, active shifts, today\'s transaction count and volume, plus per-station summaries' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    async overview(@CurrentUser() user: any) {
        const stationIds = await resolveStationIds(this.prisma, user);
        return this.dashboard.getOverview(user.companyId, stationIds);
    }
}
