import { Controller, Get, Query, Res, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { Response } from 'express';
import { ExportService, ExportParams } from './export.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import * as fs from 'fs';

@ApiTags('export')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('export')
export class ExportController {
    constructor(private exportSvc: ExportService) {}

    @Get()
    async download(
        @CurrentUser() user: any,
        @Query() params: ExportParams,
        @Res() res: Response,
    ) {
        const result = await this.exportSvc.generate(user.companyId, params);
        res.download(result.path, result.filename, () => {
            fs.unlink(result.path, () => {});
        });
    }
}
