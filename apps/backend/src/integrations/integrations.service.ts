import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { createHmac } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { CreateIntegrationDto, UpdateIntegrationDto } from './dto/integration.dto';

const RETRY_DELAYS_MS = [60_000, 300_000, 1_800_000]; // 1m, 5m, 30m

@Injectable()
export class IntegrationsService {
    private readonly logger = new Logger(IntegrationsService.name);

    constructor(private prisma: PrismaService) {}

    // ── CRUD ──────────────────────────────────────────────────────

    findAll(companyId: string) {
        return this.prisma.integration.findMany({
            where: { companyId },
            orderBy: { createdAt: 'desc' },
        });
    }

    async findOne(id: string, companyId: string) {
        const integration = await this.prisma.integration.findFirst({ where: { id, companyId } });
        if (!integration) throw new NotFoundException('Integration not found');
        return integration;
    }

    create(companyId: string, dto: CreateIntegrationDto) {
        return this.prisma.integration.create({
            data: {
                companyId,
                name:       dto.name,
                url:        dto.url,
                authType:   dto.authType ?? 'none',
                authSecret: dto.authSecret ?? null,
                events:     dto.events,
                active:     dto.active ?? true,
                retryLimit: dto.retryLimit ?? 3,
                timeoutMs:  dto.timeoutMs ?? 5000,
            },
        });
    }

    async update(id: string, companyId: string, dto: UpdateIntegrationDto) {
        await this.findOne(id, companyId);
        return this.prisma.integration.update({ where: { id }, data: dto });
    }

    async remove(id: string, companyId: string) {
        await this.findOne(id, companyId);
        return this.prisma.integration.delete({ where: { id } });
    }

    // ── Delivery log ──────────────────────────────────────────────

    deliveries(integrationId: string, companyId: string) {
        return this.prisma.webhookDelivery.findMany({
            where: { integrationId, integration: { companyId } },
            orderBy: { createdAt: 'desc' },
            take: 100,
        });
    }

    // ── Test ping ─────────────────────────────────────────────────

    async test(id: string, companyId: string) {
        const integration = await this.findOne(id, companyId);
        const delivery = await this.prisma.webhookDelivery.create({
            data: {
                integrationId: integration.id,
                eventType:     'test.ping',
                payload:       { event: 'test.ping', timestamp: new Date().toISOString() },
                status:        'pending',
                attempts:      0,
            },
        });
        await this.attemptDelivery(delivery, integration);
        return this.prisma.webhookDelivery.findUnique({ where: { id: delivery.id } });
    }

    // ── Dispatch (called by SyncService) ──────────────────────────

    async dispatch(companyId: string, stationId: string | null, eventType: string, payload: Record<string, unknown>) {
        const integrations = await this.prisma.integration.findMany({
            where: {
                companyId,
                active: true,
                events: { has: eventType },
            },
        });

        if (integrations.length === 0) return;

        const fullPayload = {
            event:     eventType,
            stationId: stationId ?? null,
            timestamp: new Date().toISOString(),
            data:      payload as Record<string, unknown>,
        } as any;

        await Promise.all(integrations.map(async (integration) => {
            const delivery = await this.prisma.webhookDelivery.create({
                data: {
                    integrationId: integration.id,
                    eventType,
                    stationId:    stationId ?? null,
                    payload:      fullPayload,
                    status:       'pending',
                    attempts:     0,
                },
            });
            // Fire-and-forget; don't await so sync doesn't block
            this.attemptDelivery(delivery, integration).catch(e =>
                this.logger.error(`Dispatch error for delivery ${delivery.id}: ${e.message}`),
            );
        }));
    }

    // ── HTTP delivery ─────────────────────────────────────────────

