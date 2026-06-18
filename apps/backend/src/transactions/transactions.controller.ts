import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { TransactionsService } from './transactions.service';
import { QueryTransactionsDto } from './dto/query-transactions.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { resolveStationIds } from '../common/helpers/station-access.helper';

@ApiTags('transactions')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard)
@Controller('transactions')
export class TransactionsController {
    constructor(private tx: TransactionsService, private prisma: PrismaService) {}

    private allowedStations(user: any, q?: QueryTransactionsDto) {
        return resolveStationIds(this.prisma, user, q?.stationId ? [q.stationId] : []);
    }

    @Get()
    async findAll(@CurrentUser() user: any, @Query() q: QueryTransactionsDto) {
        return this.tx.findAll(user.companyId, q, await this.allowedStations(user, q));
    }

    @Get('summary')
    async summarize(@CurrentUser() user: any, @Query() q: QueryTransactionsDto) {
        return this.tx.summarize(user.companyId, q, await this.allowedStations(user, q));
    }

    @Get(':id')
    async findOne(@Param('id') id: string, @CurrentUser() user: any) {
        return this.tx.findOne(id, user.companyId, await this.allowedStations(user));
    }
}
