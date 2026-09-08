import { Controller, Post, Put, Get, Body, Param, UseGuards, Req, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiSecurity, ApiOperation, ApiOkResponse, ApiBadRequestResponse, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { Request } from 'express';
import { SyncService } from './sync.service';
import { SyncBatchDto } from './dto/sync-batch.dto';
import { StationApiKeyGuard } from '../common/guards/station-api-key.guard';
import { StationsService } from '../stations/stations.service';
import { SaveServiceConfigDto } from '../stations/dto/service-config.dto';

@ApiTags('sync')
@ApiSecurity('station-key')
@Controller('sync')
export class SyncController {
    constructor(private sync: SyncService, private stations: StationsService) {}

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

    @Put(':stationId/config')
    @ApiOperation({ summary: 'Back up the station service configuration to the dashboard' })
    @ApiOkResponse({ description: 'Configuration saved and versioned' })
    @UseGuards(StationApiKeyGuard)
    configUpload(
        @Param('stationId') stationId: string,
        @Body() dto: SaveServiceConfigDto,
        @Req() req: Request,
    ) {
        const station = (req as any).station;
        return this.stations.backupServiceConfig(stationId, station.companyId, dto.config);
    }

    @Get(':stationId/config')
    @ApiOperation({ summary: 'Download the current service configuration using station credentials' })
    @ApiOkResponse({ description: 'Current configuration with active sync credentials' })
    @UseGuards(StationApiKeyGuard)
    configDownload(@Param('stationId') stationId: string, @Req() req: Request) {
        const station = (req as any).station;
        return this.stations.getServiceConfig(stationId, station.companyId, requestOrigin(req));
    }
}

function requestOrigin(req: Request): string {
    const forwardedProto = req.headers['x-forwarded-proto'];
    const forwardedHost = req.headers['x-forwarded-host'];
    const protocol = (Array.isArray(forwardedProto) ? forwardedProto[0] : forwardedProto)?.split(',')[0]?.trim() || req.protocol;
    const host = (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost)?.split(',')[0]?.trim() || req.get('host') || 'localhost:4000';
    return `${protocol}://${host}`;
}
