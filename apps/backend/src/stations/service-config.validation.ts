import { BadRequestException } from '@nestjs/common';
import * as Joi from 'joi';

// Keep this aligned with crates/config::SiteConfig. Unknown fields are retained
// so editing a configuration does not discard settings added by newer services.
const object = (keys: Joi.SchemaMap) => Joi.object(keys).unknown(true);
const uint = (max = Number.MAX_SAFE_INTEGER) => Joi.number().integer().min(0).max(max);
const byte = () => uint(255);
const text = () => Joi.string().min(1);
const optionalText = () => Joi.string().allow('');
const positive = () => Joi.number().greater(0);
const nozzle = object({
    index: byte().min(1).required(), product_id: byte().required(),
    price: uint(4294967295).required(), active: Joi.boolean().required(),
    azt_address: byte(), shelf_address: byte(), bluesky_hose_number: byte(), wayne_code: byte(), wayne_product_code: byte(),
});
const schema = object({
    site: object({ id: text().required(), name: text().required(), timezone: text().required(), address: optionalText().allow(null) }).required(),
    service: object({
        port: uint(65535).min(1).required(), log_level: text().required(),
        log_file: text().required(), db_path: text().required(), serial_log_file: optionalText().allow(null),
    }).required(),
    connection: object({
        protocol: Joi.string().valid('mock', 'wayne_europump', 'wayne_dart_v1', 'wayne_dart_v2', 'gilbarco', 'azt2_0', 'texnouz_bluesky', 'shelf_v2_2').required(),
        port: text().required(), baud_rate: uint(4294967295).min(1).required(),
        parity: Joi.string().valid('none', 'odd', 'even').required(),
        data_bits: uint(8).min(5).required(), stop_bits: Joi.number().valid(1, 2).required(),
        response_timeout_ms: uint().min(1).required(),
    }).required(),
    polling: object({ interval_ms: uint().min(1).required(), offline_threshold_polls: uint(4294967295).required(), reconnect_settle_rounds: uint(4294967295).required() }).required(),
    products: Joi.array().min(1).unique('id').items(object({
        id: byte().required(), uuid: optionalText(), name: text().required(), color: text().required(), unit: text().required(),
    })).required(),
    fueling_positions: Joi.array().min(1).unique('id').items(object({
        id: text().required(), label: text().required(), address_byte: byte().required(), active: Joi.boolean().required(),
        nozzles: Joi.array().unique('index').items(nozzle).required(),
    })).required(),
    tanks: Joi.array().items(object({
        tank_id: text(), nozzle_sources: Joi.array().items(object({ fp_id: text().required(), nozzle_index: byte().min(1).required() })),
        product_id: byte().required(), label: text().required(), capacity_l: positive().required(), current_l: Joi.number().min(0).required(),
    })),
    atg: object({
        enabled: Joi.boolean(), export_enabled: Joi.boolean(),
        poll_interval_secs: uint(86400).min(1), modbus_timeout_secs: Joi.number().min(0.1).max(120), stale_after_secs: uint(604800).min(1).allow(null), api_url: optionalText().uri({ scheme: ['http', 'https'] }),
        auth: object({ api_token: optionalText(), username: optionalText(), password: optionalText(), login_url: optionalText().uri({ scheme: ['http', 'https'] }) }).allow(null),
        branches: Joi.array().unique('id').items(object({
            external_station_id: uint(4294967295).allow(null), word_order: Joi.string().valid('ABCD','CDAB','BADC','DCBA'), height_unit: Joi.string().valid('mm','m'),
            id: uint(4294967295).required(), name: optionalText(), host: text().required(),
            port: uint(65535).min(1), unit_id: byte(), start_register: uint(65535), address_base: uint(1),
            register_count: uint(65532).min(12).multiple(12),
            slots: Joi.array().min(1).unique('slot').items(object({
                slot: uint(5461).min(1).required(), tank_id: text().allow(null), type: text().required(),
                product_id: byte().allow(null), label: text().allow(null), capacity_l: positive().allow(null),
                maxima: Joi.object().pattern(text(), positive()),
            })).required(),
        })),
    }).allow(null),
    sync: object({
        enabled: Joi.boolean().required(), backend_url: optionalText().required(), api_key: optionalText().required(),
        retry_interval_secs: uint(), batch_size: uint(), max_retries: uint(4294967295),
        price_pull_interval_hours: uint(), price_pull_enabled: Joi.boolean(),
    }).required(),
    ui: object({
        default_auth_mode: optionalText(), preauth_timeout_seconds: uint(),
        use_decel_window_on_stop: Joi.boolean(), use_cancel_mode: Joi.boolean(),
    }),
    shifts: object({
        mode: Joi.string().valid('disabled', 'manual', 'scheduled').required(),
        scheduled: Joi.array().items(object({ name: Joi.string().allow('').required(), start: Joi.string().allow('').required(), end: Joi.string().allow('').required() })),
        require_operator_pin: Joi.boolean(), warn_before_end_minutes: uint(4294967295),
        allow_overlap_minutes: uint(4294967295), auto_close_on_restart: Joi.boolean(),
    }),
}).required();

