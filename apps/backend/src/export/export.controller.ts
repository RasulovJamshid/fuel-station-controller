import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiProduces, ApiOkResponse, ApiUnauthorizedResponse } from '@nestjs/swagger';
import { Response } from 'express';
import { ExportService, ExportParams } from './export.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { resolveStationIds } from '../common/helpers/station-access.helper';
import * as fs from 'fs';

@ApiTags('export')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('export')
export class ExportController {
    constructor(private exportSvc: ExportService, private prisma: PrismaService) {}

    @Get()
    @ApiOperation({ summary: 'Export transactions or shifts as a downloadable CSV or XLSX file' })
    @ApiProduces('text/csv', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
    @ApiOkResponse({ description: 'File download stream' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    async download(
        @CurrentUser() user: any,
        @Query() params: ExportParams,
        @Res() res: Response,
    ) {
        const allowed = await resolveStationIds(this.prisma, user, params.stationId ? [params.stationId] : []);
        const result = await this.exportSvc.generate(user.companyId, params, allowed);
        res.download(result.path, result.filename, () => {
            fs.unlink(result.path, () => {});
        });
    }
}
