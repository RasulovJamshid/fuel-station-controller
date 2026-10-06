import { SyncService } from './sync.service';
import { SyncController } from './sync.controller';
import { SyncBatchDto } from './dto/sync-batch.dto';
import { ValidationPipe } from '@nestjs/common';
import { ReservoirsService } from '../reservoirs/reservoirs.service';

const tankKey = (stationId: string, tankId: string) => JSON.stringify([stationId, tankId]);

// Shape emitted by the pre-upgrade dispenser-service ATG sync task (34220dd).
// Old clients send no catalog, product_name, capacity, or capability flags.
const legacyReading = (tank_id = '1', product_id = 1) => ({
    tank_id, product_id, volume_litres: 10000, level_mm: 1400,
    temperature_c: 18.5, water_mm: 0, fill_percent: 40, reading_at: 1791273600000,
});

function harness() {
    let state:any={markers:{},tanks:{},readings:{},stock:{},catalogAt:{}};
    let failCommit=false;
    const db=(s:()=>any):any=>({
        processedSyncRecord:{findUnique:jest.fn(async({where})=>s().markers[where.id]??null),create:jest.fn(async({data})=>s().markers[data.id]=data)},
        station:{update:jest.fn(async()=>({})),updateMany:jest.fn(async({where,data})=>{
            if(s().catalogAt[where.id] && s().catalogAt[where.id]>data.tankCatalogUpdatedAt) return {count:0};
            s().catalogAt[where.id]=data.tankCatalogUpdatedAt;return {count:1};
        })},
        nozzle:{findFirst:jest.fn(async({where})=>({productName:`Fuel ${where.productId} at ${where.position.stationId}`}))},
        reservoir:{
            findUnique:jest.fn(async({where})=>s().tanks[tankKey(where.stationId_tankId.stationId,where.stationId_tankId.tankId)]??null),
            upsert:jest.fn(async({where,create,update})=>{
                const key=tankKey(where.stationId_tankId.stationId,where.stationId_tankId.tankId);
                s().tanks[key]=s().tanks[key]?{...s().tanks[key],...update}:{id:key,managedByStation:false,active:true,...create};return s().tanks[key];
            }),updateMany:jest.fn(async({where,data})=>{
                let count=0;
                for(const tank of Object.values(s().tanks) as any[]) {
                    if(tank.stationId===where.stationId && tank.managedByStation && !where.tankId.notIn.includes(tank.tankId)
                       && (!tank.configUpdatedAt || tank.configUpdatedAt<=data.configUpdatedAt)) {
                        Object.assign(tank,data);count++;
                    }
                }
                return {count};
            }),
        },
        $executeRaw:jest.fn(async()=>0),
        reservoirReading:{upsert:jest.fn(async({where,create,update})=>{
            const key=JSON.stringify(where.reservoirId_readingAt);s().readings[key]=s().readings[key]?{...s().readings[key],...update}:create;
            return s().readings[key];
        })},
        stationStockRecord:{findUnique:jest.fn(async({where})=>s().stock[JSON.stringify(where.stationId_entityType_sourceId)]??null),
            upsert:jest.fn(async({where,create,update})=>{const key=JSON.stringify(where.stationId_entityType_sourceId);s().stock[key]=s().stock[key]?{...s().stock[key],...update}:create;return s().stock[key];})},
    });
    const prisma=db(()=>state);
    prisma.$transaction=jest.fn(async(fn:any)=>{
        const draft=structuredClone(state);
        const result=await fn(db(()=>draft));
        if(failCommit){failCommit=false;throw new Error('Simulated commit failure');}
        state=draft;return result;
    });
    const gateway:any={broadcast:jest.fn()};const integrations:any={dispatch:jest.fn(async()=>{})};
    const service=new SyncService(prisma,gateway,integrations,{} as any);
    (service as any).logger={error:jest.fn(),warn:jest.fn()};
    const record=(kind:string,id:string,payload:any)=>({id,entity_type:kind,entity_id:id,created_at:1,payload});
    const send=(...records:any[])=>service.processBatch('station','company',{records},'127.0.0.1');
    const sendAt=(stationId:string,...records:any[])=>service.processBatch(stationId,'company',{records},'127.0.0.1');
    return {record,send,sendAt,get:()=>state,fail:()=>{failCommit=true;},gateway,integrations,prisma,service};
}

