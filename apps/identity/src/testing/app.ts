import 'reflect-metadata';
import { Module, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import type { EventEnvelope } from '@ex-mio/contracts';
import { HealthModule, ServiceAuthModule, type AuditPort } from '@ex-mio/service-kit';
import {
  identityControllers,
  IdentityExceptionFilter,
  PermissionGuardModule,
} from '../controllers';
import { serviceProviders } from '../services/providers';
import { buildKernel, type Kernel } from './kernel';

/**
 * The same two-step shape as the production outbox port (D-21), over the kernel's in-memory
 * outbox: the write before the handler stores a JSON SNAPSHOT of the provisional event (never
 * published, and later changes to the event object do not reach it); `finalize` publishes the
 * final event; `publishFinal` publishes a refusal at once. A test that reads the outbox therefore
 * reads what the relay would, not an object the entry point still mutates (F8).
 */
function twoStepAuditPort(kernel: Kernel): AuditPort {
  const intents = new Map<string, string>();
  const publish = async (event: EventEnvelope): Promise<void> => {
    await kernel.store.uow().run(null, (tx) => kernel.store.uow().publish(tx, event));
  };
  const port = (async (event: EventEnvelope): Promise<void> => {
    intents.set(event.event_id, JSON.stringify(event));
  }) as AuditPort;
  port.publishFinal = publish;
  port.finalize = async (event) => {
    if (!intents.delete(event.event_id)) throw new Error('audit intent is gone');
    await publish(event);
  };
  return port;
}

/**
 * Boots the real HTTP edge over the kernel: the service-kit entry point (`ServiceAuthModule`,
 * fixture JWKS and tenant status read from the kernel, audit port = the kernel outbox), the real
 * guards, controllers and exception filter. `BASE_DOMAIN` is `mio.test`.
 */
export async function createTestApp(
  opts: {
    extraControllers?: Type[];
    serviceClients?: Partial<Record<'identity' | 'engagement' | 'payments', string>>;
  } = {},
): Promise<{ app: NestFastifyApplication; kernel: Kernel }> {
  const kernel = await buildKernel({ serviceSecrets: opts.serviceClients ?? {} });

  @Module({
    imports: [
      ServiceAuthModule.forService({
        audience: 'identity',
        jwks: async () => kernel.sessions.jwks() as never,
        tenantStatus: async (tenantId) => (await kernel.tenants.status(tenantId)).status,
        auditPort: twoStepAuditPort(kernel),
        nowSeconds: () => kernel.now(),
      }),
      PermissionGuardModule,
      HealthModule.register({ useFactory: () => ({}) }),
    ],
    controllers: [...identityControllers, ...(opts.extraControllers ?? [])],
    providers: serviceProviders(kernel),
  })
  class TestAppModule {}

  const app = await NestFactory.create<NestFastifyApplication>(
    TestAppModule,
    new FastifyAdapter(),
    {
      logger: false,
    },
  );
  app.useGlobalFilters(new IdentityExceptionFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, kernel };
}
