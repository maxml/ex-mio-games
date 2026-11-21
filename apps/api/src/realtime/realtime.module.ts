import { type DynamicModule, Module } from '@nestjs/common';
import { NotificationsGateway } from './notifications.gateway';
import { REALTIME_AUTH, type RealtimeAuthService } from './tokens';

/**
 * Colocated realtime module (ADR 0003). `register` binds the gateway's auth
 * port to the already-wired `AuthService` so the handshake reuses the HTTP
 * layer's facade. Imported into the app module only when realtime is enabled.
 */
@Module({})
export class RealtimeModule {
  static register(auth: RealtimeAuthService): DynamicModule {
    return {
      module: RealtimeModule,
      providers: [{ provide: REALTIME_AUTH, useValue: auth }, NotificationsGateway],
      exports: [NotificationsGateway],
    };
  }
}
