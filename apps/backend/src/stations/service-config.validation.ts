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
    azt_address: byte(), bluesky_hose_number: byte(), wayne_code: byte(), wayne_product_code: byte(),
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
    tanks: Joi.array().unique('product_id').items(object({
        product_id: byte().required(), label: text().required(), capacity_l: positive().required(), current_l: Joi.number().min(0).required(),
    })),
    atg: object({
        poll_interval_secs: uint().min(1), modbus_timeout_secs: positive(), api_url: optionalText(),
        auth: object({ api_token: optionalText(), username: optionalText(), password: optionalText(), login_url: optionalText() }).allow(null),
        branches: Joi.array().unique('id').items(object({
            id: uint(4294967295).required(), name: optionalText(), host: text().required(),
            port: uint(65535).min(1), unit_id: byte(), start_register: uint(65535), address_base: uint(65535),
            register_count: Joi.number().valid(12, 24, 36, 48),
            slots: Joi.array().min(1).unique('slot').items(object({
                slot: uint(4).min(1).required(), tank_id: text().allow(null), type: text().required(),
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
    const tanks = new Set((value.tanks ?? []).map((t: any) => t.product_id));
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
            if (protocol === 'shelf_v2_2' && (fp.address_byte === 0 || fp.nozzles.filter((n: any) => n.active).length !== 1)) {
                errors.push(`${fp.id}: SHELF requires a non-zero address and exactly one active nozzle`);
            }
        }
        for (const n of fp.nozzles) {
            if (!products.has(n.product_id)) errors.push(`${fp.id}/${n.index}: unknown product ${n.product_id}`);
            if (n.active && n.price === 0) errors.push(`${fp.id}/${n.index}: active nozzle price must be positive`);
            if (protocol === 'shelf_v2_2' && n.active && n.price > 9999) errors.push(`${fp.id}/${n.index}: SHELF price maximum is 9999`);
            if (fp.active && n.active && ['azt2_0', 'texnouz_bluesky'].includes(protocol)) {
                const address = protocol === 'azt2_0' ? n.azt_address || fp.address_byte : n.bluesky_hose_number || fp.address_byte + n.index;
                const max = protocol === 'azt2_0' ? 225 : 255;
                if (address < 1 || address > max) errors.push(`${fp.id}/${n.index}: hose address must be 1–${max}`);
                if (hoseAddresses.has(address)) errors.push(`${fp.id}/${n.index}: duplicate hose address ${address}`);
                hoseAddresses.add(address);
            }
        }
    }
    for (const tank of value.tanks ?? []) {
        if (!products.has(tank.product_id)) errors.push(`${tank.label}: unknown product ${tank.product_id}`);
        if (!tank.label.trim()) errors.push('Tank label cannot be blank');
    }
    for (const branch of value.atg?.branches ?? []) {
        if (!branch.host.trim()) errors.push(`ATG ${branch.id}: host cannot be blank`);
        for (const slot of branch.slots) {
            const label = `ATG ${branch.id}, slot ${slot.slot}`;
            if (slot.slot * 12 > (branch.register_count ?? 12)) errors.push(`${label}: outside register count`);
            if (slot.product_id != null && (!products.has(slot.product_id) || !tanks.has(slot.product_id))) errors.push(`${label}: product must have a matching tank`);
            for (const key of ['type', 'label', 'tank_id']) {
                if (slot[key] != null && !slot[key].trim()) errors.push(`${label}: ${key} cannot be blank`);
            }
            if (Object.keys(slot.maxima ?? {}).some(key => !key.trim())) errors.push(`${label}: maxima keys cannot be blank`);
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