describe('atomic physical tank sync',()=>{
    it('does not acknowledge unsupported records',async()=>{
        const h=harness();expect(await h.send(h.record('future_type','unknown',{}))).toEqual({accepted:[],rejected:['unknown']});
        expect(h.get().markers).toEqual({});
    });
    it('stores delivery and reconciliation payloads and heals old false acknowledgements',async()=>{
        const h=harness();h.get().markers.legacy={id:'legacy',stationId:'station'};
        const delivery=h.record('fuel_delivery','legacy',{id:'d1',tank_id:'tank-a',product_id:1,delivered_at:1000,delivered_l:100});
        const recon=h.record('wetstock_reconciliation','r1',{id:'r1',tank_id:null,product_id:1,period_end:2000,opening_l:0,deliveries_l:100,sales_l:0,book_closing_l:100,measured_l:100,variance_l:0});
        expect((await h.send(delivery,recon)).accepted).toHaveLength(2);
        expect(Object.values(h.get().stock)).toHaveLength(2);
        await h.send(delivery,recon);expect(Object.values(h.get().stock)).toHaveLength(2);
    });
    it('rolls back readings and receipt together, then accepts one copy on retry',async()=>{
        const h=harness();const r=h.record('reservoir_reading','sample',{tank_id:'tank-a',product_id:1,reading_at:1000,volume_litres:0});
        h.fail();expect((await h.send(r)).rejected).toEqual(['sample']);
        expect(Object.keys(h.get().readings)).toHaveLength(0);expect(Object.keys(h.get().markers)).toHaveLength(0);
        expect(h.gateway.broadcast).not.toHaveBeenCalled();
        expect(h.integrations.dispatch).not.toHaveBeenCalled();
        await h.send(r);await h.send(r);expect(Object.keys(h.get().readings)).toHaveLength(1);
        expect(h.gateway.broadcast).toHaveBeenCalledTimes(1);
        expect(h.integrations.dispatch).toHaveBeenCalledTimes(1);
    });
    it('keeps two tanks of the same product separate and retains zero-volume readings',async()=>{
        const h=harness();const tanks=['a','b'].map(tank_id=>({tank_id,product_id:1,label:`Tank ${tank_id}`,capacity_l:25000,product_name:'AI-92'}));
        await h.send(h.record('tank_catalog','catalog',{updated_at:1,tanks}));
        await h.send(...tanks.map((t,i)=>h.record('reservoir_reading',`r${i}`,{tank_id:t.tank_id,product_id:1,reading_at:2,volume_litres:i*1000,water_mm:0,temperature_c:20})));
        expect(Object.keys(h.get().tanks)).toHaveLength(2);expect(Object.keys(h.get().readings)).toHaveLength(2);
        expect((Object.values(h.get().readings) as any[]).map(r=>r.fillPercent)).toEqual([0,4]);
    });
    it('ignores an old catalog retried after a newer configuration',async()=>{
        const h=harness();await h.send(h.record('tank_catalog','new',{updated_at:2000,tanks:[]}));
        await h.send(h.record('tank_catalog','old',{updated_at:1000,tanks:[{tank_id:'old',product_id:1,label:'Old tank',capacity_l:25000,product_name:'AI-92'}]}));
        expect(Object.keys(h.get().tanks)).toHaveLength(0);
    });
});

