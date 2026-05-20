# AZS Manager — Backend Server Build Document

You are building the AZS Manager backend server from scratch.
There is no existing backend code. Read the entire document before writing any code.

---

## What this server does

Central management server for UNG fuel station network (6 stations).
Each station has a desktop app (Tauri + Rust) that runs fully offline.
This backend aggregates data from all stations, provides central management,
and serves a web dashboard for managers.

The stations work completely without this server.
This server is for reporting, remote management, and cross-station visibility.

---

## Technology stack

| Layer | Technology |
|---|---|
| Framework | NestJS 10, TypeScript |
| Database | PostgreSQL 15 + TimescaleDB 2.x |
| ORM | Prisma 5 |
| Cache | Redis 7 |
| Job queue | BullMQ (Redis-backed) |
| Auth | JWT (access + refresh tokens), bcrypt |
| Validation | class-validator + class-transformer |
| Logging | Pino (JSON structured logs) |
| Docs | @nestjs/swagger (OpenAPI 3) |
| Notifications | Telegraf (Telegram bot) |
| Email | Nodemailer |
| File export | ExcelJS (xlsx), csv-stringify |
| Config | @nestjs/config + Joi validation |
| Testing | Jest + Supertest |

---

## Project structure

```
apps/backend/
├── src/
│   ├── main.ts                        ← bootstrap, graceful shutdown
│   ├── app.module.ts
│   ├── common/
│   │   ├── decorators/
│   │   │   ├── current-user.decorator.ts
│   │   │   └── roles.decorator.ts
│   │   ├── filters/
│   │   │   └── global-exception.filter.ts
│   │   ├── guards/
│   │   │   ├── jwt-auth.guard.ts
│   │   │   ├── roles.guard.ts
│   │   │   └── station-api-key.guard.ts
│   │   ├── interceptors/
│   │   │   ├── logging.interceptor.ts
│   │   │   └── transform.interceptor.ts
│   │   ├── pipes/
│   │   │   └── validation.pipe.ts
│   │   ├── middleware/
│   │   │   └── request-id.middleware.ts
│   │   └── dto/
│   │       └── pagination.dto.ts
│   │
│   ├── auth/
│   │   ├── auth.module.ts
│   │   ├── auth.controller.ts
│   │   ├── auth.service.ts
│   │   ├── strategies/
│   │   │   ├── jwt.strategy.ts
│   │   │   └── jwt-refresh.strategy.ts
│   │   └── dto/
│   │       ├── login.dto.ts
│   │       └── refresh.dto.ts
│   │
│   ├── users/
│   │   ├── users.module.ts
│   │   ├── users.controller.ts
│   │   ├── users.service.ts
│   │   └── dto/
│   │
│   ├── companies/
│   │   ├── companies.module.ts
│   │   ├── companies.controller.ts
│   │   └── companies.service.ts
│   │
│   ├── stations/
│   │   ├── stations.module.ts
│   │   ├── stations.controller.ts
│   │   ├── stations.service.ts
│   │   └── dto/
│   │
│   ├── sync/
│   │   ├── sync.module.ts
│   │   ├── sync.controller.ts     ← receives data from desktop apps
│   │   ├── sync.service.ts
│   │   └── dto/
│   │       └── sync-batch.dto.ts
│   │
│   ├── transactions/
│   │   ├── transactions.module.ts
│   │   ├── transactions.controller.ts
│   │   ├── transactions.service.ts
│   │   └── dto/
│   │
│   ├── shifts/
│   │   ├── shifts.module.ts
│   │   ├── shifts.controller.ts
│   │   └── shifts.service.ts
│   │
│   ├── reservoirs/
│   │   ├── reservoirs.module.ts
│   │   ├── reservoirs.controller.ts
│   │   └── reservoirs.service.ts
│   │
│   ├── prices/
│   │   ├── prices.module.ts
│   │   ├── prices.controller.ts
│   │   └── prices.service.ts
│   │
│   ├── reports/
│   │   ├── reports.module.ts
│   │   ├── reports.controller.ts
│   │   ├── reports.service.ts
│   │   └── reports.jobs.ts        ← BullMQ jobs for heavy reports
│   │
│   ├── dashboard/
│   │   ├── dashboard.module.ts
│   │   ├── dashboard.controller.ts
│   │   ├── dashboard.gateway.ts   ← WebSocket real-time updates
│   │   └── dashboard.service.ts
│   │
│   ├── notifications/
│   │   ├── notifications.module.ts
│   │   ├── telegram.service.ts
│   │   ├── email.service.ts
│   │   └── alerts.service.ts      ← monitors thresholds, triggers notifications
│   │
│   ├── audit/
│   │   ├── audit.module.ts
│   │   └── audit.service.ts
│   │
│   ├── health/
│   │   ├── health.module.ts
│   │   └── health.controller.ts
│   │
│   └── export/
│       ├── export.module.ts
│       ├── export.controller.ts
│       └── export.service.ts      ← xlsx, csv, 1C format
│
├── prisma/
│   ├── schema.prisma
│   └── migrations/
│
├── test/
│   ├── auth.e2e-spec.ts
│   ├── sync.e2e-spec.ts
│   └── reports.e2e-spec.ts
│
├── .env.example
├── .env
├── docker-compose.yml
├── Dockerfile
└── package.json
```

---

## Environment variables — .env.example

