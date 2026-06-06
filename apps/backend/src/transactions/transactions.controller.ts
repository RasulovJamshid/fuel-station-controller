import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { TransactionsService } from './transactions.service';
import { QueryTransactionsDto } from './dto/query-transactions.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('transactions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('transactions')
export class TransactionsController {
    constructor(private tx: TransactionsService) {}

    @Get()
    findAll(@CurrentUser() user: any, @Query() q: QueryTransactionsDto) {
        return this.tx.findAll(user.companyId, q);
    }

    @Get('summary')
    summarize(@CurrentUser() user: any, @Query() q: QueryTransactionsDto) {
        return this.tx.summarize(user.companyId, q);
    }

    @Get(':id')
    findOne(@Param('id') id: string, @CurrentUser() user: any) {
        return this.tx.findOne(id, user.companyId);
    }
}
