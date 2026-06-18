import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ShiftsService } from './shifts.service';
import { PaginationDto } from '../common/dto/pagination.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { resolveStationIds } from '../common/helpers/station-access.helper';

@ApiTags('shifts')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('shifts')
export class ShiftsController {
    constructor(private shifts: ShiftsService, private prisma: PrismaService) {}

    @Get()
    async findAll(
        @CurrentUser() user: any,
        @Query() pagination: PaginationDto,
        @Query('stationId') stationId?: string,
        @Query('oilBaseId') oilBaseId?: string,
    ) {
        const allowed = await resolveStationIds(this.prisma, user, stationId ? [stationId] : []);
        return this.shifts.findAll(user.companyId, stationId, pagination, oilBaseId, allowed);
    }

    @Get('active')
    async getActive(
        @CurrentUser() user: any,
        @Query('stationId') stationId?: string,
        @Query('oilBaseId') oilBaseId?: string,
    ) {
        const allowed = await resolveStationIds(this.prisma, user, stationId ? [stationId] : []);
        return this.shifts.getActive(user.companyId, stationId, oilBaseId, allowed);
    }

    @Get(':id')
    async findOne(@Param('id') id: string, @CurrentUser() user: any) {
        return this.shifts.findOne(id, user.companyId, await resolveStationIds(this.prisma, user));
    }
}
