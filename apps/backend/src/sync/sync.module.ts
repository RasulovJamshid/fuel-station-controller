import { Module } from '@nestjs/common';
import { SyncService } from './sync.service';
import { SyncController } from './sync.controller';
import { StationApiKeyGuard } from '../common/guards/station-api-key.guard';
import { DashboardModule } from '../dashboard/dashboard.module';

@Module({
    imports: [DashboardModule],
    providers: [SyncService, StationApiKeyGuard],
    controllers: [SyncController],
})
export class SyncModule {}