```env
# App
NODE_ENV=production
PORT=4000
API_VERSION=v1

# Database
DATABASE_URL=postgresql://azs:password@localhost:5432/azs_manager

# Redis
REDIS_URL=redis://localhost:6379

# JWT
JWT_SECRET=<random-64-char-string>
JWT_EXPIRES_IN=15m
JWT_REFRESH_SECRET=<random-64-char-string>
JWT_REFRESH_EXPIRES_IN=30d

# Security
BCRYPT_ROUNDS=12
MAX_LOGIN_ATTEMPTS=5
LOGIN_LOCKOUT_MINUTES=15

# CORS
CORS_ORIGINS=http://localhost:3000,https://azs.ung.uz

# Telegram notifications (optional)
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_IDS=          # comma-separated chat IDs for alerts

# Email (optional)
SMTP_HOST=
SMTP_PORT=587
SMTP_USER=
SMTP_PASS=
SMTP_FROM=noreply@ung.uz

# Retention
TRANSACTION_RETENTION_DAYS=1825    # 5 years
ATG_READINGS_RAW_RETENTION_DAYS=90
HEALTH_EVENTS_RETENTION_DAYS=30

# Backup
BACKUP_ENABLED=true
BACKUP_CRON=0 2 * * *              # 2 AM daily
BACKUP_PATH=/backups
BACKUP_S3_BUCKET=                  # optional S3

# Sync
SYNC_LAG_ALERT_MINUTES=30          # alert if station hasn't synced in 30 min

# Superadmin seed (first run only)
SEED_ADMIN_EMAIL=admin@ung.uz
SEED_ADMIN_PASSWORD=               # set strong password, change after first login
```

---

## Prisma schema — full

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

generator client {
  provider = "prisma-client-js"
}

// ── Multi-company ─────────────────────────────────────────────

model Company {
  id        String   @id @default(uuid())
  name      String
  slug      String   @unique   // "ung", "other-company"
  active    Boolean  @default(true)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  deletedAt DateTime?           // soft delete

  users    User[]
  stations Station[]
}

// ── Users ─────────────────────────────────────────────────────

model User {
  id              String    @id @default(uuid())
  companyId       String
  email           String
  name            String
  passwordHash    String
  role            UserRole
  active          Boolean   @default(true)
  twoFactorSecret String?
  twoFactorEnabled Boolean  @default(false)
  lastLoginAt     DateTime?
  passwordChangedAt DateTime?
  loginAttempts   Int       @default(0)
  lockedUntil     DateTime?
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  deletedAt       DateTime?             // soft delete

  company        Company         @relation(fields: [companyId], references: [id])
  stationAccess  StationAccess[]
  sessions       Session[]
  auditLogs      AuditLog[]
  passwordHistory PasswordHistory[]

  @@unique([companyId, email])
}

enum UserRole {
  SUPER_ADMIN
  COMPANY_ADMIN
  STATION_MANAGER
  ACCOUNTANT
}

model PasswordHistory {
  id           String   @id @default(uuid())
  userId       String
  passwordHash String
  createdAt    DateTime @default(now())
  user         User     @relation(fields: [userId], references: [id])
}

model Session {
  id           String   @id @default(uuid())
  userId       String
  refreshToken String   @unique
  userAgent    String?
  ipAddress    String?
  expiresAt    DateTime
  createdAt    DateTime @default(now())
  lastUsedAt   DateTime @default(now())
  user         User     @relation(fields: [userId], references: [id])
}

model StationAccess {
  userId    String
  stationId String
  user      User    @relation(fields: [userId], references: [id])
  station   Station @relation(fields: [stationId], references: [id])

  @@id([userId, stationId])
}

// ── Stations ──────────────────────────────────────────────────

model Station {
  id              String    @id     // matches site.config.json site.id
  companyId       String
  name            String
  address         String?
  timezone        String    @default("Asia/Tashkent")
  apiKey          String    @unique @default(uuid())
  active          Boolean   @default(true)
  ipAllowlist     String[]  // empty = allow all IPs
  lastSyncAt      DateTime?
  lastSeenAt      DateTime?
  syncLagAlerted  Boolean   @default(false)
  createdAt       DateTime  @default(now())
  updatedAt       DateTime  @updatedAt
  deletedAt       DateTime?

  company        Company              @relation(fields: [companyId], references: [id])
  positions      FuelingPosition[]
  transactions   Transaction[]
  shifts         Shift[]
  reservoirs     Reservoir[]
  priceSettings  PriceSetting[]
  healthEvents   StationHealthEvent[]
  uptimeHistory  StationUptimeEvent[]
  userAccess     StationAccess[]
  alertRules     AlertRule[]
}

model StationUptimeEvent {
  id         String   @id @default(uuid())
  stationId  String
  event      String   // 'online' | 'offline'
  occurredAt DateTime
  station    Station  @relation(fields: [stationId], references: [id])
}

model FuelingPosition {
  id          String  @id
  stationId   String
  label       String
  addressByte Int
  active      Boolean @default(true)
  deletedAt   DateTime?
  station     Station @relation(fields: [stationId], references: [id])
  nozzles     Nozzle[]
}

model Nozzle {
  positionId  String
  index       Int
  productId   Int
  productName String
  active      Boolean  @default(true)
  position    FuelingPosition @relation(fields: [positionId], references: [id])

  @@id([positionId, index])
}

// ── Transactions — TimescaleDB hypertable on startedAt ────────

