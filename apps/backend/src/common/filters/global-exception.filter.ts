import {
    Catch,
    ExceptionFilter,
    ArgumentsHost,
    HttpException,
    HttpStatus,
} from '@nestjs/common';
import { Response, Request } from 'express';

const HTTP_STATUS_CODES: Record<number, string> = {
    400: 'VALIDATION_ERROR',
    401: 'UNAUTHORIZED',
    403: 'FORBIDDEN',
    404: 'NOT_FOUND',
    409: 'CONFLICT',
    429: 'TOO_MANY_REQUESTS',
    500: 'INTERNAL_ERROR',
};

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
    catch(exception: unknown, host: ArgumentsHost) {
        const ctx    = host.switchToHttp();
        const res    = ctx.getResponse<Response>();
        const req    = ctx.getRequest<Request>();

        const status = exception instanceof HttpException
            ? exception.getStatus()
            : HttpStatus.INTERNAL_SERVER_ERROR;

        let message: string;
        let field: string | undefined;

        if (exception instanceof HttpException) {
            const body = exception.getResponse();
            if (typeof body === 'object' && body !== null) {
                const b = body as any;
                message = Array.isArray(b.message) ? b.message[0] : (b.message ?? exception.message);
                field   = b.field;
            } else {
                message = exception.message;
            }
        } else {
            message = 'Internal server error';
            if (process.env.NODE_ENV !== 'production') {
                console.error(exception);
            }
        }

        res.status(status).json({
            statusCode: status,
            error:      HTTP_STATUS_CODES[status] ?? 'ERROR',
            message,
            ...(field ? { field } : {}),
            requestId:  (req as any).requestId,
            timestamp:  new Date().toISOString(),
        });
    }
}
