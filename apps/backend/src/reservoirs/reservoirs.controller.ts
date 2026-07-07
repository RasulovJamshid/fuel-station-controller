import { Controller, Get, Post, Body, Query, UseGuards, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiOkResponse, ApiCreatedResponse, ApiBadRequestResponse, ApiUnauthorizedResponse, ApiForbiddenResponse } from '@nestjs/swagger';
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
    @ApiOperation({ summary: 'Create or update a reservoir (tank) for a station' })
    @ApiCreatedResponse({ description: 'The created or updated reservoir' })
    @ApiBadRequestResponse({ description: 'Validation failed' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @ApiForbiddenResponse({ description: 'Insufficient role' })
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN, UserRole.STATION_MANAGER)
    async create(@CurrentUser() user: any, @Body() dto: CreateReservoirDto) {
        const allowed = await resolveStationIds(this.prisma, user, [dto.stationId]);
        if (allowed.length === 0) throw new ForbiddenException('Station is not accessible');
        return this.reservoirs.create(dto);
    }

    @Get()
    @ApiOperation({ summary: 'List reservoirs for accessible stations with their latest reading' })
    @ApiOkResponse({ description: 'Reservoirs, each including its most recent reading' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    async findAll(@CurrentUser() user: any, @Query('stationId') stationId?: string) {
        const allowed = await resolveStationIds(this.prisma, user, stationId ? [stationId] : []);
        return this.reservoirs.findAll(user.companyId, stationId, allowed);
    }

    @Get('latest')
    @ApiOperation({ summary: 'Get the latest reading per active reservoir for accessible stations' })
    @ApiOkResponse({ description: 'Latest volume, fill percentage, level and temperature per reservoir' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    async latest(@CurrentUser() user: any, @Query('stationId') stationId?: string) {
        const allowed = await resolveStationIds(this.prisma, user, stationId ? [stationId] : []);
        return this.reservoirs.latestReadings(user.companyId, stationId, allowed);
    }
}
