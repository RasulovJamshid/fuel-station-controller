import { Module } from '@nestjs/common';
import { MaintenanceService } from './maintenance.service';

@Module({
    providers: [MaintenanceService],
})
export class MaintenanceModule {}