    private async attemptDelivery(delivery: any, integration: any) {
        const body    = JSON.stringify(delivery.payload);
        const headers: Record<string, string> = {
            'Content-Type': 'application/json',
            'X-Webhook-Event': delivery.eventType,
            'X-Webhook-Delivery': delivery.id,
        };

        if (integration.authType === 'bearer' && integration.authSecret) {
            headers['Authorization'] = `Bearer ${integration.authSecret}`;
        } else if (integration.authType === 'hmac' && integration.authSecret) {
            const sig = createHmac('sha256', integration.authSecret).update(body).digest('hex');
            headers['X-Webhook-Signature'] = `sha256=${sig}`;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), integration.timeoutMs ?? 5000);

        let responseStatus: number | null = null;
        let responseBody:   string | null = null;
        let error:          string | null = null;

        try {
            const res = await fetch(integration.url, {
                method:  'POST',
                headers,
                body,
                signal:  controller.signal,
            });
            responseStatus = res.status;
            responseBody   = (await res.text()).substring(0, 500);

            if (res.ok) {
                await this.prisma.webhookDelivery.update({
                    where: { id: delivery.id },
                    data: {
                        status:        'delivered',
                        attempts:      { increment: 1 },
                        lastAttemptAt: new Date(),
                        responseStatus,
                        responseBody,
                        error:         null,
                        nextRetryAt:   null,
                    },
                });
                return;
            }
            error = `HTTP ${res.status}`;
        } catch (e: any) {
            error = e?.name === 'AbortError' ? 'Timeout' : (e?.message ?? 'Unknown error');
        } finally {
            clearTimeout(timer);
        }

        // Delivery failed — schedule retry if attempts < retryLimit
        const attempts = (delivery.attempts ?? 0) + 1;
        const delayMs  = RETRY_DELAYS_MS[attempts - 1] ?? RETRY_DELAYS_MS.at(-1)!;
        const exhausted = attempts >= (integration.retryLimit ?? 3);

        await this.prisma.webhookDelivery.update({
            where: { id: delivery.id },
            data: {
                status:        exhausted ? 'failed' : 'pending',
                attempts,
                lastAttemptAt: new Date(),
                nextRetryAt:   exhausted ? null : new Date(Date.now() + delayMs),
                responseStatus: responseStatus ?? null,
                responseBody:   responseBody ?? null,
                error,
            },
        });

        this.logger.warn(`Delivery ${delivery.id} [${delivery.eventType}] failed (attempt ${attempts}): ${error}`);
    }

    // ── Cron: retry pending deliveries ────────────────────────────

    @Cron('*/2 * * * *')
    async retryPending() {
        const due = await this.prisma.webhookDelivery.findMany({
            where: {
                status:      'pending',
                nextRetryAt: { lte: new Date() },
            },
            include: { integration: true },
            take: 50,
        });

        if (due.length === 0) return;
        this.logger.log(`Retrying ${due.length} pending webhook deliveries`);

        await Promise.all(due.map(d => this.attemptDelivery(d, d.integration).catch(() => {})));
    }

    // ── Cron: bulk resend (catch-all every 6h) ────────────────────

    @Cron('0 */6 * * *')
    async bulkResend() {
        // Re-queue failed deliveries from the last 24h that haven't exceeded retryLimit
        const cutoff = new Date(Date.now() - 24 * 3600 * 1000);

        const stale = await this.prisma.webhookDelivery.findMany({
            where: {
                status:    'failed',
                createdAt: { gte: cutoff },
            },
            include: { integration: true },
            take: 200,
        });

        if (stale.length === 0) return;
        this.logger.log(`Bulk resend: re-queuing ${stale.length} failed deliveries`);

        await Promise.all(stale.map(async (d) => {
            // Reset to pending and re-attempt
            await this.prisma.webhookDelivery.update({
                where: { id: d.id },
                data: { status: 'pending', attempts: 0, nextRetryAt: null },
            });
            await this.attemptDelivery({ ...d, attempts: 0 }, d.integration).catch(() => {});
        }));
    }
}
