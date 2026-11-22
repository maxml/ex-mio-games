import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import {
  REALTIME_OPTIONS,
  RealtimeGateway,
  TICKET_REDEEMER,
  type RealtimeOptions,
} from './realtime.gateway';
import type { TicketRedeemer } from './ticket-redeemer';

@Module({})
export class RealtimeModule {
  /** Call once and reuse the returned module (it is imported by the bus handler's module list too). */
  static register(options: { redeemer: TicketRedeemer } & RealtimeOptions): DynamicModule {
    const { redeemer, ...rest } = options;
    const providers: Provider[] = [
      { provide: TICKET_REDEEMER, useValue: redeemer },
      { provide: REALTIME_OPTIONS, useValue: rest },
      RealtimeGateway,
    ];
    return { module: RealtimeModule, providers, exports: [RealtimeGateway] };
  }
}
