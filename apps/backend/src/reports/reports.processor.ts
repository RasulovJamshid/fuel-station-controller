import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Logger } from '@nestjs/common';
import { Job } from 'bullmq';
import { ExportService } from '../export/export.service';
import { DashboardGateway } from '../dashboard/dashboard.gateway';

@Processor('reports')
export class ReportsProcessor extends WorkerHost {
    private readonly logger = new Logger(ReportsProcessor.name);

    constructor(
        private exportService: ExportService,
        private gateway:       DashboardGateway,
    ) {
        super();
    }

    async process(job: Job) {
        const { userId, companyId, params, allowedStationIds } = job.data;
        this.logger.log(`Processing export job ${job.id}: ${params.format}`);

        try {
            const result = await this.exportService.generate(companyId, params, allowedStationIds);
            this.gateway.notifyUser(userId, 'export.ready', result);
        } catch (e: any) {
            this.logger.error(`Export job ${job.id} failed: ${e.message}`);
            this.gateway.notifyUser(userId, 'export.failed', { error: e.message });
            throw e;
        }
    }
}
