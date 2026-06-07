import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import helmet from 'helmet';
import compression from 'compression';
import rateLimit from 'express-rate-limit';
import * as express from 'express';
import { AppModule } from './app.module';
import { GlobalExceptionFilter } from './common/filters/global-exception.filter';
import { TransformInterceptor } from './common/interceptors/transform.interceptor';

async function bootstrap() {
    const app = await NestFactory.create(AppModule, { bufferLogs: true });
    const isProd = process.env.NODE_ENV === 'production';

    // ── Structured logger ───────────────────────────────────────────
    app.useLogger(app.get(Logger));
    const logger = app.get(Logger);

    // ── Trust proxy (nginx / cloud LB) ──────────────────────────────
    // Required for correct IP detection in rate-limiting and IP allowlists.
    app.getHttpAdapter().getInstance().set('trust proxy', 1);

    // ── Security headers ────────────────────────────────────────────
    app.use(helmet({
        // Allow Swagger UI to load its inline scripts/styles in non-prod
        contentSecurityPolicy: isProd ? undefined : false,
        crossOriginEmbedderPolicy: false,
    }));

    // ── Response compression ────────────────────────────────────────
    app.use(compression());

    // ── Body size limits ────────────────────────────────────────────
    // Sync batches can contain many records; allow up to 10 MB.
    app.use(express.json({ limit: '10mb' }));
    app.use(express.urlencoded({ extended: true, limit: '10mb' }));

    // ── CORS ────────────────────────────────────────────────────────
    const allowedOrigins = (process.env.CORS_ORIGINS ?? '')
        .split(',')
        .map(s => s.trim())
        .filter(Boolean);

    app.enableCors({
        origin: allowedOrigins.length > 0 ? allowedOrigins : false,
        credentials: true,
        methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
        allowedHeaders: ['Content-Type', 'Authorization', 'X-Api-Key', 'X-Request-Id'],
        exposedHeaders: ['X-Request-Id'],
    });

    // ── Global prefix + versioning ──────────────────────────────────
    app.setGlobalPrefix('api');
    app.enableVersioning({
        type: VersioningType.URI,
        defaultVersion: '1',
    });

    // ── Global pipes ─────────────────────────────────────────────────
    app.useGlobalPipes(new ValidationPipe({
        whitelist:              true,
        forbidNonWhitelisted:   true,
        transform:              true,
        transformOptions:       { enableImplicitConversion: true },
        stopAtFirstError:       true,
    }));

    // ── Global filter + interceptor ──────────────────────────────────
    app.useGlobalFilters(new GlobalExceptionFilter());
    app.useGlobalInterceptors(new TransformInterceptor());

    // ── Rate limiting ────────────────────────────────────────────────
    // Applied most-specific-first; Express matches first winning route.
    app.use('/api/v1/auth/login', rateLimit({
        windowMs:  60_000,
        max:       10,
        standardHeaders: true,
        legacyHeaders:   false,
        message: { error: 'TOO_MANY_REQUESTS', message: 'Too many login attempts' },
    }));

    // Station sync endpoint — high-frequency, keyed by API key not IP
    app.use('/api/v1/sync/', rateLimit({
        windowMs:  60_000,
        max:       300,
        standardHeaders: true,
        legacyHeaders:   false,
        keyGenerator: (req: any) => (req.headers['x-api-key'] as string) ?? req.ip ?? 'unknown',
    }));

    // General API
    app.use('/api/', rateLimit({
        windowMs:  60_000,
        max:       500,
        standardHeaders: true,
        legacyHeaders:   false,
        skip: (req: any) => req.url === '/api/health',
    }));

    // ── Swagger ─────────────────────────────────────────────────────
    // Never expose auto-generated docs in production unless explicitly opted in.
    const swaggerEnabled = !isProd || process.env.SWAGGER_ENABLED === 'true';
    if (swaggerEnabled) {
        const config = new DocumentBuilder()
            .setTitle('AZS Manager API')
            .setDescription('Fuel station management platform')
            .setVersion('1.0')
            .addBearerAuth()
            .addApiKey({ type: 'apiKey', in: 'header', name: 'X-Api-Key' }, 'station-key')
            .build();
        SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config), {
            swaggerOptions: { persistAuthorization: true },
        });
        logger.log('Swagger docs available at /api/docs');
    }

    // ── Graceful shutdown ────────────────────────────────────────────
    app.enableShutdownHooks();

    const port = parseInt(process.env.PORT ?? '4000', 10);
    await app.listen(port, '0.0.0.0');
    logger.log(`Backend running on port ${port} [${process.env.NODE_ENV ?? 'development'}]`);

    const handleShutdown = async (signal: string) => {
        logger.log(`Received ${signal} — starting graceful shutdown`);
        // Give in-flight requests 10 s to complete before hard exit
        const forceExit = setTimeout(() => {
            logger.log('Graceful shutdown timeout — forcing exit');
            process.exit(1);
        }, 10_000);
        forceExit.unref(); // don't keep event loop alive just for this timer
        try {
            await app.close();
            logger.log('Server closed');
        } catch (e: any) {
            logger.error(`Error during shutdown: ${e.message}`);
        }
        process.exit(0);
    };

    process.on('SIGTERM', () => handleShutdown('SIGTERM'));
    process.on('SIGINT',  () => handleShutdown('SIGINT'));
}

bootstrap().catch(err => {
    console.error('Bootstrap failed:', err);
    process.exit(1);
});
