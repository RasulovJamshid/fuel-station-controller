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

@Injectable()
export class TransformInterceptor<T> implements NestInterceptor<T, ApiResponse<T>> {
    intercept(context: ExecutionContext, next: CallHandler): Observable<ApiResponse<T>> {
        const req = context.switchToHttp().getRequest();
        return next.handle().pipe(
            map(data => ({
                data,
                meta: {
                    requestId: req.requestId ?? '',
                    timestamp: new Date().toISOString(),
                },
            })),
        );
    }
}
