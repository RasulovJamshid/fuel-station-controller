import { Controller, Post, Get, Body, Param, UseGuards, Req, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiSecurity } from '@nestjs/swagger';
import { Request } from 'express';
import { SyncService } from './sync.service';
import { SyncBatchDto } from './dto/sync-batch.dto';
import { StationApiKeyGuard } from '../common/guards/station-api-key.guard';

@ApiTags('sync')
@ApiSecurity('station-key')
@Controller('sync')
export class SyncController {
    constructor(private sync: SyncService) {}

    @Post(':stationId')
    @UseGuards(StationApiKeyGuard)
    @HttpCode(HttpStatus.OK)
    batch(
        @Param('stationId') stationId: string,
        @Body() dto: SyncBatchDto,
        @Req() req: Request,
    ) {
        const station = (req as any).station;
        return this.sync.processBatch(
            stationId,
            station.companyId,
            dto,
            req.ip ?? '',
        );
    }

    /** Station polls this to get server-side price settings (for downward price sync). */
    @Get(':stationId/prices')
    @UseGuards(StationApiKeyGuard)
    prices(@Param('stationId') stationId: string) {
        return this.sync.getCurrentPricesForStation(stationId);
    }
}
