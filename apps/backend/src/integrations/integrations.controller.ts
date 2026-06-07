import { Controller, Get, Post, Put, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
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
    findAll(@CurrentUser() user: any) {
        return this.integrations.findAll(user.companyId);
    }

    @Post()
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    create(@CurrentUser() user: any, @Body() dto: CreateIntegrationDto) {
        return this.integrations.create(user.companyId, dto);
    }

    @Put(':id')
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    update(@Param('id') id: string, @CurrentUser() user: any, @Body() dto: UpdateIntegrationDto) {
        return this.integrations.update(id, user.companyId, dto);
    }

    @Delete(':id')
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    remove(@Param('id') id: string, @CurrentUser() user: any) {
        return this.integrations.remove(id, user.companyId);
    }

    @Post(':id/test')
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    test(@Param('id') id: string, @CurrentUser() user: any) {
        return this.integrations.test(id, user.companyId);
    }

    @Get(':id/deliveries')
    deliveries(@Param('id') id: string, @CurrentUser() user: any) {
        return this.integrations.deliveries(id, user.companyId);
    }
}
