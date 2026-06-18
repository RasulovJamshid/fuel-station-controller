import { Controller, Get, Post, Body, Query, UseGuards, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { ReservoirsService, CreateReservoirDto } from './reservoirs.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { resolveStationIds } from '../common/helpers/station-access.helper';

@ApiTags('reservoirs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('reservoirs')
export class ReservoirsController {
    constructor(private reservoirs: ReservoirsService, private prisma: PrismaService) {}

    @Post()
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN, UserRole.STATION_MANAGER)
    async create(@CurrentUser() user: any, @Body() dto: CreateReservoirDto) {
        const allowed = await resolveStationIds(this.prisma, user, [dto.stationId]);
        if (allowed.length === 0) throw new ForbiddenException('Station is not accessible');
        return this.reservoirs.create(dto);
    }

    @Get()
    async findAll(@CurrentUser() user: any, @Query('stationId') stationId?: string) {
        const allowed = await resolveStationIds(this.prisma, user, stationId ? [stationId] : []);
        return this.reservoirs.findAll(user.companyId, stationId, allowed);
    }

    @Get('latest')
    async latest(@CurrentUser() user: any, @Query('stationId') stationId?: string) {
        const allowed = await resolveStationIds(this.prisma, user, stationId ? [stationId] : []);
        return this.reservoirs.latestReadings(user.companyId, stationId, allowed);
    }
}
