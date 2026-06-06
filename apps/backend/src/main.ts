import { NestFactory } from '@nestjs/core';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';
import rateLimit from 'express-rate-limit';
import { AppModule } from './app.module';

async function bootstrap() {
    const app = await NestFactory.create(AppModule, { bufferLogs: true });

    app.useLogger(app.get(Logger));

    app.setGlobalPrefix('api');
    app.enableVersioning({
        type: VersioningType.URI,
        defaultVersion: '1',
    });

    app.useGlobalPipes(new ValidationPipe({
        whitelist: true,
        forbidNonWhitelisted: true,
        transform: true,
        transformOptions: { enableImplicitConversion: true },
    }));

    app.enableCors({
        origin: process.env.CORS_ORIGINS?.split(',') ?? [],
        credentials: true,
    });

    // rate limiting
    app.use('/api/v1/auth/login', rateLimit({
        windowMs: 60_000,
        max: 5,
        message: { error: 'TOO_MANY_REQUESTS', message: 'Too many login attempts' },
    }));

    app.use('/api/v1/sync/', rateLimit({
        windowMs: 60_000,
        max: 200,
        keyGenerator: (req: any) => req.headers['x-api-key'] as string ?? req.ip,
    }));

    app.use('/api/', rateLimit({
        windowMs: 60_000,
        max: 300,
    }));

    const config = new DocumentBuilder()
        .setTitle('AZS Manager API')
        .setVersion('1.0')
        .addBearerAuth()
        .addApiKey({ type: 'apiKey', in: 'header', name: 'X-Api-Key' }, 'station-key')
        .build();
    SwaggerModule.setup('api/docs', app, SwaggerModule.createDocument(app, config));

    app.enableShutdownHooks();

    const port = process.env.PORT ?? 4000;
    await app.listen(port);

    const shutdown = async (signal: string) => {
        app.get(Logger).log(`Received ${signal} — shutting down`);
        await app.close();
        setTimeout(() => process.exit(1), 10_000);
        process.exit(0);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

    app.get(Logger).log(`Backend running on port ${port}`);
    app.get(Logger).log(`Swagger: http://localhost:${port}/api/docs`);
}

bootstrap();
