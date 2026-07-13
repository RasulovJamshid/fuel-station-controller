import { Body, Controller, Delete, Get, Param, Post, Put, UseGuards } from '@nestjs/common';
import { IsBoolean, IsNumber, IsOptional, IsString, MinLength } from 'class-validator';
import { ApiBearerAuth, ApiTags } from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { ProductsService } from './products.service';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { PrismaService } from '../prisma/prisma.service';
import { resolveStationIds } from '../common/helpers/station-access.helper';

class ProductDto {
    @IsString() @MinLength(1) code: string;
    @IsString() @MinLength(1) name: string;
    @IsOptional() @IsBoolean() active?: boolean;
}
class MappingDto {
    @IsString() stationId: string;
    @IsOptional() @IsNumber() stationProductId?: number;
    @IsString() @MinLength(1) stationProductName: string;
}

@ApiTags('products')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('products')
export class ProductsController {
    constructor(private products: ProductsService, private prisma: PrismaService) {}

    @Get() list(@CurrentUser() user: any) { return this.products.list(user.companyId); }

    @Get('discovered') async discovered(@CurrentUser() user: any) {
        return this.products.discovered(user.companyId, await resolveStationIds(this.prisma, user));
    }

    @Post() @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    create(@CurrentUser() user: any, @Body() dto: ProductDto) { return this.products.create(user.companyId, dto); }

    @Put(':id') @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    update(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: ProductDto) { return this.products.update(user.companyId, id, dto); }

    @Delete('mappings/:id') @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    unmap(@CurrentUser() user: any, @Param('id') id: string) { return this.products.unmap(user.companyId, id); }

    @Post(':id/mappings') @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    map(@CurrentUser() user: any, @Param('id') id: string, @Body() dto: MappingDto) { return this.products.map(user.companyId, id, dto); }

    @Delete(':id') @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    remove(@CurrentUser() user: any, @Param('id') id: string) { return this.products.remove(user.companyId, id); }
}
