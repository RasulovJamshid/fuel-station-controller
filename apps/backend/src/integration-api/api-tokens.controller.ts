import {
    Controller, Get, Post, Patch, Delete, Body, Param, UseGuards, HttpCode, HttpStatus,
} from '@nestjs/common';
import {
    ApiTags, ApiBearerAuth, ApiOperation, ApiCreatedResponse, ApiOkResponse,
    ApiNoContentResponse, ApiBadRequestResponse, ApiUnauthorizedResponse,
    ApiForbiddenResponse, ApiNotFoundResponse,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { ApiTokensService } from './api-tokens.service';
import { CreateApiTokenDto, UpdateApiTokenDto } from './dto/create-api-token.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

/**
 * Admin management of the integration API tokens external services use.
 * Company-scoped: an admin only sees and manages their own company's tokens.
 */
@ApiTags('api-tokens')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
@Controller('api-tokens')
export class ApiTokensController {
    constructor(private tokens: ApiTokensService) {}

    @Post()
    @ApiOperation({ summary: 'Create an integration API token (plaintext returned once)' })
    @ApiCreatedResponse({ description: 'Token created; the `token` field is shown only in this response' })
    @ApiBadRequestResponse({ description: 'Validation failed' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @ApiForbiddenResponse({ description: 'Insufficient role' })
    create(@CurrentUser() user: any, @Body() dto: CreateApiTokenDto) {
        return this.tokens.create(user.companyId, user.id, dto);
    }

    @Get()
    @ApiOperation({ summary: 'List the company\'s integration API tokens (without secrets)' })
    @ApiOkResponse({ description: 'List of token metadata' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @ApiForbiddenResponse({ description: 'Insufficient role' })
    list(@CurrentUser() user: any) {
        return this.tokens.list(user.companyId);
    }

    @Patch(':id')
    @ApiOperation({ summary: 'Update a token (scopes, rate limit, restrictions, or enable/disable)' })
    @ApiOkResponse({ description: 'Updated token metadata' })
    @ApiBadRequestResponse({ description: 'Validation failed or token is revoked' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @ApiForbiddenResponse({ description: 'Insufficient role' })
    @ApiNotFoundResponse({ description: 'Token not found' })
    update(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: UpdateApiTokenDto) {
        return this.tokens.update(user.companyId, id, dto);
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Revoke an integration API token' })
    @ApiNoContentResponse({ description: 'Token revoked' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @ApiForbiddenResponse({ description: 'Insufficient role' })
    @ApiNotFoundResponse({ description: 'Token not found' })
    @HttpCode(HttpStatus.NO_CONTENT)
    revoke(@CurrentUser() user: any, @Param('id') id: string) {
        return this.tokens.revoke(user.companyId, id);
    }
}
