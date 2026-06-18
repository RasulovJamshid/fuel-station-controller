import { Controller, Get, Post, Body, Query, UseGuards, BadRequestException, ForbiddenException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { IsString, IsNumber, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PricesService } from './prices.service';
import { PaginationDto } from '../common/dto/pagination.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { resolveStationIds } from '../common/helpers/station-access.helper';

class SetPriceDto {
    @ApiProperty() @IsString() stationId: string;
    @ApiProperty() @IsString() fpId: string;
    @ApiProperty() @IsNumber() nozzleIndex: number;
    @ApiProperty() @IsNumber() productId: number;
    @ApiProperty() @IsString() productName: string;
    @ApiProperty() @IsNumber() @Min(1) price: number;
}

@ApiTags('prices')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('prices')
export class PricesController {
    constructor(private prices: PricesService, private prisma: PrismaService) {}

    @Get()
    async current(@CurrentUser() user: any, @Query('stationId') stationId?: string) {
        const allowed = await resolveStationIds(this.prisma, user, stationId ? [stationId] : []);
        return this.prices.getCurrentPrices(user.companyId, stationId, allowed);
    }

    @Get('history')
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
