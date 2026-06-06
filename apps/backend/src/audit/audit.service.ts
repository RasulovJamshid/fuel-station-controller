import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

interface AuditParams {
    companyId: string;
    userId?:   string;
    userEmail?: string;
    action:    string;
    entity:    string;
    entityId?: string;
    oldValue?: unknown;
    newValue?: unknown;
    ipAddress?: string;
    requestId?: string;
}

@Injectable()
export class AuditService {
    constructor(private prisma: PrismaService) {}

    async log(params: AuditParams) {
        await this.prisma.auditLog.create({
            data: {
                companyId: params.companyId,
                userId:    params.userId,
                userEmail: params.userEmail,
                action:    params.action,
                entity:    params.entity,
                entityId:  params.entityId,
                oldValue:  params.oldValue as any,
                newValue:  params.newValue as any,
                ipAddress: params.ipAddress,
                requestId: params.requestId,
            },
        });
    }

    async findMany(companyId: string, page = 1, limit = 50) {
        const skip = (page - 1) * limit;
        const [data, total] = await this.prisma.$transaction([
            this.prisma.auditLog.findMany({
                where: { companyId },
                orderBy: { createdAt: 'desc' },
                skip,
                take: limit,
            }),
            this.prisma.auditLog.count({ where: { companyId } }),
        ]);
        return { data, total, page, limit, pages: Math.ceil(total / limit) };
    }
}
