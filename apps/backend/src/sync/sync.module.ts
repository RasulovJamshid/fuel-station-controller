import { Module } from '@nestjs/common';
import { SyncService } from './sync.service';
import { SyncController } from './sync.controller';
import { StationApiKeyGuard } from '../common/guards/station-api-key.guard';
import { DashboardModule } from '../dashboard/dashboard.module';
import { IntegrationsModule } from '../integrations/integrations.module';
import { ProductsModule } from '../products/products.module';
import { StationsModule } from '../stations/stations.module';

@Module({
    imports: [DashboardModule, IntegrationsModule, ProductsModule, StationsModule],
    providers: [SyncService, StationApiKeyGuard],
    controllers: [SyncController],
})
export class SyncModule {}
