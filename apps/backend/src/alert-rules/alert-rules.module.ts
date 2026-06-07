import { Module } from '@nestjs/common';
import { AlertRulesService } from './alert-rules.service';
import { AlertRulesController } from './alert-rules.controller';

@Module({
    providers: [AlertRulesService],
    controllers: [AlertRulesController],
})
export class AlertRulesModule {}
