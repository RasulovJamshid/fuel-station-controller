import {
    Controller, Get, Post, Put, Delete, Body, Param, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { OilBasesService, CreateOilBaseDto, UpdateOilBaseDto } from './oil-bases.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('oil-bases')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('oil-bases')
export class OilBasesController {
    constructor(private svc: OilBasesService) {}

    @Get()
    findAll(@CurrentUser() user: any) {
        return this.svc.findAll(user.companyId);
    }

    @Get('summary')
    summary(@CurrentUser() user: any) {
        return this.svc.getSummary(user.companyId);
    }

    @Get(':id')
    findOne(@Param('id') id: string, @CurrentUser() user: any) {
        return this.svc.findOne(id, user.companyId);
    }

    @Post()
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    create(@CurrentUser() user: any, @Body() dto: CreateOilBaseDto) {
        return this.svc.create(user.companyId, dto);
    }

    @Put(':id')
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    update(@Param('id') id: string, @CurrentUser() user: any, @Body() dto: UpdateOilBaseDto) {
        return this.svc.update(id, user.companyId, dto);
    }

    @Delete(':id')
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    remove(@Param('id') id: string, @CurrentUser() user: any) {
        return this.svc.remove(id, user.companyId);
    }

    @Post(':id/stations/:stationId')
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    assignStation(
        @Param('id') id: string,
        @Param('stationId') stationId: string,
        @CurrentUser() user: any,
    ) {
        return this.svc.assignStation(id, stationId, user.companyId);
    }

    @Delete(':id/stations/:stationId')
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    detachStation(@Param('stationId') stationId: string, @CurrentUser() user: any) {
        return this.svc.detachStation(stationId, user.companyId);
    }
}
