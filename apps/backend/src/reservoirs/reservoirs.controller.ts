import { Controller, Get, Post, Body, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { ReservoirsService, CreateReservoirDto } from './reservoirs.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('reservoirs')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('reservoirs')
export class ReservoirsController {
    constructor(private reservoirs: ReservoirsService) {}

    @Post()
    create(@Body() dto: CreateReservoirDto) {
        return this.reservoirs.create(dto);
    }

    @Get()
    findAll(@CurrentUser() user: any, @Query('stationId') stationId?: string) {
        return this.reservoirs.findAll(user.companyId, stationId);
    }

    @Get('latest')
    latest(@CurrentUser() user: any, @Query('stationId') stationId?: string) {
        return this.reservoirs.latestReadings(user.companyId, stationId);
    }
}
