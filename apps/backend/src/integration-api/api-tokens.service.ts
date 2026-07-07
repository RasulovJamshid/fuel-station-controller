import { Injectable, NotFoundException, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { generateApiToken } from '../common/helpers/api-token.util';
import { CreateApiTokenDto, UpdateApiTokenDto } from './dto/create-api-token.dto';

/**
 * Management of integration API tokens (create / list / revoke).
 * The plaintext token is returned only from `create`; listings expose
 * the non-secret prefix and metadata but never the stored hash.
 */
@Injectable()
export class ApiTokensService {
    constructor(private prisma: PrismaService) {}

    async create(companyId: string, userId: string | undefined, dto: CreateApiTokenDto) {
        const { token, tokenHash, tokenPrefix } = generateApiToken();
        const record = await this.prisma.apiToken.create({
            data: {
                companyId,
                name:        dto.name,
                tokenPrefix,
                tokenHash,
                scopes:      dto.scopes,
                oilBaseIds:      dto.oilBaseIds  ?? [],
                stationIds:      dto.stationIds  ?? [],
                ipAllowlist:     dto.ipAllowlist ?? [],
                rateLimitPerMin: dto.rateLimitPerMin ?? 120,
                expiresAt:       dto.expiresAt ? new Date(dto.expiresAt) : null,
                createdBy:       userId ?? null,
            },
        });
        // `token` is the plaintext — returned once, never persisted or shown again.
        return { ...this.serialize(record), token };
    }

    async update(companyId: string, id: string, dto: UpdateApiTokenDto) {
        const existing = await this.prisma.apiToken.findFirst({ where: { id, companyId } });
        if (!existing) throw new NotFoundException('API token not found');
        if (existing.revokedAt) throw new BadRequestException('Cannot modify a revoked token');

        const record = await this.prisma.apiToken.update({
            where: { id },
            data: {
                ...(dto.name        !== undefined ? { name: dto.name }               : {}),
                ...(dto.scopes      !== undefined ? { scopes: dto.scopes }           : {}),
                ...(dto.oilBaseIds  !== undefined ? { oilBaseIds: dto.oilBaseIds }   : {}),
                ...(dto.stationIds  !== undefined ? { stationIds: dto.stationIds }   : {}),
                ...(dto.ipAllowlist !== undefined ? { ipAllowlist: dto.ipAllowlist } : {}),
                ...(dto.rateLimitPerMin !== undefined ? { rateLimitPerMin: dto.rateLimitPerMin } : {}),
                ...(dto.active      !== undefined ? { active: dto.active }           : {}),
                ...(dto.expiresAt   !== undefined ? { expiresAt: dto.expiresAt ? new Date(dto.expiresAt) : null } : {}),
            },
        });
        return this.serialize(record);
    }

    async list(companyId: string) {
        const rows = await this.prisma.apiToken.findMany({
            where:   { companyId },
            orderBy: { createdAt: 'desc' },
        });
        return rows.map(r => this.serialize(r));
    }

    async revoke(companyId: string, id: string) {
        const existing = await this.prisma.apiToken.findFirst({ where: { id, companyId } });
        if (!existing) throw new NotFoundException('API token not found');
        await this.prisma.apiToken.update({
            where: { id },
            data:  { active: false, revokedAt: new Date() },
        });
    }

    /** Strip the secret hash before returning a token record to a client. */
    private serialize(token: { tokenHash: string } & Record<string, unknown>) {
        const { tokenHash: _omit, ...safe } = token;
        return safe;
    }
}
