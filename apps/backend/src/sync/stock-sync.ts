import { Prisma } from '@prisma/client';
import { SyncRecordDto } from './dto/sync-batch.dto';
export const STOCK_TYPES = new Set(['tank_catalog', 'reservoir_reading', 'fuel_delivery', 'wetstock_reconciliation']);

// Keep the public webhook contract independent of station sync payload versions.
export interface TankReadingEvent {
    tankId: string;
    reservoirId: string;
    volumeLitres: number;
    fillPercent: number | null;
    levelMm?: number | null;
    readingAt: number | string;
}
function number(value: unknown, name: string, min = -Infinity): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min) throw new Error(`Invalid ${name}`);
    return value;
}
function product(value: unknown): number {
    const id = number(value, 'product_id', 0);
    if (!Number.isInteger(id) || id > 255) throw new Error('Invalid product_id');
    return id;
}
function text(value: unknown, name: string): string {
    if (typeof value !== 'string' || !value.trim()) throw new Error(`Missing ${name}`);
    return value;
}
function date(value: unknown): Date {
    const result = new Date(number(value, 'timestamp', 0));
    if (!Number.isFinite(result.getTime())) throw new Error('Invalid timestamp');
    return result;
}
export async function storeStockRecord(tx: Prisma.TransactionClient, stationId: string, companyId: string, record: SyncRecordDto): Promise<TankReadingEvent | undefined> {
    const p: any = record.payload;
    if (record.entity_type === 'tank_catalog') {
        if (!Array.isArray(p.tanks)) throw new Error('Missing tank catalog');
        const updatedAt = date(p.updated_at);
        const version = await tx.station.updateMany({where:{id:stationId,OR:[{tankCatalogUpdatedAt:null},{tankCatalogUpdatedAt:{lte:updatedAt}}]},data:{tankCatalogUpdatedAt:updatedAt}});
        if (!version.count) return;
        const ids = new Set<string>();
        for (const tank of p.tanks) {
            const tankId = text(tank.tank_id, 'tank_id');
            if (ids.has(tankId)) throw new Error('Duplicate tank_id');
            ids.add(tankId);
            const capacity = number(tank.capacity_l, 'capacity_l', Number.MIN_VALUE);
            const data = { monitoringEnabled: tank.monitoring_enabled !== false, staleAfterSecs: Math.floor(number(tank.stale_after_secs ?? 600, "stale_after_secs", 1)), label: text(tank.label, 'label'), productId: product(tank.product_id),
                productName: text(tank.product_name, 'product_name'), capacity, managedByStation: true, active: true, deletedAt: null, configUpdatedAt: updatedAt };
            const old = await tx.reservoir.findUnique({ where: { stationId_tankId: { stationId, tankId } } });
            if (!old || !old.configUpdatedAt || old.configUpdatedAt <= updatedAt) {
                await tx.reservoir.upsert({ where: { stationId_tankId: { stationId, tankId } }, create: { stationId, tankId, ...data }, update: data });
            }
        }
        await tx.reservoir.updateMany({ where: { stationId, managedByStation: true, tankId: { notIn: [...ids] },
            OR: [{configUpdatedAt: null}, {configUpdatedAt: {lte: updatedAt}}] }, data: { active: false, configUpdatedAt: updatedAt } });
        return;
    }
    if (record.entity_type === 'reservoir_reading') {
        const tankId = text(p.tank_id, 'tank_id');
        // Older clients may omit product metadata and send ISO dates. A catalog
        // is optional: accepting a reading must never claim metadata ownership.
        const existing = await tx.reservoir.findUnique({ where: { stationId_tankId: { stationId, tankId } } });
        const productId = product(p.product_id ?? existing?.productId ?? 0);
        const readingAt = typeof p.reading_at === 'string' ? new Date(p.reading_at) : date(p.reading_at);
        if (!Number.isFinite(readingAt.getTime())) throw new Error('Invalid reading_at');
        const volume = number(p.volume_litres, 'volume_litres', 0);
        let reservoir = existing;
        if (!reservoir) {
            const nozzle = typeof p.product_name === 'string' && p.product_name.trim() ? null : await tx.nozzle.findFirst({
                where: { productId, position: { stationId } }, select: { productName: true },
            });
            const productName = typeof p.product_name === 'string' && p.product_name.trim() ? p.product_name : nozzle?.productName ?? '';
            reservoir = await tx.reservoir.upsert({
                where: { stationId_tankId: { stationId, tankId } },
                create: { stationId, tankId, label: `Tank ${tankId}`, productId, productName, capacity: 0, managedByStation: false },
                update: {},
            });
        }
        const data = { stationId, companyId, readingAt, volumeLitres:volume, productId, productName:typeof p.product_name === "string" ? p.product_name : reservoir.productId === productId ? reservoir.productName : "",
            levelMm:p.level_mm == null ? null : number(p.level_mm,'level_mm',0),
            waterMm:p.water_mm == null ? null : number(p.water_mm,'water_mm',0),
            temperatureC:p.temperature_c == null ? null : number(p.temperature_c,'temperature_c'),
            fillPercent:reservoir.capacity > 0 ? volume/reservoir.capacity*100 : p.fill_percent == null ? null : number(p.fill_percent,'fill_percent',0) };
        await tx.reservoirReading.upsert({ where: {reservoirId_readingAt: {reservoirId:reservoir.id,readingAt}},
            create:{reservoirId:reservoir.id,...data},update:data });
        return {
            tankId, reservoirId: reservoir.id, volumeLitres: volume,
            fillPercent: data.fillPercent, levelMm: p.level_mm, readingAt: p.reading_at,
        };
    }
    const sourceId = text(p.id, 'id');
    const productId = product(p.product_id);
    const tankId = p.tank_id == null ? null : text(p.tank_id, 'tank_id');
    const occurredAt = date(record.entity_type === 'fuel_delivery' ? p.delivered_at : p.period_end);
    if (record.entity_type === 'fuel_delivery') number(p.delivered_l,'delivered_l',Number.MIN_VALUE);
    else for (const key of ['opening_l','deliveries_l','sales_l','book_closing_l','measured_l','variance_l']) number(p[key],key);
    const data = {companyId,tankId,productId,occurredAt,payload:p};
    await tx.stationStockRecord.upsert({where:{stationId_entityType_sourceId:{stationId,entityType:record.entity_type,sourceId}},
        create:{stationId,entityType:record.entity_type,sourceId,...data},update:data});
}
