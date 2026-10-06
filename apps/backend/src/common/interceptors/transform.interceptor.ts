import {
    Injectable,
    NestInterceptor,
    ExecutionContext,
    CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { Reflector } from '@nestjs/core';
import { STATION_RESPONSE, StationResponseFormat } from '../decorators/station-response.decorator';

export interface ApiResponse<T> {
    data: T;
    meta: { requestId: string; timestamp: string };
}

function serializeBigInt(value: unknown): unknown {
    if (typeof value === 'bigint') return Number(value);
    if (Array.isArray(value)) return value.map(serializeBigInt);
    if (value && typeof value === 'object' && !(value instanceof Date)) {
        return Object.fromEntries(
            Object.entries(value).map(([key, item]) => [key, serializeBigInt(item)]),
        );
    }
    return value;
}

@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<T, ApiResponse<T> | T> {
    constructor(private readonly reflector: Reflector = new Reflector()) {}

    intercept(context: ExecutionContext, next: CallHandler): Observable<ApiResponse<T> | T> {
        const req = context.switchToHttp().getRequest();
        const format = this.reflector.get<StationResponseFormat>(STATION_RESPONSE, context.getHandler());
        return next.handle().pipe(
            map(data => {
                const serialized = serializeBigInt(data) as T;
                // Both old and current station price decoders accept a bare array.
                if (format === 'prices') return serialized;
                const envelope = {
                    data: serialized,
                    meta: { requestId: req.requestId ?? '', timestamp: new Date().toISOString() },
                };
                if (format === 'sync') {
                    const verdict = serialized as { accepted: string[]; rejected: string[] };
                    // Pre-envelope clients read the root; newer clients read data.
                    return { ...envelope, accepted: verdict.accepted, rejected: verdict.rejected };
                }
                return envelope;
            }),
        );
    }
}
