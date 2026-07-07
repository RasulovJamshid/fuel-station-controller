import { Controller, Get, Post, Body, Query, UseGuards, BadRequestException, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiOkResponse, ApiCreatedResponse, ApiBadRequestResponse, ApiUnauthorizedResponse, ApiForbiddenResponse, ApiProperty } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { IsString, IsNumber, Min } from 'class-validator';
import { PricesService } from './prices.service';
import { PaginationDto } from '../common/dto/pagination.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { resolveStationIds } from '../common/helpers/station-access.helper';

class SetPriceDto {
    @ApiProperty({ description: 'Target station identifier', example: 'stn_abc123' }) @IsString() stationId: string;
    @ApiProperty({ description: 'Fuelling point (dispenser) identifier', example: 'fp1' }) @IsString() fpId: string;
    @ApiProperty({ description: 'Nozzle index on the fuelling point', example: 1 }) @IsNumber() nozzleIndex: number;
    @ApiProperty({ description: 'Numeric product code', example: 92 }) @IsNumber() productId: number;
    @ApiProperty({ description: 'Human-readable product name', example: 'AI-92' }) @IsString() productName: string;
    @ApiProperty({ description: 'Price per litre (must be > 0)', example: 12500 }) @IsNumber() @Min(1) price: number;
}

@ApiTags('prices')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('prices')
export class PricesController {
    constructor(private prices: PricesService, private prisma: PrismaService) {}

    @Get()
    @ApiOperation({ summary: 'List current nozzle prices for accessible stations' })
    @ApiOkResponse({ description: 'Current price settings, ordered by station, fuelling point and nozzle' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    async current(@CurrentUser() user: any, @Query('stationId') stationId?: string) {
        const allowed = await resolveStationIds(this.prisma, user, stationId ? [stationId] : []);
        return this.prices.getCurrentPrices(user.companyId, stationId, allowed);
    }

    @Get('history')
    @ApiOperation({ summary: 'List paginated price change history' })
    @ApiOkResponse({ description: 'Paginated price change log entries, most recent first' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    async history(
        @CurrentUser() user: any,
        @Query() pagination: PaginationDto,
        @Query('stationId') stationId?: string,
    ) {
        const allowed = await resolveStationIds(this.prisma, user, stationId ? [stationId] : []);
        return this.prices.getPriceHistory(user.companyId, stationId, pagination, allowed);
    }

    /** Set a price for a specific nozzle on a station (downward sync: station will pick it up). */
    @Post()
    @ApiOperation({ summary: 'Set a nozzle price and record the change (synced down to the station)' })
    @ApiCreatedResponse({ description: 'Updated price setting' })
    @ApiBadRequestResponse({ description: 'Validation failed' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @ApiForbiddenResponse({ description: 'Insufficient role' })
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN, UserRole.STATION_MANAGER)
    async set(@CurrentUser() user: any, @Body() dto: SetPriceDto) {
        if (dto.price <= 0) throw new BadRequestException('price must be > 0');
        const allowed = await resolveStationIds(this.prisma, user, [dto.stationId]);
        if (allowed.length === 0) throw new ForbiddenException('Station is not accessible');
        return this.prices.setPrice(
            user.companyId,
            user.email ?? user.id,
            dto.stationId,
            dto.fpId,
            dto.nozzleIndex,
            dto.productId,
            dto.productName,
            dto.price,
        );
    }
}
