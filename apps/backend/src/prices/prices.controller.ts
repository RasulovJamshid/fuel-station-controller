import { Controller, Get, Post, Body, Query, UseGuards, BadRequestException } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { IsString, IsNumber, Min } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { PricesService } from './prices.service';
import { PaginationDto } from '../common/dto/pagination.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

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
@UseGuards(JwtAuthGuard)
@Controller('prices')
export class PricesController {
    constructor(private prices: PricesService) {}

    @Get()
    current(@CurrentUser() user: any, @Query('stationId') stationId?: string) {
        return this.prices.getCurrentPrices(user.companyId, stationId);
    }

    @Get('history')
    history(
        @CurrentUser() user: any,
        @Query() pagination: PaginationDto,
        @Query('stationId') stationId?: string,
    ) {
        return this.prices.getPriceHistory(user.companyId, stationId, pagination);
    }

    /** Set a price for a specific nozzle on a station (downward sync: station will pick it up). */
    @Post()
    set(@CurrentUser() user: any, @Body() dto: SetPriceDto) {
        if (dto.price <= 0) throw new BadRequestException('price must be > 0');
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