model Transaction {
  id             String    @id
  companyId      String
  stationId      String
  fpId           String
  label          String
  addressByte    Int
  startedAt      DateTime
  completedAt    DateTime?
  volume         Float     @default(0)
  amount         BigInt    @default(0)
  price          Int       @default(0)
  nozzleIndex    Int
  productId      Int
  productName    String
  status         TxStatus
  parentTxId     String?
  combinedVolume Float?
  combinedAmount BigInt?
  shiftId        String?
  operatorName   String?
  syncedAt       DateTime  @default(now())
  deletedAt      DateTime?

  station Station @relation(fields: [stationId], references: [id])

  @@index([stationId, startedAt])
  @@index([companyId, startedAt])
  @@index([stationId, productId, startedAt])
}

enum TxStatus {
  COMPLETED
  STOPPED
  ABORTED
}

// ── Shifts ────────────────────────────────────────────────────

model Shift {
  id                String      @id
  companyId         String
  stationId         String
  operatorName      String
  shiftName         String?
  scheduledStart    String?
  scheduledEnd      String?
  startedAt         DateTime
  endedAt           DateTime?
  totalTransactions Int         @default(0)
  totalVolume       Float       @default(0)
  totalAmount       BigInt      @default(0)
  status            ShiftStatus
  notes             String?
  syncedAt          DateTime    @default(now())
  deletedAt         DateTime?

  station        Station              @relation(fields: [stationId], references: [id])
  positionTotals ShiftPositionTotal[]
}

enum ShiftStatus { ACTIVE CLOSED }

model ShiftPositionTotal {
  id                String @id @default(uuid())
  shiftId           String
  fpId              String
  label             String
  transactionsCount Int    @default(0)
  totalVolume       Float  @default(0)
  totalAmount       BigInt @default(0)
  shift             Shift  @relation(fields: [shiftId], references: [id])
}

// ── Reservoirs — TimescaleDB hypertable on readingAt ──────────

model Reservoir {
  id          String    @id @default(uuid())
  stationId   String
  tankId      String
  label       String
  productId   Int
  productName String
  capacity    Float
  active      Boolean   @default(true)
  deletedAt   DateTime?
  station     Station   @relation(fields: [stationId], references: [id])
  readings    ReservoirReading[]

  @@unique([stationId, tankId])
}

model ReservoirReading {
  id            String    @id @default(uuid())
  reservoirId   String
  stationId     String
  companyId     String
  readingAt     DateTime
  volumeLitres  Float
  levelMm       Float?
  temperatureC  Float?
  waterMm       Float?
  fillPercent   Float?
  syncedAt      DateTime  @default(now())
  reservoir     Reservoir @relation(fields: [reservoirId], references: [id])

  @@index([stationId, readingAt])
}

// ── Prices ────────────────────────────────────────────────────

model PriceSetting {
  stationId   String
  fpId        String
  nozzleIndex Int
  productId   Int
  productName String
  price       Int
  updatedAt   DateTime @default(now())
  updatedBy   String
  station     Station  @relation(fields: [stationId], references: [id])

  @@id([stationId, fpId, nozzleIndex])
}

model PriceChangeLog {
  id          String   @id @default(uuid())
  companyId   String
  stationId   String
  fpId        String
  nozzleIndex Int
  productName String
  oldPrice    Int
  newPrice    Int
  changedAt   DateTime @default(now())
  changedBy   String
  source      String   // 'server' | 'station'
}

// ── Station health ────────────────────────────────────────────

model StationHealthEvent {
  id         String   @id @default(uuid())
  stationId  String
  companyId  String
  eventType  String
  fpId       String?
  detail     String?
  occurredAt DateTime
  syncedAt   DateTime @default(now())
  station    Station  @relation(fields: [stationId], references: [id])
}

// ── Audit log ─────────────────────────────────────────────────

model AuditLog {
  id        String   @id @default(uuid())
  companyId String
  userId    String?
  userEmail String?
  action    String
  entity    String
  entityId  String?
  oldValue  Json?
  newValue  Json?
  ipAddress String?
  requestId String?
  createdAt DateTime @default(now())
  user      User?    @relation(fields: [userId], references: [id])
}

// ── Alert rules ───────────────────────────────────────────────

model AlertRule {
  id           String   @id @default(uuid())
  stationId    String?  // null = all stations in company
  companyId    String
  type         String   // 'tank_low' | 'dispenser_offline' | 'station_offline' | 'sync_lag'
  threshold    Float?   // percentage for tank_low, minutes for offline
  enabled      Boolean  @default(true)
  notifyTelegram Boolean @default(true)
  notifyEmail  Boolean  @default(false)
  createdAt    DateTime @default(now())
  station      Station? @relation(fields: [stationId], references: [id])
}
```

---

## main.ts — bootstrap with graceful shutdown

```typescript
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { ValidationPipe, VersioningType } from '@nestjs/common';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import { Logger } from 'nestjs-pino';

