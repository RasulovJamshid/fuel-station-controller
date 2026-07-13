import { Module } from '@nestjs/common';
import { StationsService } from './stations.service';
import { StationsController } from './stations.controller';
import { NotificationsModule } from '../notifications/notifications.module';
import { PricesModule } from '../prices/prices.module';

@Module({
    imports: [NotificationsModule, PricesModule],
    providers: [StationsService],
    controllers: [StationsController],
    exports: [StationsService],
})
export class StationsModule {}
