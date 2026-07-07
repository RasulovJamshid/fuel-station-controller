import {
    Controller, Get, Post, Put, Delete, Body, Param, Query, UseGuards,
} from '@nestjs/common';
import {
    ApiTags, ApiBearerAuth, ApiOperation, ApiOkResponse, ApiCreatedResponse,
    ApiBadRequestResponse, ApiUnauthorizedResponse, ApiForbiddenResponse,
    ApiNotFoundResponse, ApiConflictResponse,
} from '@nestjs/swagger';
import { UserRole } from '@prisma/client';
import { UsersService } from './users.service';
import { CreateUserDto, UpdateUserDto, UpdatePreferencesDto } from './dto/create-user.dto';
import { PaginationDto } from '../common/dto/pagination.dto';
import { JwtAuthGuard } from '../common/guards/jwt-auth.guard';
import { RolesGuard } from '../common/guards/roles.guard';
import { Roles } from '../common/decorators/roles.decorator';
import { CurrentUser } from '../common/decorators/current-user.decorator';

@ApiTags('users')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('users')
export class UsersController {
    constructor(private users: UsersService) {}

    @Post()
    @ApiOperation({ summary: 'Create a user in the specified company' })
    @ApiCreatedResponse({ description: 'User created' })
    @ApiBadRequestResponse({ description: 'Validation failed' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @ApiForbiddenResponse({ description: 'Insufficient role' })
    @ApiConflictResponse({ description: 'Email already exists in this company' })
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    create(@Body() dto: CreateUserDto, @CurrentUser() actor: any) {
        return this.users.create(dto, actor.id, actor.companyId);
    }

    @Get()
    @ApiOperation({ summary: "List users in the caller's company" })
    @ApiOkResponse({ description: 'Paginated list of users' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @ApiForbiddenResponse({ description: 'Insufficient role' })
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    findAll(@CurrentUser() user: any, @Query() pagination: PaginationDto) {
        return this.users.findAll(user.companyId, pagination);
    }

    @Get(':id')
    @ApiOperation({ summary: 'Get a user by ID' })
    @ApiOkResponse({ description: 'User found' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @ApiForbiddenResponse({ description: 'Insufficient role' })
    @ApiNotFoundResponse({ description: 'User not found' })
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    findOne(@Param('id') id: string, @CurrentUser() user: any) {
        return this.users.findOne(id, user.companyId);
    }

    @Put(':id')
    @ApiOperation({ summary: 'Update a user' })
    @ApiOkResponse({ description: 'User updated' })
    @ApiBadRequestResponse({ description: 'Validation failed' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @ApiForbiddenResponse({ description: 'Insufficient role' })
    @ApiNotFoundResponse({ description: 'User not found' })
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    update(@Param('id') id: string, @Body() dto: UpdateUserDto, @CurrentUser() actor: any) {
        return this.users.update(id, actor.companyId, dto, actor.id);
    }

    @Delete(':id')
    @ApiOperation({ summary: 'Soft-delete a user' })
    @ApiOkResponse({ description: 'User deleted' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @ApiForbiddenResponse({ description: 'Insufficient role, or attempting to delete yourself' })
    @ApiNotFoundResponse({ description: 'User not found' })
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    remove(@Param('id') id: string, @CurrentUser() actor: any) {
        return this.users.remove(id, actor.companyId, actor.id);
    }

    @Put('preferences')
    @ApiOperation({ summary: 'Update the current user preferences' })
    @ApiOkResponse({ description: 'Updated preferences' })
    @ApiBadRequestResponse({ description: 'Validation failed' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    updatePreferences(@CurrentUser() user: any, @Body() dto: UpdatePreferencesDto) {
        return this.users.updatePreferences(user.id, dto);
    }

    @Post(':id/station-access/:stationId')
    @ApiOperation({ summary: 'Grant a user access to a station' })
    @ApiCreatedResponse({ description: 'Station access granted' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @ApiForbiddenResponse({ description: 'Insufficient role' })
    @ApiNotFoundResponse({ description: 'User not found' })
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    grantAccess(@Param('id') id: string, @Param('stationId') stationId: string, @CurrentUser() actor: any) {
        return this.users.grantStationAccess(id, stationId, actor.companyId);
    }

    @Delete(':id/station-access/:stationId')
    @ApiOperation({ summary: 'Revoke a user access to a station' })
    @ApiOkResponse({ description: 'Station access revoked' })
    @ApiUnauthorizedResponse({ description: 'Missing or invalid access token' })
    @ApiForbiddenResponse({ description: 'Insufficient role' })
    @ApiNotFoundResponse({ description: 'User not found' })
    @Roles(UserRole.SUPER_ADMIN, UserRole.COMPANY_ADMIN)
    revokeAccess(@Param('id') id: string, @Param('stationId') stationId: string, @CurrentUser() actor: any) {
        return this.users.revokeStationAccess(id, stationId, actor.companyId);
    }
}