export function validateDashboardServiceConfig(value: Record<string, any>): void {
    const { error } = schema.validate(value, { abortEarly: false, convert: false });
    if (error) throw new BadRequestException(error.details.map(detail => detail.message));
    const errors: string[] = [];
    const products = new Set(value.products.map((p: any) => p.id));
    const tankRows = value.tanks ?? [];
    const tankIds = new Set<string>();
    const nozzleSources = new Set<string>();
    const addresses = new Set<number>();
    const hoseAddresses = new Set<number>();
    const protocol = value.connection.protocol;
    if (protocol === 'shelf_v2_2' && (value.connection.data_bits !== 8 || value.connection.parity !== 'none' || value.connection.stop_bits !== 1)) {
        errors.push('SHELF V2.2 requires connection format 8N1');
    }
    for (const fp of value.fueling_positions) {
        if (fp.active) {
            if (addresses.has(fp.address_byte)) errors.push(`${fp.id}: duplicate active address ${fp.address_byte}`);
            addresses.add(fp.address_byte);
            if (!fp.nozzles.length) errors.push(`${fp.id}: active position requires nozzles`);
            if (protocol === 'shelf_v2_2' && (fp.address_byte === 0 || !fp.nozzles.some((n: any) => n.active))) {
                errors.push(`${fp.id}: SHELF requires a non-zero address and at least one active nozzle`);
            }
        }
        for (const n of fp.nozzles) {
            if (!products.has(n.product_id)) errors.push(`${fp.id}/${n.index}: unknown product ${n.product_id}`);
            if (n.active && n.price === 0) errors.push(`${fp.id}/${n.index}: active nozzle price must be positive`);
            if (protocol === 'shelf_v2_2' && n.active && n.price > 65535) errors.push(`${fp.id}/${n.index}: SHELF two-byte wire price maximum is 65535`);
            if (protocol === 'shelf_v2_2' && n.active && n.index > 5) errors.push(`${fp.id}/${n.index}: SHELF nozzle index must be the physical gun number 1–5`);
            if (fp.active && n.active && ['azt2_0', 'texnouz_bluesky', 'shelf_v2_2'].includes(protocol)) {
                const address = protocol === 'shelf_v2_2' ? n.shelf_address || fp.address_byte : protocol === 'azt2_0' ? n.azt_address || fp.address_byte : n.bluesky_hose_number || fp.address_byte + n.index;
                const max = protocol === 'azt2_0' ? 225 : 255;
                if (address < 1 || address > max) errors.push(`${fp.id}/${n.index}: hose address must be 1–${max}`);
                if (hoseAddresses.has(address)) errors.push(`${fp.id}/${n.index}: duplicate hose address ${address}`);
                hoseAddresses.add(address);
            }
        }
    }
    for (const tank of tankRows) {
        const tankId = tank.tank_id ?? String(tank.product_id);
        if (!tankId.trim() || tankIds.has(tankId)) errors.push('Tank IDs must be non-empty and unique');
        tankIds.add(tankId);
        if (!tank.tank_id && tankRows.filter((t: any) => t.product_id === tank.product_id).length > 1) errors.push('Multiple tanks for one product require explicit tank IDs');
        if (tank.current_l > tank.capacity_l) errors.push(`${tank.label}: starting volume exceeds capacity`);
        for (const source of tank.nozzle_sources ?? []) {
            const key = `${source.fp_id}/${source.nozzle_index}`;
            if (nozzleSources.has(key)) errors.push('Nozzle source assigned to multiple tanks');
            nozzleSources.add(key);
            if (!value.fueling_positions.some((fp: any) => fp.id === source.fp_id && fp.nozzles.some((n: any) => n.index === source.nozzle_index && n.product_id === tank.product_id))) errors.push('Tank nozzle source must have the same product');
        }
        if (!products.has(tank.product_id)) errors.push(`${tank.label}: unknown product ${tank.product_id}`);
        if (!tank.label.trim()) errors.push('Tank label cannot be blank');
    }
    const mappedTanks = new Set<string>();
    const slotIds = new Set<string>();
    const probes = new Set<string>();
    const groupUnits = new Map<string,string>();
    if (value.atg) {
        if (value.atg.enabled !== false && !value.atg.branches?.length) errors.push('Enabled ATG requires a controller');
        if (value.atg.stale_after_secs != null && value.atg.stale_after_secs < (value.atg.poll_interval_secs ?? 300)) errors.push('Stale interval must be at least poll interval');
        for (const raw of [value.atg.api_url, value.atg.auth?.login_url]) {
            if (raw) {const url=new URL(raw);if (url.username || url.password) errors.push('ATG URLs must not include credentials');}
        }
        const auth = value.atg.auth;
        if (auth && !auth.api_token && Boolean(auth.username) !== Boolean(auth.password)) errors.push('ATG login requires username and password');
    }
    for (const branch of value.atg?.branches ?? []) {
        const start = (branch.start_register ?? 1000) - (branch.address_base ?? 1);
        if (start < 0 || start + (branch.register_count ?? 12) > 65536) errors.push('Invalid ATG register window');
        if (!branch.host.trim()) errors.push(`ATG ${branch.id}: host cannot be blank`);
        for (const slot of branch.slots) {
            const label = `ATG ${branch.id}, slot ${slot.slot}`;
            const probe = `${branch.host.trim()}:${branch.port ?? 502}/${branch.unit_id ?? 1}/${start+(slot.slot-1)*12}`;
            if (probes.has(probe)) errors.push(`${label}: duplicate physical probe`);
            probes.add(probe);
            const group = `${branch.external_station_id ?? branch.id}/${slot.type}`;
            const unit = branch.height_unit ?? 'mm';
            if (groupUnits.has(group) && groupUnits.get(group) !== unit) errors.push('External fuel group must use consistent height units');
            groupUnits.set(group,unit);
            if (slot.slot * 12 > (branch.register_count ?? 12)) errors.push(`${label}: outside register count`);
            if (slot.tank_id) {
                if (slotIds.has(slot.tank_id)) errors.push(`${label}: duplicate tank ID`);
                slotIds.add(slot.tank_id);
            }
            if (slot.product_id != null) {
                const candidates = tankRows.filter((t: any) => t.product_id === slot.product_id && (!slot.tank_id || !t.tank_id || t.tank_id === slot.tank_id));
                if (!products.has(slot.product_id) || candidates.length !== 1) errors.push(`${label}: select one matching physical tank`);
                else {
                    const tank = candidates[0];
                    const id = tank.tank_id ?? String(tank.product_id);
                    if (mappedTanks.has(id)) errors.push(`${label}: tank is mapped more than once`);
                    mappedTanks.add(id);
                    if ([slot.capacity_l, slot.maxima?.product_volume].some(capacity => capacity != null && Math.abs(capacity - tank.capacity_l) > 0.01)) errors.push(`${label}: capacity conflicts with tank capacity`);
                }
            }
            for (const key of ['type', 'label', 'tank_id']) {
                if (slot[key] != null && !slot[key].trim()) errors.push(`${label}: ${key} cannot be blank`);
            }
            if (Object.keys(slot.maxima ?? {}).some(key => !['product_height','water_height','product_temperature','product_and_water_volume','product_volume','water_volume'].includes(key))) errors.push(`${label}: maxima keys cannot be blank`);
        }
    }
    if (value.shifts?.mode === 'scheduled') {
        if (!value.shifts.scheduled?.length) errors.push('Scheduled shifts require at least one time slot');
        for (const slot of value.shifts.scheduled ?? []) {
            const time = /^(?:[01]?\d|2[0-3]):[0-5]?\d$/;
            if (!slot.name || !time.test(slot.start) || !time.test(slot.end)) errors.push('Scheduled shifts require a name and valid HH:MM start/end times');
        }
    }
    if (errors.length) throw new BadRequestException(errors);
}
