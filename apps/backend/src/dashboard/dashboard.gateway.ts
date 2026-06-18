import {
    WebSocketGateway,
    WebSocketServer,
    OnGatewayConnection,
    OnGatewayDisconnect,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { Logger } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { ConfigService } from '@nestjs/config';

const wsOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);

@WebSocketGateway({
    cors: {
        origin:      wsOrigins.length > 0 ? wsOrigins : false,
        credentials: true,
    },
    namespace:       '/dashboard',
    transports:      ['websocket', 'polling'],
    pingTimeout:     60_000,
    pingInterval:    25_000,
})
export class DashboardGateway implements OnGatewayConnection, OnGatewayDisconnect {
    @WebSocketServer()
    server: Server;

    private readonly logger = new Logger(DashboardGateway.name);

    constructor(private jwt: JwtService, private config: ConfigService) {}

    async handleConnection(client: Socket) {
        try {
            const token = client.handshake.auth?.token as string
                ?? client.handshake.headers.authorization?.replace('Bearer ', '');

            if (!token) {
                client.disconnect();
                return;
            }

            const payload = this.jwt.verify(token, {
                secret: this.config.get<string>('JWT_SECRET'),
            });

            client.data.user = payload;
            client.join(`company:${payload.companyId}`);
            client.join(`user:${payload.sub}`);
            this.logger.log(`WS client ${client.id} connected (company ${payload.companyId})`);
        } catch {
            client.disconnect();
        }
    }

    handleDisconnect(client: Socket) {
        this.logger.log(`WS client ${client.id} disconnected`);
    }

    broadcast(event: string, data: unknown) {
        this.server?.emit(event, data);
    }

    broadcastToCompany(companyId: string, event: string, data: unknown) {
        this.server?.to(`company:${companyId}`).emit(event, data);
    }

    notifyUser(userId: string, event: string, data: unknown) {
        this.server?.to(`user:${userId}`).emit(event, data);
    }
}
