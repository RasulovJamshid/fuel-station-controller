import { Module } from '@nestjs/common';
import { OilBasesService } from './oil-bases.service';
import { OilBasesController } from './oil-bases.controller';

@Module({
    providers: [OilBasesService],
    controllers: [OilBasesController],
    exports: [OilBasesService],
})
export class OilBasesModule {}
