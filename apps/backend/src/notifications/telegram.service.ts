import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Telegraf } from 'telegraf';

@Injectable()
export class TelegramService implements OnModuleInit {
    private readonly logger = new Logger(TelegramService.name);
    private bot: Telegraf | null = null;

    constructor(private config: ConfigService) {}

    onModuleInit() {
        const token = this.config.get<string>('TELEGRAM_BOT_TOKEN');
        if (token) {
            this.bot = new Telegraf(token);
            this.logger.log('Telegram bot initialized');
        }
    }

    async send(message: string, chatIds?: string[]) {
        if (!this.bot) return;

        const ids = chatIds?.length
            ? chatIds
            : (this.config.get<string>('TELEGRAM_CHAT_IDS') ?? '').split(',').filter(Boolean);

        for (const chatId of ids) {
            await this.bot.telegram
                .sendMessage(chatId.trim(), message, { parse_mode: 'HTML' })
                .catch(e => this.logger.error(`Telegram send failed: ${e.message}`));
        }
    }
}
