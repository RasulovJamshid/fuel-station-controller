#!/usr/bin/env node
// Check real Nest routing, station auth, DTO validation and response serialization.
// Uses localhost and stubbed persistence; stock-sync.spec.ts covers storage behavior.
// Run after: npm --workspace=@azs/backend run build
require('reflect-metadata');
const assert = require('node:assert/strict');
const { Test } = require('@nestjs/testing');
const { ValidationPipe, VersioningType } = require('@nestjs/common');
const { SyncController } = require('../../apps/backend/dist/sync/sync.controller');
const { SyncService } = require('../../apps/backend/dist/sync/sync.service');
const { StationsService } = require('../../apps/backend/dist/stations/stations.service');
const { PrismaService } = require('../../apps/backend/dist/prisma/prisma.service');
const { TransformInterceptor } = require('../../apps/backend/dist/common/interceptors/transform.interceptor');

async function main() {
    const prices = [{ fp_id: 'FP1', nozzle_index: 1, product_id: 1, product_name: 'AI-92', price: 10000 }];
    const module = await Test.createTestingModule({
        controllers: [SyncController],
        providers: [
            { provide: PrismaService, useValue: { station: { findFirst: async ({ where }) =>
                where.id === 'legacy' && where.apiKey === 'local-test-key'
                    ? { id: 'legacy', companyId: 'company', ipAllowlist: [] } : null } } },
            { provide: SyncService, useValue: {
                processBatch: async (station, company, dto) => {
                    assert.equal(station, 'legacy'); assert.equal(company, 'company');
                    assert.equal(dto.records[0].payload.tank_id, '1');
                    return { accepted: dto.records.map(r => r.id), rejected: [] };
                },
                getCurrentPricesForStation: async () => prices,
            } },
            { provide: StationsService, useValue: { getServiceConfig: async () => ({ config: { atg: null } }) } },
        ],
    }).compile();
    const app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix('api');
    app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
    app.useGlobalPipes(new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true,
        transformOptions: { enableImplicitConversion: true }, stopAtFirstError: true }));
    app.useGlobalInterceptors(new TransformInterceptor());
    try {
        await app.listen(0, '127.0.0.1');
        const base = `${await app.getUrl()}/api/v1/sync/legacy`;
        const headers = { 'Content-Type': 'application/json', 'X-Api-Key': 'local-test-key' };
        const record = { id: 'd47ecf86-9666-4bf7-aef6-02c00e7b5100', entity_type: 'reservoir_reading',
            entity_id: '1/1791273600000', created_at: 1791273600000, payload: {
                tank_id: '1', product_id: 1, volume_litres: 10000, level_mm: 1400,
                water_mm: 0, temperature_c: 18.5, fill_percent: 40, reading_at: 1791273600000,
            } };
        assert.equal((await fetch(base, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ records: [record] }) })).status, 401);
        const response = await fetch(base, { method: 'POST', headers, body: JSON.stringify({ records: [record] }) });
        assert.equal(response.status, 200);
        const body = await response.json();
        const expected = { accepted: [record.id], rejected: [] };
        assert.deepEqual({ accepted: body.accepted, rejected: body.rejected }, expected);
        assert.deepEqual(body.data, expected);
        const priceResponse = await fetch(`${base}/prices`, { headers });
        assert.equal(priceResponse.status, 200);
        const priceBody = await priceResponse.json();
        assert.deepEqual(priceBody, prices);
        assert.deepEqual(priceBody.data ?? priceBody, prices);
        const configResponse = await fetch(`${base}/config`, { headers });
        assert.equal(configResponse.status, 200);
        assert.deepEqual((await configResponse.json()).data, { config: { atg: null } });
        console.log('PASS: legacy station auth, old/new sync acknowledgements, bare price arrays, preserved config envelope');
    } finally {
        await app.close();
    }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
