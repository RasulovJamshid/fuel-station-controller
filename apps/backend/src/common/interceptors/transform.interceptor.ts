import {
    Injectable,
    NestInterceptor,
    ExecutionContext,
    CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';

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
export class TransformInterceptor<T> implements NestInterceptor<T, ApiResponse<T>> {
    intercept(context: ExecutionContext, next: CallHandler): Observable<ApiResponse<T>> {
        const req = context.switchToHttp().getRequest();
        return next.handle().pipe(
            map(data => ({
                data: serializeBigInt(data) as T,
                meta: {
                    requestId: req.requestId ?? '',
                    timestamp: new Date().toISOString(),
                },
            })),
        );
    }
}
