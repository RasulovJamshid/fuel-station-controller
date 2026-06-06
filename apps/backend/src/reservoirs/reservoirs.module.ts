import { Module } from '@nestjs/common';
import { ReservoirsService } from './reservoirs.service';
import { ReservoirsController } from './reservoirs.controller';

@Module({
    providers: [ReservoirsService],
    controllers: [ReservoirsController],
    exports: [ReservoirsService],
})
export class ReservoirsModule {}
