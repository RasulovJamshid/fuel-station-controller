import {
    Controller, Get, Post, Put, Delete, Patch, Body, Param, Query, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { StationsService } from './stations.service';
import { CreateStationDto, UpdateStationDto } from './dto/create-station.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('stations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('stations')
export class StationsController {
    constructor(private stations: StationsService) {}

    @Post()
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    create(@Body() dto: CreateStationDto) {
        return this.stations.create(dto);
    }

    @Get()
    findAll(@CurrentUser() user: any) {
        return this.stations.findAll(user.companyId);
    }

    @Get(':id')
    findOne(@Param('id') id: string, @CurrentUser() user: any) {
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
    detail(@Param('id') id: string, @CurrentUser() user: any) {
        return this.stations.getDetail(id, user.companyId);
    }

    @Get(':id/uptime')
    uptimeHistory(
        @Param('id') id: string,
        @Query('days') days: number,
        @CurrentUser() user: any,
    ) {
        return this.stations.getUptimeHistory(id, user.companyId, days ?? 7);
    }
}
