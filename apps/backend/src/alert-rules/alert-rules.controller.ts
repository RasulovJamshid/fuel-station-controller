import { Controller, Get, Post, Put, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
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
    findAll(@CurrentUser() user: any) {
        return this.alertRules.findAll(user.companyId);
    }

    @Post()
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    create(@CurrentUser() user: any, @Body() dto: CreateAlertRuleDto) {
        return this.alertRules.create(user.companyId, dto);
    }

    @Put(':id')
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    update(@Param('id') id: string, @CurrentUser() user: any, @Body() dto: any) {
        return this.alertRules.update(id, user.companyId, dto);
    }

    @Delete(':id')
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    remove(@Param('id') id: string, @CurrentUser() user: any) {
        return this.alertRules.remove(id, user.companyId);
    }
}
