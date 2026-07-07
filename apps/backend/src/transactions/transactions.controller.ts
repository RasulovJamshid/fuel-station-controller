import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiOkResponse, ApiUnauthorizedResponse, ApiNotFoundResponse } from '@nestjs/swagger';
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
    @ApiOperation({ summary: 'List transactions matching the given filters (paginated)' })
    @ApiOkResponse({ description: 'Paginated list of transactions' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    async findAll(@CurrentUser() user: any, @Query() q: QueryTransactionsDto) {
        return this.tx.findAll(user.companyId, q, await this.allowedStations(user, q));
    }

    @Get('summary')
    @ApiOperation({ summary: 'Get aggregate transaction count and total volume for the given filters' })
    @ApiOkResponse({ description: 'Transaction count and summed volume' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    async summarize(@CurrentUser() user: any, @Query() q: QueryTransactionsDto) {
        return this.tx.summarize(user.companyId, q, await this.allowedStations(user, q));
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get a single transaction by ID' })
    @ApiOkResponse({ description: 'The requested transaction' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @ApiNotFoundResponse({ description: 'Transaction not found' })
    async findOne(@Param('id') id: string, @CurrentUser() user: any) {
        return this.tx.findOne(id, user.companyId, await this.allowedStations(user));
    }
}
