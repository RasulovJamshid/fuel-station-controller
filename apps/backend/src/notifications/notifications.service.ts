import { Injectable, Logger } from '@nestjs/common';
import { TelegramService } from './telegram.service';

export interface AlertPayload {
    type:      string;
    stationId?: string;
    message:   string;
    chatIds?:  string[];
}

@Injectable()
export class NotificationsService {
    private readonly logger = new Logger(NotificationsService.name);

    constructor(private telegram: TelegramService) {}

    async sendAlert(payload: AlertPayload) {
        this.logger.log(`Alert [${payload.type}]: ${payload.message}`);
        await this.telegram.send(payload.message, payload.chatIds);
    }
}
