import { Module } from '@nestjs/common';
import { IntegrationController } from './integration.controller';
import { IntegrationApiService } from './integration-api.service';
import { ApiTokensController } from './api-tokens.controller';
import { ApiTokensService } from './api-tokens.service';
import { ApiTokenGuard } from '../common/guards/api-token.guard';

@Module({
    controllers: [IntegrationController, ApiTokensController],
    providers:   [IntegrationApiService, ApiTokensService, ApiTokenGuard],
})
export class IntegrationApiModule {}
