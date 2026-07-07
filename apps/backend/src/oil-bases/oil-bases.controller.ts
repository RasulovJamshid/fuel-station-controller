import {
    Controller, Get, Post, Put, Delete, Body, Param, UseGuards,
} from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiOkResponse, ApiCreatedResponse, ApiBadRequestResponse, ApiUnauthorizedResponse, ApiForbiddenResponse, ApiNotFoundResponse } from '@nestjs/swagger';
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
    @ApiOperation({ summary: 'List oil bases for the company with their stations' })
    @ApiOkResponse({ description: 'Oil bases, each including its non-deleted stations' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    findAll(@CurrentUser() user: any) {
        return this.svc.findAll(user.companyId);
    }

    @Get('summary')
    @ApiOperation({ summary: 'Get per-oil-base aggregated stats plus standalone stations' })
    @ApiOkResponse({ description: 'Oil bases with today\'s volume, transaction and active-shift counts, and standalone stations' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    summary(@CurrentUser() user: any) {
        return this.svc.getSummary(user.companyId);
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get a single oil base with its stations and reservoirs' })
    @ApiOkResponse({ description: 'The oil base, including stations and their reservoirs' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @ApiNotFoundResponse({ description: 'Oil base not found' })
    findOne(@Param('id') id: string, @CurrentUser() user: any) {
        return this.svc.findOne(id, user.companyId);
    }

    @Post()
    @ApiOperation({ summary: 'Create a new oil base for the company' })
    @ApiCreatedResponse({ description: 'The created oil base' })
    @ApiBadRequestResponse({ description: 'Validation failed' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @ApiForbiddenResponse({ description: 'Insufficient role' })
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    create(@CurrentUser() user: any, @Body() dto: CreateOilBaseDto) {
        return this.svc.create(user.companyId, dto);
    }

    @Put(':id')
    @ApiOperation({ summary: 'Update an existing oil base' })
    @ApiOkResponse({ description: 'The updated oil base' })
    @ApiBadRequestResponse({ description: 'Validation failed' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @ApiForbiddenResponse({ description: 'Insufficient role' })
    @ApiNotFoundResponse({ description: 'Oil base not found' })
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    update(@Param('id') id: string, @CurrentUser() user: any, @Body() dto: UpdateOilBaseDto) {
        return this.svc.update(id, user.companyId, dto);
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Soft-delete an oil base and detach its stations' })
    @ApiOkResponse({ description: 'The soft-deleted oil base' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @ApiForbiddenResponse({ description: 'Insufficient role' })
    @ApiNotFoundResponse({ description: 'Oil base not found' })
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    remove(@Param('id') id: string, @CurrentUser() user: any) {
        return this.svc.remove(id, user.companyId);
    }

    @Post(':id/stations/:stationId')
    @ApiOperation({ summary: 'Assign a station to an oil base' })
    @ApiCreatedResponse({ description: 'The station updated with its new oil base' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @ApiForbiddenResponse({ description: 'Insufficient role' })
    @ApiNotFoundResponse({ description: 'Oil base or station not found' })
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    assignStation(
        @Param('id') id: string,
        @Param('stationId') stationId: string,
        @CurrentUser() user: any,
    ) {
        return this.svc.assignStation(id, stationId, user.companyId);
    }

    @Delete(':id/stations/:stationId')
    @ApiOperation({ summary: 'Detach a station from its oil base' })
    @ApiOkResponse({ description: 'The station updated with no oil base' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @ApiForbiddenResponse({ description: 'Insufficient role' })
    @ApiNotFoundResponse({ description: 'Station not found' })
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    detachStation(@Param('stationId') stationId: string, @CurrentUser() user: any) {
        return this.svc.detachStation(stationId, user.companyId);
    }
}
