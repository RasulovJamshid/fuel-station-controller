import { Controller, Get, Post, Put, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth, ApiOperation, ApiOkResponse, ApiCreatedResponse, ApiBadRequestResponse, ApiUnauthorizedResponse, ApiForbiddenResponse, ApiNotFoundResponse } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { AlertRulesService, CreateAlertRuleDto } from './alert-rules.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('alert-rules')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('alert-rules')
export class AlertRulesController {
    constructor(private alertRules: AlertRulesService) {}

    @Get()
    @ApiOperation({ summary: 'List alert rules for the company' })
    @ApiOkResponse({ description: 'Alert rules, ordered by type and creation time' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    findAll(@CurrentUser() user: any) {
        return this.alertRules.findAll(user.companyId);
    }

    @Post()
    @ApiOperation({ summary: 'Create a new alert rule for the company' })
    @ApiCreatedResponse({ description: 'The created alert rule' })
    @ApiBadRequestResponse({ description: 'Validation failed' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @ApiForbiddenResponse({ description: 'Insufficient role' })
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    create(@CurrentUser() user: any, @Body() dto: CreateAlertRuleDto) {
        return this.alertRules.create(user.companyId, dto);
    }

    @Put(':id')
    @ApiOperation({ summary: 'Update an existing alert rule' })
    @ApiOkResponse({ description: 'The updated alert rule' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @ApiForbiddenResponse({ description: 'Insufficient role' })
    @ApiNotFoundResponse({ description: 'Alert rule not found' })
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    update(@Param('id') id: string, @CurrentUser() user: any, @Body() dto: any) {
        return this.alertRules.update(id, user.companyId, dto);
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Delete an alert rule' })
    @ApiOkResponse({ description: 'The alert rule was deleted' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @ApiForbiddenResponse({ description: 'Insufficient role' })
    @ApiNotFoundResponse({ description: 'Alert rule not found' })
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    remove(@Param('id') id: string, @CurrentUser() user: any) {
        return this.alertRules.remove(id, user.companyId);
    }
}
