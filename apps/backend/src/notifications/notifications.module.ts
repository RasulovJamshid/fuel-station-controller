import { Module } from '@nestjs/common';
import { TelegramService } from './telegram.service';
import { NotificationsService } from './notifications.service';
import { AlertsService } from './alerts.service';

@Module({
    providers: [TelegramService, NotificationsService, AlertsService],
    exports: [NotificationsService],
})
export class NotificationsModule {}
