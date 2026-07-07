import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import {
    ApiTags, ApiSecurity, ApiOperation, ApiOkResponse,
    ApiUnauthorizedResponse, ApiForbiddenResponse, ApiNotFoundResponse,
} from '@nestjs/swagger';
import { IntegrationApiService } from './integration-api.service';
import { ApiTokenGuard } from '../common/guards/api-token.guard';
import { RequireScopes, API_SCOPES } from '../common/decorators/api-scopes.decorator';
import { CurrentToken, AuthenticatedToken } from '../common/decorators/current-token.decorator';
import {
    QueryIntegrationTransactionsDto,
    QueryIntegrationShiftsDto,
    QueryIntegrationPricesDto,
    QueryIntegrationStationsDto,
    QueryIntegrationReadingsDto,
} from './dto/integration-query.dto';

/**
 * Read-only, token-authenticated data API for external integrations.
 * Every endpoint is paginated, filterable, and sortable, and is scoped
 * to the presenting token's company + permitted stations. Authenticate
 * with the `X-Api-Token` header.
 */
@ApiTags('integration')
@ApiSecurity('integration-token')
@ApiUnauthorizedResponse({ description: 'Missing, invalid, or expired API token' })
@ApiForbiddenResponse({ description: 'Token lacks the required scope or source IP is not allowed' })
@UseGuards(ApiTokenGuard)
@Controller('integration')
export class IntegrationController {
    constructor(private readonly api: IntegrationApiService) {}

    // ── Transactions ────────────────────────────────────────────
    @Get('transactions')
    @RequireScopes(API_SCOPES.TRANSACTIONS)
    @ApiOperation({ summary: 'List fuel transactions (filterable, sortable, paginated)' })
    @ApiOkResponse({ description: 'Paginated list of transactions' })
    transactions(@CurrentToken() token: AuthenticatedToken, @Query() q: QueryIntegrationTransactionsDto) {
        return this.api.transactions(token, q);
    }

    @Get('transactions/:id')
    @RequireScopes(API_SCOPES.TRANSACTIONS)
    @ApiOperation({ summary: 'Get a single transaction by ID' })
    @ApiOkResponse({ description: 'The requested transaction' })
    @ApiNotFoundResponse({ description: 'Transaction not found or not within token scope' })
    transaction(@CurrentToken() token: AuthenticatedToken, @Param('id') id: string) {
        return this.api.transaction(token, id);
    }

    // ── Shifts ──────────────────────────────────────────────────
    @Get('shifts')
    @RequireScopes(API_SCOPES.SHIFTS)
    @ApiOperation({ summary: 'List shifts with per-position totals (filterable, sortable, paginated)' })
    @ApiOkResponse({ description: 'Paginated list of shifts' })
    shifts(@CurrentToken() token: AuthenticatedToken, @Query() q: QueryIntegrationShiftsDto) {
        return this.api.shifts(token, q);
    }

    @Get('shifts/:id')
    @RequireScopes(API_SCOPES.SHIFTS)
    @ApiOperation({ summary: 'Get a single shift by ID' })
    @ApiOkResponse({ description: 'The requested shift with position totals' })
    @ApiNotFoundResponse({ description: 'Shift not found or not within token scope' })
    shift(@CurrentToken() token: AuthenticatedToken, @Param('id') id: string) {
        return this.api.shift(token, id);
    }

    // ── Prices ──────────────────────────────────────────────────
    @Get('prices')
    @RequireScopes(API_SCOPES.PRICES)
    @ApiOperation({ summary: 'List current fuel price settings (filterable, sortable, paginated)' })
    @ApiOkResponse({ description: 'Paginated list of price settings' })
    prices(@CurrentToken() token: AuthenticatedToken, @Query() q: QueryIntegrationPricesDto) {
        return this.api.prices(token, q);
    }

    // ── Stations ────────────────────────────────────────────────
    @Get('stations')
    @RequireScopes(API_SCOPES.STATIONS)
    @ApiOperation({ summary: 'List stations visible to the token (filterable, sortable, paginated)' })
    @ApiOkResponse({ description: 'Paginated list of stations' })
    stations(@CurrentToken() token: AuthenticatedToken, @Query() q: QueryIntegrationStationsDto) {
        return this.api.stations(token, q);
    }

    @Get('stations/:id')
    @RequireScopes(API_SCOPES.STATIONS)
    @ApiOperation({ summary: 'Get a single station by ID' })
    @ApiOkResponse({ description: 'The requested station' })
    @ApiNotFoundResponse({ description: 'Station not found or not within token scope' })
    station(@CurrentToken() token: AuthenticatedToken, @Param('id') id: string) {
        return this.api.station(token, id);
    }

    // ── Tank readings ───────────────────────────────────────────
    @Get('tank-readings')
    @RequireScopes(API_SCOPES.TANK_READINGS)
    @ApiOperation({ summary: 'List reservoir/tank readings (filterable, sortable, paginated)' })
    @ApiOkResponse({ description: 'Paginated list of tank readings' })
    tankReadings(@CurrentToken() token: AuthenticatedToken, @Query() q: QueryIntegrationReadingsDto) {
        return this.api.tankReadings(token, q);
    }
}