async function bootstrap() {
    const app = await NestFactory.create(AppModule, { bufferLogs: true });

    // structured logging
    app.useLogger(app.get(Logger));

    // global prefix and versioning
    app.setGlobalPrefix('api');
    app.enableVersioning({
        type: VersioningType.URI,
        defaultVersion: '1',
    });

    // validation
    app.useGlobalPipes(new ValidationPipe({
        whitelist:        true,
        forbidNonWhitelisted: true,
        transform:        true,
        transformOptions: { enableImplicitConversion: true },
    }));

    // CORS
    app.enableCors({
        origin:      process.env.CORS_ORIGINS?.split(',') ?? [],
        credentials: true,
    });

    // Swagger
    const config = new DocumentBuilder()
        .setTitle('AZS Manager API')
        .setVersion('1.0')
        .addBearerAuth()
        .addApiKey({ type: 'apiKey', in: 'header', name: 'X-Api-Key' }, 'station-key')
        .build();
    const document = SwaggerModule.createDocument(app, config);
    SwaggerModule.setup('api/docs', app, document);

    // graceful shutdown
    app.enableShutdownHooks();
    const server = await app.listen(process.env.PORT ?? 4000);

    // signal handlers
    const shutdown = async (signal: string) => {
        console.log(`Received ${signal} — shutting down gracefully`);
        await app.close();
        server.close(() => process.exit(0));
        // force exit after 10 seconds
        setTimeout(() => process.exit(1), 10_000);
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT',  () => shutdown('SIGINT'));

    console.log(`AZS Manager backend running on port ${process.env.PORT ?? 4000}`);
    console.log(`Swagger docs: http://localhost:${process.env.PORT ?? 4000}/api/docs`);
}
bootstrap();
```

---

## Common infrastructure

### Request ID middleware

```typescript
// src/common/middleware/request-id.middleware.ts
import { v4 as uuidv4 } from 'uuid';
import { Injectable, NestMiddleware } from '@nestjs/common';

@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
    use(req: any, res: any, next: () => void) {
        req.requestId = req.headers['x-request-id'] || uuidv4();
        res.setHeader('X-Request-Id', req.requestId);
        next();
    }
}
```

### Global exception filter

```typescript
// src/common/filters/global-exception.filter.ts
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
    catch(exception: unknown, host: ArgumentsHost) {
        const ctx    = host.switchToHttp();
        const res    = ctx.getResponse<Response>();
        const req    = ctx.getRequest<Request>();
        const status = exception instanceof HttpException
            ? exception.getStatus()
            : HttpStatus.INTERNAL_SERVER_ERROR;

        const message = exception instanceof HttpException
            ? exception.message
            : 'Internal server error';

        // never expose stack in production
        res.status(status).json({
            statusCode: status,
            error:      getErrorCode(status),
            message,
            requestId:  (req as any).requestId,
            timestamp:  new Date().toISOString(),
        });
    }
}
```

### Transform interceptor — consistent response format

```typescript
// Wraps all responses in: { data: ..., meta: { requestId, timestamp } }
@Injectable()
export class TransformInterceptor<T>
    implements NestInterceptor<T, ApiResponse<T>> {
    intercept(context: ExecutionContext, next: CallHandler) {
        const req = context.switchToHttp().getRequest();
        return next.handle().pipe(
            map(data => ({
                data,
                meta: {
                    requestId: req.requestId,
                    timestamp: new Date().toISOString(),
                }
            }))
        );
    }
}
```

### Pagination DTO

```typescript
// src/common/dto/pagination.dto.ts
export class PaginationDto {
    @IsOptional() @IsInt() @Min(1)
    @Type(() => Number)
    page?: number = 1;

    @IsOptional() @IsInt() @Min(1) @Max(100)
    @Type(() => Number)
    limit?: number = 50;

    get skip() { return ((this.page ?? 1) - 1) * (this.limit ?? 50); }
}

export class PaginatedResponse<T> {
    data:  T[];
    total: number;
    page:  number;
    limit: number;
    pages: number;

    static of<T>(data: T[], total: number, dto: PaginationDto) {
        const r  = new PaginatedResponse<T>();
        r.data   = data;
        r.total  = total;
        r.page   = dto.page ?? 1;
        r.limit  = dto.limit ?? 50;
        r.pages  = Math.ceil(total / (dto.limit ?? 50));
        return r;
    }
}
```

---

## Auth module

```typescript
// POST /api/v1/auth/login
export class LoginDto {
    @IsEmail()
    email: string;

    @IsString() @MinLength(8)
    password: string;

    @IsOptional() @IsString()
    totpCode?: string;   // required if 2FA enabled
}

// POST /api/v1/auth/refresh
// POST /api/v1/auth/logout
// POST /api/v1/auth/logout-all         revoke all sessions for user
// GET  /api/v1/auth/sessions           list active sessions
// DELETE /api/v1/auth/sessions/:id     revoke specific session
// GET  /api/v1/auth/me
// POST /api/v1/auth/change-password
// POST /api/v1/auth/setup-2fa          returns QR code
// POST /api/v1/auth/confirm-2fa        confirm TOTP setup
// DELETE /api/v1/auth/disable-2fa

// Auth service — login with brute force protection
async login(email: string, password: string, ip: string) {
    const user = await this.prisma.user.findFirst({
        where: { email, deletedAt: null }
    });

    // account locked?
    if (user?.lockedUntil && user.lockedUntil > new Date()) {
        throw new UnauthorizedException('Account locked — too many failed attempts');
    }

    if (!user || !await bcrypt.compare(password, user.passwordHash)) {
        if (user) {
            const attempts = user.loginAttempts + 1;
            const locked   = attempts >= parseInt(process.env.MAX_LOGIN_ATTEMPTS ?? '5');
            await this.prisma.user.update({
                where: { id: user.id },
                data: {
                    loginAttempts: attempts,
                    lockedUntil: locked
                        ? new Date(Date.now() + parseInt(process.env.LOGIN_LOCKOUT_MINUTES ?? '15') * 60_000)
                        : undefined,
                }
            });
        }
        throw new UnauthorizedException('Invalid credentials');
    }

    // reset attempts on success
    await this.prisma.user.update({
        where: { id: user.id },
        data: { loginAttempts: 0, lockedUntil: null, lastLoginAt: new Date() }
    });

    // check password policy — force change if expired
    const passwordAgeDays = (Date.now() - (user.passwordChangedAt?.getTime() ?? 0)) / 86_400_000;
    if (passwordAgeDays > 90) {
        return { requirePasswordChange: true, userId: user.id };
    }

    return this.issueTokens(user, ip);
}

