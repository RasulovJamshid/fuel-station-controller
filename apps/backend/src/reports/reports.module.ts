import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ReportsService } from './reports.service';
import { ReportsController } from './reports.controller';
import { ReportsProcessor } from './reports.processor';
import { ExportModule } from '../export/export.module';
import { DashboardModule } from '../dashboard/dashboard.module';

@Module({
    imports: [
        BullModule.registerQueue({ name: 'reports' }),
        ExportModule,
        DashboardModule,
    ],
    providers: [ReportsService, ReportsProcessor],
    controllers: [ReportsController],
})
export class ReportsModule {}
