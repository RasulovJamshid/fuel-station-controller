import { BadRequestException } from '@nestjs/common';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import { validateDashboardServiceConfig } from './service-config.validation';

function config() {
    return {
        site: { id: 'station-1', name: 'Station 1', timezone: 'Asia/Tashkent' },
        service: { port: 3001, log_level: 'info', log_file: 'service.log', db_path: 'transactions.db' },
        connection: { protocol: 'mock', port: 'mock', baud_rate: 9600, parity: 'none', data_bits: 8, stop_bits: 1, response_timeout_ms: 500 },
        polling: { interval_ms: 200, offline_threshold_polls: 5, reconnect_settle_rounds: 3 },
        products: [{ id: 1, name: 'AI-92', color: '#2196F3', unit: 'litre' }],
        fueling_positions: [{ id: 'FP1', label: 'Pump 1', address_byte: 1, active: true, nozzles: [{ index: 1, product_id: 1, price: 5000, active: true }] }],
        tanks: [{ product_id: 1, label: 'Tank 1', capacity_l: 20000, current_l: 0 }],
        sync: { enabled: true, backend_url: 'https://server.example', api_key: '' },
        atg: { poll_interval_secs: 300, modbus_timeout_secs: 10, branches: [{ id: 1, host: '192.168.1.10', slots: [{ slot: 1, type: 'AI-92', product_id: 1 }] }] },
    } as Record<string, any>;
}

describe('dashboard service config validation', () => {
    it('accepts a complete installation with tanks and ATG without changing it', () => {
        const value = config();
        value.products[0].uuid = 'existing-product-identity';
        value.connection.future_extension = { timing: 42 };
        value.atg.branches[0].slots[0].maxima = { product_volume: 20000 };
        const original = JSON.stringify(value);
        validateDashboardServiceConfig(value);
        expect(JSON.stringify(value)).toBe(original);
    });

    it.each(['azt', 'gilbarco', 'shelf', 'texnouz-bluesky'])('accepts the bundled %s configuration', name => {
        const file = resolve(__dirname, `../../../../services/dispenser-service/site.config.${name}.json`);
        validateDashboardServiceConfig(JSON.parse(readFileSync(file, 'utf8')));
    });

    it.each<[string, (value: Record<string, any>) => void]>([
        ['missing required serial settings', c => { delete c.connection.baud_rate; }],
        ['string numeric fields', c => { c.connection.baud_rate = '9600'; }],
        ['unknown protocols', c => { c.connection.protocol = 'unsupported'; }],
        ['out of range product IDs', c => { c.products[0].id = 256; }],
        ['duplicate products', c => { c.products.push({ ...c.products[0] }); }],
        ['duplicate active addresses', c => { c.fueling_positions.push({ ...c.fueling_positions[0], id: 'FP2' }); }],
        ['unknown nozzle products', c => { c.fueling_positions[0].nozzles[0].product_id = 99; }],
        ['zero active prices', c => { c.fueling_positions[0].nozzles[0].price = 0; }],
        ['fractional prices', c => { c.fueling_positions[0].nozzles[0].price = 1.5; }],
        ['duplicate nozzle indices', c => { c.fueling_positions[0].nozzles.push({ ...c.fueling_positions[0].nozzles[0] }); }],
        ['negative tank volume', c => { c.tanks[0].current_l = -1; }],
        ['unknown tank products', c => { c.tanks[0].product_id = 99; }],
        ['duplicate local tanks', c => { c.tanks.push({ ...c.tanks[0] }); }],
        ['ATG slots without local tanks', c => { c.tanks = []; }],
        ['ATG slots beyond register count', c => { c.atg.branches[0].slots[0].slot = 2; }],
        ['duplicate ATG branches', c => { c.atg.branches.push({ ...c.atg.branches[0] }); }],
        ['empty ATG host', c => { c.atg.branches[0].host = ' '; }],
        ['blank ATG maxima keys', c => { c.atg.branches[0].slots[0].maxima = { ' ': 100 }; }],
        ['invalid scheduled times', c => { c.shifts = { mode: 'scheduled', scheduled: [{ name: 'Day', start: '25:00', end: '20:00' }] }; }],
        ['missing scheduled slots', c => { c.shifts = { mode: 'scheduled' }; }],
        ['SHELF serial format', c => { c.connection.protocol = 'shelf_v2_2'; c.connection.parity = 'even'; }],
        ['SHELF wire price limit', c => { c.connection.protocol = 'shelf_v2_2'; c.fueling_positions[0].nozzles[0].price = 10000; }],
        ['multiple SHELF nozzles', c => { c.connection.protocol = 'shelf_v2_2'; c.fueling_positions[0].nozzles.push({ ...c.fueling_positions[0].nozzles[0], index: 2 }); }],
        ['duplicate AZT hose addresses', c => { c.connection.protocol = 'azt2_0'; c.fueling_positions[0].nozzles.push({ ...c.fueling_positions[0].nozzles[0], index: 2 }); }],
        ['BlueSky address overflow', c => { c.connection.protocol = 'texnouz_bluesky'; c.fueling_positions[0].address_byte = 255; }],
    ])('rejects %s', (_, mutate) => {
        const value = config();
        mutate(value);
        expect(() => validateDashboardServiceConfig(value)).toThrow(BadRequestException);
    });

    it('supports explicit per-nozzle addresses and optional legacy ATG fields', () => {
        const value = config();
        value.connection.protocol = 'azt2_0';
        value.fueling_positions[0].nozzles.push({ ...value.fueling_positions[0].nozzles[0], index: 2, azt_address: 16 });
        validateDashboardServiceConfig(value);
        value.connection.protocol = 'texnouz_bluesky';
        value.fueling_positions[0].nozzles[1].bluesky_hose_number = 28;
        validateDashboardServiceConfig(value);
    });
});