describe('unchanged legacy ATG clients', () => {
    it('accepts the old four-tank batch through DTO validation and the sync controller without a catalog', async () => {
        const h = harness();
        const records = ['1', '2', 'AI-95 tank', 'custom-tank-id'].map((id, i) => h.record(
            'reservoir_reading', `d47ecf86-9666-4bf7-aef6-02c00e7b510${i}`, legacyReading(id, i + 1),
        ));
        const pipe = new ValidationPipe({
            whitelist: true, forbidNonWhitelisted: true, transform: true,
            transformOptions: { enableImplicitConversion: true }, stopAtFirstError: true,
        });
        const dto = await pipe.transform({ records }, { type: 'body', metatype: SyncBatchDto });
        const controller = new SyncController(h.service, {} as any);
        const result = await controller.batch('station', dto, { station: { companyId: 'company' }, ip: '127.0.0.1' } as any);
        expect(result).toEqual({ accepted: records.map(r => r.id), rejected: [] });
        expect(Object.keys(h.get().readings)).toHaveLength(4);
        expect(h.get().catalogAt).toEqual({});
        for (const [i, record] of records.entries()) {
            expect(h.get().tanks[tankKey('station', record.payload.tank_id)]).toMatchObject({
                tankId: record.payload.tank_id, productId: i + 1,
                productName: `Fuel ${i + 1} at station`, managedByStation: false,
            });
        }
        expect(await controller.batch('station', dto, { station: { companyId: 'company' } } as any)).toEqual(result);
        expect(Object.keys(h.get().readings)).toHaveLength(4);
        expect(h.integrations.dispatch).toHaveBeenCalledTimes(4);
    });

    it('keeps existing tank identity and admin metadata, and lets legacy tanks be edited after first discovery', async () => {
        const h = harness();
        const payload = legacyReading('tank-old');
        await h.send(h.record('reservoir_reading', 'first', payload));
        const reservoirId = h.get().tanks[tankKey('station', 'tank-old')].id;
        const reservoirs = new ReservoirsService(h.prisma);
        await reservoirs.create({ stationId: 'station', tankId: 'tank-old', label: 'Actual tank', productId: 1, productName: 'AI-92', capacity: 18000 });
        await h.send(h.record('reservoir_reading', 'second', { ...payload, reading_at: payload.reading_at + 1000 }));
        expect(Object.keys(h.get().tanks)).toHaveLength(1);
        expect(h.get().tanks[tankKey('station', 'tank-old')]).toMatchObject({
            id: reservoirId, label: 'Actual tank', productName: 'AI-92', capacity: 18000, managedByStation: false,
        });
        expect(h.integrations.dispatch).toHaveBeenLastCalledWith('company', 'station', 'tank.reading', {
            tankId: 'tank-old', reservoirId, volumeLitres: 10000, fillPercent: 10000 / 18000 * 100,
            levelMm: 1400, readingAt: payload.reading_at + 1000,
        });
    });

    it.each([false, true])('preserves the exact public webhook fields with catalog present = %s', async catalog => {
        const h = harness();
        if (catalog) await h.send(h.record('tank_catalog', 'catalog', { updated_at: 1, tanks: [
            { tank_id: '1', product_id: 1, label: 'Tank 1', product_name: 'AI-92', capacity_l: 20000 },
        ] }));
        const payload = legacyReading();
        await h.send(h.record('reservoir_reading', 'sample', payload));
        expect(h.integrations.dispatch).toHaveBeenCalledWith('company', 'station', 'tank.reading', {
            tankId: '1', reservoirId: h.get().tanks[tankKey('station', '1')].id,
            volumeLitres: 10000, fillPercent: catalog ? 50 : 40, levelMm: 1400, readingAt: payload.reading_at,
        });
    });

    it('accepts ISO timestamps and absent optional product metadata while preserving known product identity', async () => {
        const h = harness();
        const reservoirs = new ReservoirsService(h.prisma);
        await reservoirs.create({ stationId: 'station', tankId: 'known', label: 'Known', productId: 95, productName: 'AI-95', capacity: 25000 });
        const record = h.record('reservoir_reading', 'iso', { tank_id: 'known', reading_at: '2026-10-06T08:00:00.000Z', volume_litres: 0 });
        expect((await h.send(record)).accepted).toEqual(['iso']);
        expect(Object.values(h.get().readings)[0]).toMatchObject({ productId: 95, productName: 'AI-95', volumeLitres: 0 });
        expect((await h.send(h.record('reservoir_reading', 'minimal', { ...record.payload, tank_id: 'unknown' }))).accepted).toEqual(['minimal']);
        expect(h.get().tanks[tankKey('station', 'unknown')]).toMatchObject({ productId: 0, managedByStation: false });
    });

    it('keeps old and new stations independent and transfers metadata ownership only on an explicit catalog', async () => {
        const h = harness();
        await h.sendAt('old-site', h.record('reservoir_reading', 'old', legacyReading()));
        await h.sendAt('new-site', h.record('reservoir_reading', 'new-before-catalog', legacyReading()));
        const before = h.get().tanks[tankKey('new-site', '1')].id;
        await h.sendAt('new-site', h.record('tank_catalog', 'catalog', { updated_at: 2, tanks: [
            { tank_id: '1', product_id: 1, label: 'Physical tank', product_name: 'AI-92', capacity_l: 18000 },
        ] }));
        await h.sendAt('new-site', h.record('reservoir_reading', 'delayed-reading', { ...legacyReading(), reading_at: 1000 }));
        expect(h.get().tanks[tankKey('new-site', '1')]).toMatchObject({ id: before, managedByStation: true, capacity: 18000, label: 'Physical tank' });
        expect(h.get().tanks[tankKey('old-site', '1')]).toMatchObject({ managedByStation: false, active: true });
        const reservoirs = new ReservoirsService(h.prisma);
        const edit = { tankId: '1', productId: 1, productName: 'AI-92', capacity: 25000, label: 'Edited' };
        await expect(reservoirs.create({ ...edit, stationId: 'old-site' })).resolves.toMatchObject({ label: 'Edited' });
        await expect(reservoirs.create({ ...edit, stationId: 'new-site' })).rejects.toThrow('managed by the station');
        await h.sendAt('new-site', h.record('tank_catalog', 'remove', { updated_at: 3, tanks: [] }));
        expect(h.get().tanks[tankKey('old-site', '1')].active).toBe(true);
        expect(h.get().tanks[tankKey('new-site', '1')].active).toBe(false);
    });

    it('stores old delivery and reconciliation messages without a physical tank field', async () => {
        const h = harness();
        const records = [
            h.record('fuel_delivery', 'delivery', { id: 'd1', product_id: 1, delivered_at: 1000, delivered_l: 500 }),
            h.record('wetstock_reconciliation', 'recon', { id: 'r1', product_id: 1, period_end: 2000, opening_l: 0, deliveries_l: 500, sales_l: 100, book_closing_l: 400, measured_l: 400, variance_l: 0 }),
        ];
        expect(await h.send(...records)).toEqual({ accepted: ['delivery', 'recon'], rejected: [] });
        expect(Object.values(h.get().stock).map((r: any) => r.tankId)).toEqual([null, null]);
    });

    it.each([
        { tank_id: '' }, { reading_at: 'invalid-date' }, { volume_litres: -1 }, { water_mm: -1 },
    ])('rejects malformed readings without retaining an acknowledgement: %s', async patch => {
        const h = harness();
        expect(await h.send(h.record('reservoir_reading', 'bad', { ...legacyReading(), ...patch }))).toEqual({ accepted: [], rejected: ['bad'] });
        expect(Object.keys(h.get().markers)).toHaveLength(0);
        expect(Object.keys(h.get().tanks)).toHaveLength(0);
        expect(h.integrations.dispatch).not.toHaveBeenCalled();
    });
});
