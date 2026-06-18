import {
    Controller, Get, Post, Put, Delete, Patch, Body, Param, Query, UseGuards, ForbiddenException,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { StationsService } from './stations.service';
import { CreateStationDto, UpdateStationDto } from './dto/create-station.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { resolveStationIds } from '../common/helpers/station-access.helper';

@ApiTags('stations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('stations')
export class StationsController {
    constructor(private stations: StationsService, private prisma: PrismaService) {}

    @Post()
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    create(@Body() dto: CreateStationDto) {
        return this.stations.create(dto);
    }

    @Get()
    async findAll(@CurrentUser() user: any) {
        return this.stations.findAll(user.companyId, await resolveStationIds(this.prisma, user));
    }

    @Get(':id')
    async findOne(@Param('id') id: string, @CurrentUser() user: any) {
        const allowed = await resolveStationIds(this.prisma, user, [id]);
        if (allowed.length === 0) throw new ForbiddenException('Station is not accessible');
        return this.stations.findOne(id, user.companyId);
    }

    @Put(':id')
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    update(@Param('id') id: string, @Body() dto: UpdateStationDto, @CurrentUser() user: any) {
        return this.stations.update(id, user.companyId, dto);
    }

    @Delete(':id')
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    remove(@Param('id') id: string, @CurrentUser() user: any) {
        return this.stations.remove(id, user.companyId);
    }

    @Post(':id/rotate-key')
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    rotateKey(@Param('id') id: string, @CurrentUser() user: any) {
        return this.stations.rotateApiKey(id, user.companyId);
    }

    @Get(':id/detail')
    async detail(@Param('id') id: string, @CurrentUser() user: any) {
        const allowed = await resolveStationIds(this.prisma, user, [id]);
        if (allowed.length === 0) throw new ForbiddenException('Station is not accessible');
        return this.stations.getDetail(id, user.companyId);
    }

    @Get(':id/uptime')
    async uptimeHistory(
        @Param('id') id: string,
        @Query('days') days: number,
        @CurrentUser() user: any,
    ) {
        const allowed = await resolveStationIds(this.prisma, user, [id]);
        if (allowed.length === 0) throw new ForbiddenException('Station is not accessible');
        return this.stations.getUptimeHistory(id, user.companyId, days ?? 7);
    }
}
