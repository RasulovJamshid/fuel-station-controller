import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CreateCompanyDto, UpdateCompanyDto } from './dto/create-company.dto';

@Injectable()
export class CompaniesService {
    constructor(private prisma: PrismaService) {}

    async create(dto: CreateCompanyDto) {
        const existing = await this.prisma.company.findUnique({ where: { slug: dto.slug } });
        if (existing) throw new ConflictException(`Slug "${dto.slug}" is already taken`);
        return this.prisma.company.create({ data: dto });
    }

    findAll() {
        return this.prisma.company.findMany({ orderBy: { name: 'asc' } });
    }

    async findOne(id: string) {
        const company = await this.prisma.company.findFirst({ where: { id, deletedAt: null } });
        if (!company) throw new NotFoundException('Company not found');
        return company;
    }

    async update(id: string, dto: UpdateCompanyDto) {
        await this.findOne(id);
        return this.prisma.company.update({ where: { id }, data: dto });
    }

    async remove(id: string) {
        await this.findOne(id);
        return this.prisma.company.update({ where: { id }, data: { deletedAt: new Date() } });
    }
}