// Password policy enforcement
async changePassword(userId: string, currentPw: string, newPw: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });

    if (!await bcrypt.compare(currentPw, user.passwordHash)) {
        throw new UnauthorizedException('Current password is incorrect');
    }

    // check password history (last 5)
    const history = await this.prisma.passwordHistory.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        take: 5,
    });
    for (const h of history) {
        if (await bcrypt.compare(newPw, h.passwordHash)) {
            throw new BadRequestException('Cannot reuse one of your last 5 passwords');
        }
    }

    // enforce complexity: min 8 chars, uppercase, lowercase, number
    if (!/(?=.*[a-z])(?=.*[A-Z])(?=.*\d).{8,}/.test(newPw)) {
        throw new BadRequestException(
            'Password must be at least 8 characters with uppercase, lowercase, and a number'
        );
    }

    const hash = await bcrypt.hash(newPw, parseInt(process.env.BCRYPT_ROUNDS ?? '12'));

    await this.prisma.$transaction([
        this.prisma.user.update({
            where: { id: userId },
            data: { passwordHash: hash, passwordChangedAt: new Date() }
        }),
        this.prisma.passwordHistory.create({
            data: { userId, passwordHash: hash }
        }),
    ]);
}
```

---

## Sync module — receives data from desktop apps

```typescript
// POST /api/v1/sync/:stationId
// Header: X-Api-Key <key>
// No JWT needed — uses station API key

export class SyncBatchDto {
    @IsArray()
    @ValidateNested({ each: true })
    @Type(() => SyncRecordDto)
    records: SyncRecordDto[];
}

export class SyncRecordDto {
    @IsUUID()     id:          string;
    @IsString()   entity_type: string;
    @IsString()   entity_id:   string;
    @IsObject()   payload:     Record<string, unknown>;
    @IsNumber()   created_at:  number;
}

// Sync service — idempotent, handles all entity types
async processBatch(stationId: string, dto: SyncBatchDto, ipAddress: string) {
    const station = await this.validateStation(stationId, ipAddress);
    const accepted: string[] = [];

    for (const record of dto.records) {
        try {
            // idempotency — skip if already processed
            const exists = await this.prisma.processedSyncRecord.findUnique({
                where: { id: record.id }
            });
            if (exists) { accepted.push(record.id); continue; }

            await this.processRecord(station, record);
            await this.prisma.processedSyncRecord.create({
                data: { id: record.id, processedAt: new Date() }
            });
            accepted.push(record.id);
        } catch (e) {
            // log error but continue processing other records
            this.logger.error(`Failed to process record ${record.id}: ${e.message}`);
        }
    }

    // update station last sync time
    await this.prisma.station.update({
        where: { id: stationId },
        data:  { lastSyncAt: new Date(), lastSeenAt: new Date(), syncLagAlerted: false }
    });

    return { accepted };
}

private async processRecord(station: Station, record: SyncRecordDto) {
    switch (record.entity_type) {
        case 'transaction':     return this.upsertTransaction(station, record.payload);
        case 'shift':           return this.upsertShift(station, record.payload);
        case 'reservoir_reading': return this.upsertReservoirReading(station, record.payload);
        case 'price_change':    return this.recordPriceChange(station, record.payload);
        case 'health_event':    return this.recordHealthEvent(station, record.payload);
        default:
            this.logger.warn(`Unknown entity_type: ${record.entity_type}`);
    }
}
```

---

## Stations module — IP allowlist and uptime tracking

```typescript
// station-api-key.guard.ts — validates station key and optional IP
@Injectable()
export class StationApiKeyGuard implements CanActivate {
    async canActivate(ctx: ExecutionContext): Promise<boolean> {
        const req       = ctx.switchToHttp().getRequest();
        const apiKey    = req.headers['x-api-key'];
        const stationId = req.params.stationId;
        const ipAddress = req.ip;

        const station = await this.prisma.station.findFirst({
            where: { id: stationId, apiKey, active: true, deletedAt: null }
        });
        if (!station) return false;

        // IP allowlist check (if configured)
        if (station.ipAllowlist.length > 0) {
            if (!station.ipAllowlist.includes(ipAddress)) {
                this.logger.warn(
                    `Station ${stationId} rejected from IP ${ipAddress}`
                );
                return false;
            }
        }

        req.station = station;
        return true;
    }
}

// Uptime tracking — called when station comes online/goes offline
async recordUptimeEvent(stationId: string, event: 'online' | 'offline') {
    await this.prisma.stationUptimeEvent.create({
        data: { stationId, event, occurredAt: new Date() }
    });

    if (event === 'online') {
        await this.notifications.sendAlert(stationId, {
            type: 'station_online',
            message: `Station ${stationId} is back online`,
        });
    }
}

// Sync lag monitoring — runs every 5 minutes via cron
@Cron('*/5 * * * *')
async checkSyncLag() {
    const lagMinutes = parseInt(process.env.SYNC_LAG_ALERT_MINUTES ?? '30');
    const cutoff     = new Date(Date.now() - lagMinutes * 60_000);

    const lagging = await this.prisma.station.findMany({
        where: {
            active:       true,
            deletedAt:    null,
            lastSyncAt:   { lt: cutoff },
            syncLagAlerted: false,
        }
    });

    for (const station of lagging) {
        await this.notifications.sendAlert(station.id, {
            type:    'sync_lag',
            message: `Station ${station.name} hasn't synced in ${lagMinutes}+ minutes`,
        });
        await this.prisma.station.update({
            where: { id: station.id },
            data:  { syncLagAlerted: true }
        });
    }
}
```

---

## Reports module — with caching and background jobs

```typescript
// GET /api/v1/reports/summary
// GET /api/v1/reports/revenue?groupBy=day|week|month
// GET /api/v1/reports/operators
// GET /api/v1/reports/products
// GET /api/v1/reports/shifts
// GET /api/v1/reports/tanks
// GET /api/v1/export/transactions?format=csv|xlsx|1c

