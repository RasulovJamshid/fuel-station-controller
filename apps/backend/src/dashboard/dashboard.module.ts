import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { DashboardGateway } from './dashboard.gateway';
import { DashboardService } from './dashboard.service';
import { DashboardController } from './dashboard.controller';

@Module({
    imports: [JwtModule.register({})],
    providers: [DashboardGateway, DashboardService],
    controllers: [DashboardController],
    exports: [DashboardGateway],
})
export class DashboardModule {}
