import {
    Injectable, ConflictException, NotFoundException, ForbiddenException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as bcrypt from 'bcrypt';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { AuditService } from '../audit/audit.service';
import { CreateUserDto, UpdateUserDto, UpdatePreferencesDto } from './dto/create-user.dto';
import { PaginationDto, PaginatedResponse } from '../common/dto/pagination.dto';

@Injectable()
export class UsersService {
    constructor(
        private prisma:  PrismaService,
        private config:  ConfigService,
        private audit:   AuditService,
    ) {}

    async create(dto: CreateUserDto, actorId: string, actorCompanyId: string) {
        const existing = await this.prisma.user.findFirst({
            where: { companyId: dto.companyId, email: dto.email },
        });
        if (existing) throw new ConflictException('Email already exists in this company');

        const rounds = this.config.get<number>('BCRYPT_ROUNDS', 12);
        const hash   = await bcrypt.hash(dto.password, rounds);

        const user = await this.prisma.user.create({
            data: {
                companyId:        dto.companyId,
                email:            dto.email,
                name:             dto.name,
                passwordHash:     hash,
                role:             dto.role,
                passwordChangedAt: new Date(),
            },
        });

        await this.audit.log({
            companyId: actorCompanyId,
            userId:    actorId,
            action:    'CREATE_USER',
            entity:    'User',
            entityId:  user.id,
            newValue:  { email: user.email, role: user.role },
        });

        return this.safe(user);
    }

    async findAll(companyId: string, pagination: PaginationDto) {
        const where = { companyId };
        const [data, total] = await this.prisma.$transaction([
            this.prisma.user.findMany({
                where,
                select: this.safeSelect,
                orderBy: { name: 'asc' },
                skip:  pagination.skip,
                take:  pagination.limit,
            }),
            this.prisma.user.count({ where }),
        ]);
        return PaginatedResponse.of(data, total, pagination);
    }

    async findOne(id: string, companyId: string) {
        const user = await this.prisma.user.findFirst({
            where: { id, companyId },
            select: this.safeSelect,
        });
        if (!user) throw new NotFoundException('User not found');
        return user;
    }

    async update(id: string, companyId: string, dto: UpdateUserDto, actorId: string) {
        const user = await this.prisma.user.findFirst({ where: { id, companyId } });
        if (!user) throw new NotFoundException('User not found');

        const updated = await this.prisma.user.update({
            where: { id },
            data:  dto,
            select: this.safeSelect,
        });

        await this.audit.log({
            companyId,
            userId:   actorId,
            action:   'UPDATE_USER',
            entity:   'User',
            entityId: id,
            oldValue: { role: user.role, active: user.active },
            newValue: dto,
        });

        return updated;
    }

    async remove(id: string, companyId: string, actorId: string) {
        const user = await this.prisma.user.findFirst({ where: { id, companyId } });
        if (!user) throw new NotFoundException('User not found');
        if (user.id === actorId) throw new ForbiddenException('Cannot delete yourself');

        await this.prisma.user.update({ where: { id }, data: { deletedAt: new Date() } });
        await this.audit.log({
            companyId,
            userId:   actorId,
            action:   'DELETE_USER',
            entity:   'User',
            entityId: id,
        });
    }

    async updatePreferences(userId: string, dto: UpdatePreferencesDto) {
        const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
        const prefs = { ...(user.preferences as any), ...dto };
        await this.prisma.user.update({ where: { id: userId }, data: { preferences: prefs } });
        return prefs;
    }

    async grantStationAccess(userId: string, stationId: string, companyId: string) {
        const user = await this.prisma.user.findFirst({ where: { id: userId, companyId } });
        if (!user) throw new NotFoundException('User not found');
        await this.prisma.stationAccess.upsert({
            where: { userId_stationId: { userId, stationId } },
            create: { userId, stationId },
            update: {},
        });
    }

    async revokeStationAccess(userId: string, stationId: string, companyId: string) {
        const user = await this.prisma.user.findFirst({ where: { id: userId, companyId } });
        if (!user) throw new NotFoundException('User not found');
        await this.prisma.stationAccess.deleteMany({ where: { userId, stationId } });
    }

    private safe(user: any) {
        const { passwordHash, twoFactorSecret, ...rest } = user;
        return rest;
    }

    private readonly safeSelect = {
        id: true, companyId: true, email: true, name: true,
        role: true, active: true, twoFactorEnabled: true,
        lastLoginAt: true, createdAt: true, updatedAt: true,
        preferences: true,
        stationAccess: { select: { stationId: true } },
    };
}
