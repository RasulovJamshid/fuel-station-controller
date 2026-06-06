import {
    Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { UsersService } from './users.service';
import { CreateUserDto, UpdateUserDto, UpdatePreferencesDto } from './dto/create-user.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('users')
export class UsersController {
    constructor(private users: UsersService) {}

    @Post()
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    create(@Body() dto: CreateUserDto, @CurrentUser() actor: any) {
        return this.users.create(dto, actor.id, actor.companyId);
    }

    @Get()
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    findAll(@CurrentUser() user: any, @Query() pagination: PaginationDto) {
        return this.users.findAll(user.companyId, pagination);
    }

    @Get(':id')
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    findOne(@Param('id') id: string, @CurrentUser() user: any) {
        return this.users.findOne(id, user.companyId);
    }

    @Put(':id')
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    update(@Param('id') id: string, @Body() dto: UpdateUserDto, @CurrentUser() actor: any) {
        return this.users.update(id, actor.companyId, dto, actor.id);
    }

    @Delete(':id')
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    remove(@Param('id') id: string, @CurrentUser() actor: any) {
        return this.users.remove(id, actor.companyId, actor.id);
    }

    @Put('preferences')
    updatePreferences(@CurrentUser() user: any, @Body() dto: UpdatePreferencesDto) {
        return this.users.updatePreferences(user.id, dto);
    }

    @Post(':id/station-access/:stationId')
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    grantAccess(@Param('id') id: string, @Param('stationId') stationId: string, @CurrentUser() actor: any) {
        return this.users.grantStationAccess(id, stationId, actor.companyId);
    }

    @Delete(':id/station-access/:stationId')
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    revokeAccess(@Param('id') id: string, @Param('stationId') stationId: string, @CurrentUser() actor: any) {
        return this.users.revokeStationAccess(id, stationId, actor.companyId);
    }
}
