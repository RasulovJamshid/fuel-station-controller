import { Controller, Get, Post, Put, Delete, Body, Param, UseGuards } from '@nestjs/common';
import {
    ApiTags, ApiBearerAuth, ApiOperation, ApiOkResponse, ApiCreatedResponse,
    ApiBadRequestResponse, ApiUnauthorizedResponse, ApiForbiddenResponse,
    ApiNotFoundResponse, ApiConflictResponse,
} from '@nestjs/swagger';
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
    @ApiOperation({ summary: 'Create a company' })
    @ApiCreatedResponse({ description: 'Company created' })
    @ApiBadRequestResponse({ description: 'Validation failed' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @ApiForbiddenResponse({ description: 'Insufficient role' })
    @ApiConflictResponse({ description: 'Slug is already taken' })
    @Roles(UserRole.SUPER_ADMIN)
    create(@Body() dto: CreateCompanyDto) {
        return this.companies.create(dto);
    }

    @Get()
    @ApiOperation({ summary: 'List all companies' })
    @ApiOkResponse({ description: 'List of companies' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @ApiForbiddenResponse({ description: 'Insufficient role' })
    @Roles(UserRole.SUPER_ADMIN)
    findAll() {
        return this.companies.findAll();
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get a company by ID' })
    @ApiOkResponse({ description: 'Company found' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @ApiForbiddenResponse({ description: 'Insufficient role' })
    @ApiNotFoundResponse({ description: 'Company not found' })
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    findOne(@Param('id') id: string) {
        return this.companies.findOne(id);
    }

    @Put(':id')
    @ApiOperation({ summary: 'Update a company' })
    @ApiOkResponse({ description: 'Company updated' })
    @ApiBadRequestResponse({ description: 'Validation failed' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @ApiForbiddenResponse({ description: 'Insufficient role' })
    @ApiNotFoundResponse({ description: 'Company not found' })
    @Roles(UserRole.SUPER_ADMIN)
    update(@Param('id') id: string, @Body() dto: UpdateCompanyDto) {
        return this.companies.update(id, dto);
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Soft-delete a company' })
    @ApiOkResponse({ description: 'Company deleted' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @ApiForbiddenResponse({ description: 'Insufficient role' })
    @ApiNotFoundResponse({ description: 'Company not found' })
    @Roles(UserRole.SUPER_ADMIN)
    remove(@Param('id') id: string) {
        return this.companies.remove(id);
    }
}
