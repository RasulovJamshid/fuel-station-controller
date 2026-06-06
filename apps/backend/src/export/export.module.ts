import { Module } from '@nestjs/common';
import { ExportService } from './export.service';
import { ExportController } from './export.controller';

@Module({
    providers: [ExportService],
    controllers: [ExportController],
    exports: [ExportService],
})
export class ExportModule {}
