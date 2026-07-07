import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { BullModule } from '@nestjs/bullmq';
import { LoggerModule } from 'nestjs-pino';
import * as Joi from 'joi';

import { PrismaModule } from './prisma/prisma.module';
import { RequestIdMiddleware } from './common/middleware/request-id.middleware';
import { HealthModule } from './health/health.module';
import { AuthModule } from './auth/auth.module';
import { CompaniesModule } from './companies/companies.module';
import { UsersModule } from './users/users.module';
import { StationsModule } from './stations/stations.module';
import { SyncModule } from './sync/sync.module';
import { TransactionsModule } from './transactions/transactions.module';
import { ShiftsModule } from './shifts/shifts.module';
import { ReservoirsModule } from './reservoirs/reservoirs.module';
import { ReportsModule } from './reports/reports.module';
import { DashboardModule } from './dashboard/dashboard.module';
import { NotificationsModule } from './notifications/notifications.module';
import { AuditModule } from './audit/audit.module';
import { ExportModule } from './export/export.module';
import { PricesModule } from './prices/prices.module';
import { AlertRulesModule } from './alert-rules/alert-rules.module';
import { OilBasesModule } from './oil-bases/oil-bases.module';
import { IntegrationsModule } from './integrations/integrations.module';
import { IntegrationApiModule } from './integration-api/integration-api.module';
import { MaintenanceModule } from './maintenance/maintenance.module';

@Module({
    imports: [
        ConfigModule.forRoot({
            isGlobal: true,
            validationSchema: Joi.object({
                NODE_ENV:               Joi.string().valid('development', 'production', 'test').default('production'),
                PORT:                   Joi.number().default(4000),
                DATABASE_URL:           Joi.string().required(),
                REDIS_URL:              Joi.string().required(),
                JWT_SECRET:             Joi.string().min(32).required(),
                JWT_EXPIRES_IN:         Joi.string().default('15m'),
                JWT_REFRESH_SECRET:     Joi.string().min(32).required(),
                JWT_REFRESH_EXPIRES_IN: Joi.string().default('30d'),
                LOG_LEVEL:              Joi.string().valid('fatal', 'error', 'warn', 'info', 'debug', 'trace').default('info'),
                BCRYPT_ROUNDS:          Joi.number().default(12),
                MAX_LOGIN_ATTEMPTS:     Joi.number().default(5),
                LOGIN_LOCKOUT_MINUTES:  Joi.number().default(15),
                // Optional — validated loosely so they never block startup
                CORS_ORIGINS:           Joi.string().allow('').default(''),
                SWAGGER_ENABLED:        Joi.string().valid('true', 'false').default('false'),
                TRANSACTION_RETENTION_DAYS:     Joi.number().default(1825),
                ATG_READINGS_RAW_RETENTION_DAYS: Joi.number().default(90),
                HEALTH_EVENTS_RETENTION_DAYS:   Joi.number().default(30),
                AUDIT_LOG_RETENTION_DAYS:       Joi.number().default(365),
                SYNC_LAG_ALERT_MINUTES:         Joi.number().default(30),
            }),
        }),

        LoggerModule.forRoot({
            pinoHttp: {
                transport: process.env.NODE_ENV !== 'production'
                    ? { target: 'pino-pretty' }
                    : undefined,
                level: process.env.NODE_ENV !== 'production' ? 'debug' : process.env.LOG_LEVEL ?? 'info',
                autoLogging: { ignore: (req) => req.url === '/api/health' },
                redact: ['req.headers.authorization', 'req.headers["x-api-key"]', 'req.headers["x-api-token"]'],
            },
        }),

        BullModule.forRootAsync({
            imports: [ConfigModule],
            useFactory: (config: ConfigService) => ({
                connection: { url: config.get<string>('REDIS_URL') },
            }),
            inject: [ConfigService],
        }),

        ScheduleModule.forRoot(),
        PrismaModule,
        HealthModule,
        AuthModule,
        CompaniesModule,
        UsersModule,
        StationsModule,
        SyncModule,
        TransactionsModule,
        ShiftsModule,
        ReservoirsModule,
        ReportsModule,
        DashboardModule,
        NotificationsModule,
        AuditModule,
        ExportModule,
        PricesModule,
        AlertRulesModule,
        OilBasesModule,
        IntegrationsModule,
        IntegrationApiModule,
        MaintenanceModule,
    ],
})
export class AppModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
        consumer.apply(RequestIdMiddleware).forRoutes('*');
    }
}
