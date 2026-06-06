import { Controller, Get, Post, Put, Delete, Body, Param, UseGuards } from '@nestjs/common';
import { ApiTags, ApiBearerAuth } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { CompaniesService } from './companies.service';
import { CreateCompanyDto, UpdateCompanyDto } from './dto/create-company.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';

@ApiTags('companies')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('companies')
export class CompaniesController {
    constructor(private companies: CompaniesService) {}

    @Post()
    @Roles(UserRole.SUPER_ADMIN)
    create(@Body() dto: CreateCompanyDto) {
        return this.companies.create(dto);
    }

    @Get()
    @Roles(UserRole.SUPER_ADMIN)
    findAll() {
        return this.companies.findAll();
    }

    @Get(':id')
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    findOne(@Param('id') id: string) {
        return this.companies.findOne(id);
    }

    @Put(':id')
    @Roles(UserRole.SUPER_ADMIN)
    update(@Param('id') id: string, @Body() dto: UpdateCompanyDto) {
        return this.companies.update(id, dto);
    }

    @Delete(':id')
    @Roles(UserRole.SUPER_ADMIN)
    remove(@Param('id') id: string) {
        return this.companies.remove(id);
    }
}