// Heavy reports run as BullMQ jobs
@Injectable()
export class ReportsService {
    constructor(
        @InjectQueue('reports') private reportsQueue: Queue,
        private cache: CacheService,
        private prisma: PrismaService,
    ) {}

    async getRevenueSummary(
        companyId:  string,
        stationIds: string[],
        from:       Date,
        to:         Date,
        groupBy:    'day' | 'week' | 'month',
    ) {
        const cacheKey = `revenue:${companyId}:${stationIds.join(',')}:${from.toISOString()}:${groupBy}`;

        return this.cache.getOrSet(cacheKey, 300, async () => {
            // Use TimescaleDB time_bucket for efficient aggregation
            const result = await this.prisma.$queryRaw`
                SELECT
                    time_bucket(${getBucketInterval(groupBy)}, "startedAt") AS period,
                    "stationId",
                    "productName",
                    COUNT(*)::int                                            AS tx_count,
                    SUM(volume)                                              AS total_volume,
                    SUM(amount)                                              AS total_amount
                FROM transactions
                WHERE
                    "companyId" = ${companyId}
                    AND "stationId" = ANY(${stationIds})
                    AND "startedAt" BETWEEN ${from} AND ${to}
                    AND status IN ('COMPLETED', 'STOPPED')
                    AND "deletedAt" IS NULL
                GROUP BY 1, 2, 3
                ORDER BY 1 DESC
            `;
            return result;
        });
    }

    // Large exports run as background jobs
    async requestExport(
        userId:     string,
        companyId:  string,
        params:     ExportParamsDto,
    ) {
        const jobId = await this.reportsQueue.add('export', {
            userId, companyId, params
        });
        return { jobId, message: 'Export started — you will be notified when ready' };
    }
}

// Export processor
@Processor('reports')
export class ReportsProcessor {
    @Process('export')
    async handleExport(job: Job) {
        const { userId, companyId, params } = job.data;

        const data = await this.fetchExportData(companyId, params);

        let buffer: Buffer;
        let filename: string;

        if (params.format === 'xlsx') {
            buffer   = await this.generateXlsx(data, params.type);
            filename = `${params.type}_${Date.now()}.xlsx`;
        } else if (params.format === 'csv') {
            buffer   = await this.generateCsv(data);
            filename = `${params.type}_${Date.now()}.csv`;
        } else if (params.format === '1c') {
            buffer   = await this.generate1C(data);
            filename = `${params.type}_${Date.now()}.xml`;
        }

        // save to temp file, notify user via websocket
        const path = await this.saveExportFile(buffer, filename);
        this.gateway.notifyUser(userId, 'export.ready', { path, filename });
    }
}
```

---

## Notifications module

```typescript
// Telegram alerts
@Injectable()
export class TelegramService {
    private bot: Telegraf;

    constructor(config: ConfigService) {
        const token = config.get('TELEGRAM_BOT_TOKEN');
        if (token) {
            this.bot = new Telegraf(token);
        }
    }

    async send(message: string, chatIds?: string[]) {
        if (!this.bot) return; // Telegram not configured
        const ids = chatIds ?? process.env.TELEGRAM_CHAT_IDS?.split(',') ?? [];
        for (const chatId of ids) {
            await this.bot.telegram.sendMessage(chatId, message, {
                parse_mode: 'HTML'
            }).catch(e => console.error('Telegram error:', e));
        }
    }
}

// Alert rules engine — checks thresholds and sends notifications
@Injectable()
export class AlertsService {
    @Cron('*/10 * * * *')  // every 10 minutes
    async checkAlerts() {
        await this.checkTankLevels();
        await this.checkDispenserOffline();
        await this.checkSyncLag();
    }

