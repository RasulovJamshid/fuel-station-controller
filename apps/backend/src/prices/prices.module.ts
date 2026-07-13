import { Module } from '@nestjs/common';
import { PricesService } from './prices.service';
import { PricesController } from './prices.controller';
import { ProductsModule } from '../products/products.module';

@Module({
    imports: [ProductsModule],
    providers: [PricesService],
    controllers: [PricesController],
    exports: [PricesService],
})
export class PricesModule {}
