import { Controller, Get, Post, Put, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiOkResponse, ApiCreatedResponse, ApiBadRequestResponse, ApiUnauthorizedResponse, ApiForbiddenResponse, ApiNotFoundResponse } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { IntegrationsService } from './integrations.service';
import { CreateIntegrationDto, UpdateIntegrationDto } from './dto/integration.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('integrations')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('integrations')
export class IntegrationsController {
    constructor(private integrations: IntegrationsService) {}

    @Get()
    @ApiOperation({ summary: 'List all webhook integrations for the current company' })
    @ApiOkResponse({ description: 'Array of configured integrations ordered by newest first' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    findAll(@CurrentUser() user: any) {
        return this.integrations.findAll(user.companyId);
    }

    @Post()
    @ApiOperation({ summary: 'Create a new webhook integration' })
    @ApiCreatedResponse({ description: 'The created integration' })
    @ApiBadRequestResponse({ description: 'Validation failed' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @ApiForbiddenResponse({ description: 'Insufficient role' })
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    create(@CurrentUser() user: any, @Body() dto: CreateIntegrationDto) {
        return this.integrations.create(user.companyId, dto);
    }

    @Put(':id')
    @ApiOperation({ summary: 'Update an existing webhook integration' })
    @ApiOkResponse({ description: 'The updated integration' })
    @ApiBadRequestResponse({ description: 'Validation failed' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @ApiForbiddenResponse({ description: 'Insufficient role' })
    @ApiNotFoundResponse({ description: 'Integration not found' })
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    update(@Param('id') id: string, @CurrentUser() user: any, @Body() dto: UpdateIntegrationDto) {
        return this.integrations.update(id, user.companyId, dto);
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Delete a webhook integration' })
    @ApiOkResponse({ description: 'The deleted integration' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @ApiForbiddenResponse({ description: 'Insufficient role' })
    @ApiNotFoundResponse({ description: 'Integration not found' })
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    remove(@Param('id') id: string, @CurrentUser() user: any) {
        return this.integrations.remove(id, user.companyId);
    }

    @Post(':id/test')
    @ApiOperation({ summary: 'Send a test ping delivery to verify the integration endpoint' })
    @ApiCreatedResponse({ description: 'The resulting webhook delivery record with its attempt outcome' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @ApiForbiddenResponse({ description: 'Insufficient role' })
    @ApiNotFoundResponse({ description: 'Integration not found' })
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    test(@Param('id') id: string, @CurrentUser() user: any) {
        return this.integrations.test(id, user.companyId);
    }

    @Get(':id/deliveries')
    @ApiOperation({ summary: 'List the 100 most recent webhook delivery attempts for an integration' })
    @ApiOkResponse({ description: 'Array of recent webhook delivery records ordered by newest first' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    deliveries(@Param('id') id: string, @CurrentUser() user: any) {
        return this.integrations.deliveries(id, user.companyId);
    }
}
