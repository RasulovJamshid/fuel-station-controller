import { Injectable, NotFoundException } from '@nestjs/common';
import { IsString, IsNumber, IsBoolean, IsOptional } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PrismaService } from '../prisma/prisma.service';

export class CreateAlertRuleDto {
    @ApiPropertyOptional({ description: 'Station to scope the rule to; omit for a company-wide rule', example: 'stn_abc123' })
    @IsOptional() @IsString() stationId?: string;
    @ApiProperty({ description: 'Type of condition that triggers the alert', enum: ['tank_low', 'dispenser_offline', 'station_offline', 'sync_lag'], example: 'tank_low' })
    @IsString() type: string;
    @ApiPropertyOptional({ description: 'Threshold value for the condition (units depend on type)', example: 500 })
    @IsOptional() @IsNumber() threshold?: number;
    @ApiPropertyOptional({ description: 'Send a Telegram notification when triggered (defaults to true)', example: true })
    @IsOptional() @IsBoolean() notifyTelegram?: boolean;
    @ApiPropertyOptional({ description: 'Send an email notification when triggered (defaults to false)', example: false })
    @IsOptional() @IsBoolean() notifyEmail?: boolean;
}

@Injectable()
export class AlertRulesService {
    constructor(private prisma: PrismaService) {}

    findAll(companyId: string) {
        return this.prisma.alertRule.findMany({
            where: { companyId },
            orderBy: [{ type: 'asc' }, { createdAt: 'asc' }],
        });
    }

    create(companyId: string, dto: CreateAlertRuleDto) {
        return this.prisma.alertRule.create({
            data: {
                companyId,
                stationId:      dto.stationId,
                type:           dto.type,
                threshold:      dto.threshold,
                notifyTelegram: dto.notifyTelegram ?? true,
                notifyEmail:    dto.notifyEmail ?? false,
            },
        });
    }

    async update(id: string, companyId: string, dto: Partial<CreateAlertRuleDto> & { enabled?: boolean }) {
        const rule = await this.prisma.alertRule.findFirst({ where: { id, companyId } });
        if (!rule) throw new NotFoundException('Alert rule not found');
        return this.prisma.alertRule.update({
            where: { id },
            data: {
                threshold:      dto.threshold,
                enabled:        dto.enabled,
                notifyTelegram: dto.notifyTelegram,
                notifyEmail:    dto.notifyEmail,
            },
        });
    }

    async remove(id: string, companyId: string) {
        const rule = await this.prisma.alertRule.findFirst({ where: { id, companyId } });
        if (!rule) throw new NotFoundException('Alert rule not found');
        await this.prisma.alertRule.delete({ where: { id } });
    }
}
