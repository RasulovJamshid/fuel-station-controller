import {
    Injectable,
    NestInterceptor,
    ExecutionContext,
    CallHandler,
    Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
    private readonly logger = new Logger(LoggingInterceptor.name);

    intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
        const req    = context.switchToHttp().getRequest();
        const start  = Date.now();
        const method = req.method;
        const url    = req.url;

        return next.handle().pipe(
            tap(() => {
                const ms = Date.now() - start;
                this.logger.log(`${method} ${url} - ${ms}ms`);
            }),
        );
    }
}