    private async checkTankLevels() {
        const latestReadings = await this.prisma.$queryRaw`
            SELECT DISTINCT ON (r.id)
                r.id, r."stationId", res.label, res."productName",
                rr."fillPercent", r."companyId"
            FROM reservoirs r
            JOIN reservoir_readings rr ON rr."reservoirId" = r.id
            WHERE r.active = true AND r."deletedAt" IS NULL
            ORDER BY r.id, rr."readingAt" DESC
        `;
        for (const reading of latestReadings as any[]) {
            const rules = await this.getAlertRules(
                reading.companyId, reading.stationId, 'tank_low'
            );
            for (const rule of rules) {
                if (reading.fillPercent < rule.threshold) {
                    await this.sendAlert(rule, {
                        emoji:   '⚠️',
                        station: reading.stationId,
                        message: `Tank <b>${reading.label}</b> (${reading.productName}) is at ${reading.fillPercent?.toFixed(0)}%`,
                    });
                }
            }
        }
    }
}
```

---

## Data retention — scheduled cleanup

```typescript
@Injectable()
export class RetentionService {
    @Cron('0 3 * * *')  // 3 AM daily
    async runRetention() {
        const now = new Date();

        // soft-delete old health events (keep 30 days)
        await this.prisma.stationHealthEvent.updateMany({
            where: {
                occurredAt: {
                    lt: new Date(now.getTime() - 30 * 86_400_000)
                },
                deletedAt: null,
            },
            data: { /* health events don't have deletedAt — hard delete is ok */ }
        });
        await this.prisma.stationHealthEvent.deleteMany({
            where: { occurredAt: { lt: new Date(now.getTime() - 30 * 86_400_000) } }
        });

        // aggregate old ATG readings (keep 90 days of hourly, then daily only)
        // TimescaleDB compression handles this via compression policy

        // clean expired sessions
        await this.prisma.session.deleteMany({
            where: { expiresAt: { lt: now } }
        });

        // clean processed sync records older than 7 days
        await this.prisma.processedSyncRecord.deleteMany({
            where: { processedAt: { lt: new Date(now.getTime() - 7 * 86_400_000) } }
        });

        this.logger.log('Retention cleanup completed');
    }
}
```

---

## Soft delete pattern — everywhere

Every entity that can be deleted uses soft delete. Never hard delete user-facing data.

```typescript
// prisma middleware — auto-filter soft-deleted records
prisma.$use(async (params, next) => {
    const softDeleteModels = [
        'User', 'Company', 'Station', 'FuelingPosition',
        'Reservoir', 'Transaction', 'Shift',
    ];

    if (softDeleteModels.includes(params.model ?? '')) {
        if (params.action === 'findMany' || params.action === 'findFirst') {
            params.args.where = {
                ...params.args.where,
                deletedAt: null,
            };
        }
        if (params.action === 'delete') {
            params.action   = 'update';
            params.args.data = { deletedAt: new Date() };
        }
        if (params.action === 'deleteMany') {
            params.action   = 'updateMany';
            params.args.data = { deletedAt: new Date() };
        }
    }
    return next(params);
});
```

---

## Automated backup

```typescript
// backup.service.ts — pg_dump on schedule
@Injectable()
export class BackupService {
    @Cron(process.env.BACKUP_CRON ?? '0 2 * * *')
    async runBackup() {
        if (process.env.BACKUP_ENABLED !== 'true') return;

        const filename  = `azs_backup_${format(new Date(), 'yyyyMMdd_HHmmss')}.sql.gz`;
        const localPath = path.join(process.env.BACKUP_PATH ?? '/backups', filename);

        // pg_dump | gzip > file
        await execAsync(
            `pg_dump "${process.env.DATABASE_URL}" | gzip > "${localPath}"`
        );
        this.logger.log(`Backup created: ${localPath}`);

        // upload to S3 if configured
        if (process.env.BACKUP_S3_BUCKET) {
            await this.uploadToS3(localPath, filename);
        }

        // clean local backups older than 7 days
        await this.cleanOldBackups(7);

        // notify admin
        await this.telegram.send(`✅ Database backup completed: ${filename}`);
    }
}
```

---

## TimescaleDB setup — run after migrations

```sql
-- Hypertables for time-series data
SELECT create_hypertable('transactions', 'startedAt',
    chunk_time_interval => INTERVAL '1 month',
    if_not_exists => TRUE);

SELECT create_hypertable('reservoir_readings', 'readingAt',
    chunk_time_interval => INTERVAL '1 week',
    if_not_exists => TRUE);

-- Continuous aggregate for fast daily reports
CREATE MATERIALIZED VIEW transactions_daily
WITH (timescaledb.continuous) AS
SELECT
    time_bucket('1 day', "startedAt")                   AS day,
    "companyId",
    "stationId",
    "productId",
    "productName",
    COUNT(*) FILTER (WHERE status IN ('COMPLETED','STOPPED')) AS tx_count,
    SUM(volume) FILTER (WHERE status IN ('COMPLETED','STOPPED')) AS total_volume,
    SUM(amount) FILTER (WHERE status IN ('COMPLETED','STOPPED')) AS total_amount,
    COUNT(*) FILTER (WHERE status = 'ABORTED')           AS aborted_count
FROM transactions
WHERE "deletedAt" IS NULL
GROUP BY 1, 2, 3, 4, 5;

SELECT add_continuous_aggregate_policy('transactions_daily',
    start_offset       => INTERVAL '3 days',
    end_offset         => INTERVAL '1 hour',
    schedule_interval  => INTERVAL '1 hour');

-- Compress old chunks (saves 90%+ storage)
SELECT add_compression_policy('transactions',     INTERVAL '3 months');
SELECT add_compression_policy('reservoir_readings', INTERVAL '1 month');

