import { Controller, Post, Get, Body, Param, UseGuards, Req, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiSecurity, ApiOperation, ApiOkResponse, ApiBadRequestResponse, ApiUnauthorizedResponse } from '@nestjs/swagger';
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
    @ApiOperation({ summary: 'Ingest a batch of offline sync records from a station' })
    @ApiOkResponse({ description: 'Batch processed; returns accepted and rejected record IDs' })
    @ApiBadRequestResponse({ description: 'Validation failed' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid station API key' })
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
    @ApiOperation({ summary: 'Get current server-side price settings for a station (downward price sync)' })
    @ApiOkResponse({ description: 'Current price settings for the station' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid station API key' })
    @UseGuards(StationApiKeyGuard)
    prices(@Param('stationId') stationId: string) {
        return this.sync.getCurrentPricesForStation(stationId);
    }
}
