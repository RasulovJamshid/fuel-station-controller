import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import * as ExcelJS from 'exceljs';
import { stringify } from 'csv-stringify/sync';
import * as path from 'path';
import * as fs from 'fs/promises';

export interface ExportParams {
    format:    'xlsx' | 'csv';
    type:      'transactions' | 'shifts';
    stationId?: string;
    oilBaseId?: string;
    status?: string | string[];
    from?:     string;
    to?:       string;
}

@Injectable()
export class ExportService {
    private readonly logger = new Logger(ExportService.name);
    private readonly outDir = process.env.EXPORT_PATH ?? '/tmp/azs-exports';

    constructor(private prisma: PrismaService) {}

    async generate(companyId: string, params: ExportParams, allowedStationIds?: string[]) {
        await fs.mkdir(this.outDir, { recursive: true });

        const data = await this.fetchData(companyId, params, allowedStationIds);
        const filename = `${params.type}_${Date.now()}.${params.format}`;
        const filePath = path.join(this.outDir, filename);

        if (params.format === 'xlsx') {
            await this.writeXlsx(data, filePath, params.type);
        } else {
            await this.writeCsv(data, filePath);
        }

        return { filename, path: filePath };
    }

    private async fetchData(companyId: string, params: ExportParams, allowedStationIds?: string[]) {
        if (allowedStationIds && allowedStationIds.length === 0) return [];
        if (params.type === 'transactions') {
            const statuses = params.status
                ? (Array.isArray(params.status) ? params.status : [params.status])
                : [];
            return this.prisma.transaction.findMany({
                where: {
                    companyId,
                    deletedAt: null,
                    ...(allowedStationIds ? { stationId: { in: allowedStationIds } } :
                        params.stationId ? { stationId: params.stationId } : {}),
                    ...(params.from || params.to ? {
                        startedAt: {
                            ...(params.from ? { gte: new Date(params.from) } : {}),
                            ...(params.to   ? { lte: new Date(params.to)   } : {}),
                        },
                    } : {}),
                    ...(statuses.length ? { status: { in: statuses as any } } : {}),
                },
                orderBy: { startedAt: 'asc' },
            });
        }

        return this.prisma.shift.findMany({
            where: {
                companyId,
                deletedAt: null,
                ...(allowedStationIds ? { stationId: { in: allowedStationIds } } :
                    params.stationId ? { stationId: params.stationId } : {}),
            },
            include: { positionTotals: true },
            orderBy: { startedAt: 'asc' },
        });
    }

    private async writeXlsx(data: any[], filePath: string, type: string) {
        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet(type);

        if (data.length === 0) {
            await wb.xlsx.writeFile(filePath);
            return;
        }

        ws.columns = Object.keys(data[0]).map(key => ({ header: key, key }));
        for (const row of data) {
            ws.addRow(Object.values(row).map(v => (typeof v === 'bigint' ? Number(v) : v)));
        }

        await wb.xlsx.writeFile(filePath);
    }

    private async writeCsv(data: any[], filePath: string) {
        const serialized = data.map(row =>
            Object.fromEntries(
                Object.entries(row).map(([k, v]) => [k, typeof v === 'bigint' ? String(v) : v])
            )
        );
        const csv = stringify(serialized, { header: true });
        await fs.writeFile(filePath, csv, 'utf-8');
    }
}