-- Retention policy for reservoir readings
-- Keep raw hourly data for 90 days, daily aggregates forever
SELECT add_retention_policy('reservoir_readings', INTERVAL '90 days');
```

---

## API design standards

### All endpoints follow this pattern

```
Base URL:    https://api.ung.uz/api/v1/
Versioning:  URI versioning (/v1/, /v2/ when breaking changes)
Auth:        Bearer JWT for all routes except /health and /sync/:id
Station auth: X-Api-Key header for /sync/* routes
```

### Rate limiting

```typescript
// main.ts — apply rate limiting globally
import rateLimit from 'express-rate-limit';

app.use('/api/v1/auth/login', rateLimit({
    windowMs: 60_000,      // 1 minute
    max:      5,
    message:  { error: 'TOO_MANY_REQUESTS', message: 'Too many login attempts' }
}));

app.use('/api/v1/', rateLimit({
    windowMs: 60_000,
    max:      300,          // 300 requests per minute per IP for all other routes
}));

app.use('/api/v1/sync/', rateLimit({
    windowMs: 60_000,
    max:      200,          // per station per minute
    keyGenerator: (req) => req.headers['x-api-key'] as string,
}));
```

### Consistent error codes

```typescript
export const ErrorCodes = {
    VALIDATION_ERROR:       'VALIDATION_ERROR',
    UNAUTHORIZED:           'UNAUTHORIZED',
    FORBIDDEN:              'FORBIDDEN',
    NOT_FOUND:              'NOT_FOUND',
    CONFLICT:               'CONFLICT',
    TOO_MANY_REQUESTS:      'TOO_MANY_REQUESTS',
    INTERNAL_ERROR:         'INTERNAL_ERROR',
    ACCOUNT_LOCKED:         'ACCOUNT_LOCKED',
    PASSWORD_EXPIRED:       'PASSWORD_EXPIRED',
    INVALID_API_KEY:        'INVALID_API_KEY',
    IP_NOT_ALLOWED:         'IP_NOT_ALLOWED',
    STATION_OFFLINE:        'STATION_OFFLINE',
} as const;

// Error response shape (always):
// { statusCode, error, message, field?, requestId, timestamp }
```

---

## Frontend web dashboard

The web dashboard is a separate React/Next.js app that consumes this API.
These are the requirements the backend must fully support:

**Mobile responsive** — all API responses work identically for mobile. No mobile-specific endpoints.

**Progressive Web App** — backend provides push notification endpoints:
```
POST /api/v1/users/push-subscription    register browser push subscription
DELETE /api/v1/users/push-subscription  unregister
```

**Dark/light theme** — stored server-side per user:
```
PUT /api/v1/users/preferences
body: { theme: 'dark' | 'light', language: 'uz' | 'ru' | 'en', timezone: string }
```

**Localization** — all user-facing strings from API use keys, not hardcoded text. Language is set in user preferences. API response language follows Accept-Language header.

**Real-time stats** — WebSocket gateway broadcasts:
```
station.status_changed     — dispenser online/offline
transaction.completed      — new transaction (any station)
shift.changed              — shift started/ended
tank.updated               — new ATG reading
alert.fired                — threshold triggered
export.ready               — background export finished
```

---

## docker-compose.yml

```yaml
version: '3.9'

services:
  backend:
    build: .
    ports:
      - "4000:4000"
    environment:
      - NODE_ENV=production
    env_file: .env
    depends_on:
      - postgres
      - redis
    restart: unless-stopped
    volumes:
      - ./backups:/backups

  postgres:
    image: timescale/timescaledb:latest-pg15
    environment:
      POSTGRES_DB:       azs_manager
      POSTGRES_USER:     azs
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD}
    volumes:
      - pgdata:/var/lib/postgresql/data
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    restart: unless-stopped
    volumes:
      - redisdata:/data

volumes:
  pgdata:
  redisdata:
```

---

## Build order — implement in this sequence

```
Phase 1 — Foundation
  1.  Project scaffold (NestJS, Prisma, env config, Docker)
  2.  Database schema + migrations + TimescaleDB setup
  3.  Common infrastructure (request ID, exception filter, transform interceptor, pagination)
  4.  Health endpoint (public, no auth)
  5.  Auth module (login, JWT, refresh, sessions, password policy)

Phase 2 — Core data
  6.  Companies module
  7.  Users module (with soft delete, RBAC)
  8.  Stations module (with IP allowlist, uptime tracking)
  9.  Sync endpoint (receive batches from desktop apps)
  10. Transactions module (list, filter, paginate)
  11. Shifts module
  12. Reservoirs module

Phase 3 — Management
  13. Prices module (central price management + sync to stations)
  14. User sync endpoint (stations pull user list)
  15. Audit log module
  16. Soft delete middleware

Phase 4 — Reports
  17. TimescaleDB continuous aggregates
  18. Reports module (summary, revenue, operators, products)
  19. BullMQ jobs for heavy reports
  20. Export service (xlsx, csv, 1C format)

Phase 5 — Operations
  21. Notifications module (Telegram + email)
  22. Alert rules engine
  23. Sync lag monitoring cron
  24. Retention service
  25. Backup service
  26. Rate limiting

Phase 6 — Dashboard
  27. Dashboard WebSocket gateway (real-time events)
  28. Dashboard overview endpoint
  29. Station health history endpoints

Phase 7 — Polish
  30. OpenAPI/Swagger decorators on all controllers
  31. User preferences endpoint (theme, language)
  32. Push notification subscription endpoints
  33. Multi-company isolation testing
  34. Load testing with realistic data volumes
  35. End-to-end tests for sync flow
```

---

## Build checklist before going live

- [ ] All routes require auth except /health and /sync/*
- [ ] Soft delete middleware applied to all models
- [ ] Rate limiting on auth and sync endpoints
- [ ] IP allowlist enforced on sync routes
- [ ] Password policy (complexity, history, expiry) enforced
- [ ] JWT refresh token rotation on each use
- [ ] All sessions invalidated on password change
- [ ] Audit log records price changes, user changes, login events
- [ ] TimescaleDB hypertables and continuous aggregates created
- [ ] Backup cron running and verified
- [ ] Telegram notifications working
- [ ] Sync lag alerting tested
- [ ] Graceful shutdown tested (no in-flight requests lost)
- [ ] Multi-company data isolation verified (company A cannot see company B)
- [ ] Swagger docs generated and accessible
- [ ] All endpoints return consistent error format
- [ ] All list endpoints are paginated

---

*Start with Phase 1, Step 1: scaffold the NestJS project with docker-compose.*