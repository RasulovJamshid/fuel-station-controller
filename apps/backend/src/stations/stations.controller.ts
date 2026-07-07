import {
    Controller, Get, Post, Put, Delete, Patch, Body, Param, Query, UseGuards, ForbiddenException,
} from '@nestjs/common';
import {
    ApiTags, ApiBearerAuth, ApiOperation, ApiOkResponse, ApiCreatedResponse,
    ApiBadRequestResponse, ApiUnauthorizedResponse, ApiForbiddenResponse,
    ApiNotFoundResponse, ApiConflictResponse,
} from '@nestjs/swagger';
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
    @ApiOperation({ summary: 'Create a station' })
    @ApiCreatedResponse({ description: 'Station created' })
    @ApiBadRequestResponse({ description: 'Validation failed' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @ApiForbiddenResponse({ description: 'Insufficient role' })
    @ApiConflictResponse({ description: 'Station with this ID already exists' })
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    create(@Body() dto: CreateStationDto) {
        return this.stations.create(dto);
    }

    @Get()
    @ApiOperation({ summary: 'List stations accessible to the caller' })
    @ApiOkResponse({ description: 'List of stations' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    async findAll(@CurrentUser() user: any) {
        return this.stations.findAll(user.companyId, await resolveStationIds(this.prisma, user));
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get a station by ID' })
    @ApiOkResponse({ description: 'Station found' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @ApiForbiddenResponse({ description: 'Station is not accessible' })
    @ApiNotFoundResponse({ description: 'Station not found' })
    async findOne(@Param('id') id: string, @CurrentUser() user: any) {
        const allowed = await resolveStationIds(this.prisma, user, [id]);
        if (allowed.length === 0) throw new ForbiddenException('Station is not accessible');
        return this.stations.findOne(id, user.companyId);
    }

    @Put(':id')
    @ApiOperation({ summary: 'Update a station' })
    @ApiOkResponse({ description: 'Station updated' })
    @ApiBadRequestResponse({ description: 'Validation failed' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @ApiForbiddenResponse({ description: 'Insufficient role' })
    @ApiNotFoundResponse({ description: 'Station not found' })
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    update(@Param('id') id: string, @Body() dto: UpdateStationDto, @CurrentUser() user: any) {
        return this.stations.update(id, user.companyId, dto);
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Soft-delete a station' })
    @ApiOkResponse({ description: 'Station deleted' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @ApiForbiddenResponse({ description: 'Insufficient role' })
    @ApiNotFoundResponse({ description: 'Station not found' })
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    remove(@Param('id') id: string, @CurrentUser() user: any) {
        return this.stations.remove(id, user.companyId);
    }

    @Post(':id/rotate-key')
    @ApiOperation({ summary: 'Rotate the station API key' })
    @ApiCreatedResponse({ description: 'Returns the newly generated API key' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @ApiForbiddenResponse({ description: 'Insufficient role' })
    @ApiNotFoundResponse({ description: 'Station not found' })
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    rotateKey(@Param('id') id: string, @CurrentUser() user: any) {
        return this.stations.rotateApiKey(id, user.companyId);
    }

    @Get(':id/detail')
    @ApiOperation({ summary: 'Get station detail with recent transactions, prices, active shift, health events, and tanks' })
    @ApiOkResponse({ description: 'Station detail dashboard payload' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @ApiForbiddenResponse({ description: 'Station is not accessible' })
    @ApiNotFoundResponse({ description: 'Station not found' })
    async detail(@Param('id') id: string, @CurrentUser() user: any) {
        const allowed = await resolveStationIds(this.prisma, user, [id]);
        if (allowed.length === 0) throw new ForbiddenException('Station is not accessible');
        return this.stations.getDetail(id, user.companyId);
    }

    @Get(':id/uptime')
    @ApiOperation({ summary: 'Get station uptime event history' })
    @ApiOkResponse({ description: 'List of uptime events for the requested window' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @ApiForbiddenResponse({ description: 'Station is not accessible' })
    @ApiNotFoundResponse({ description: 'Station not found' })
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
