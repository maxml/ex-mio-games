import 'reflect-metadata';
import { Module, type Type } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { HealthModule, ServiceAuthModule } from '@ex-mio/service-kit';
import { identityControllers, IdentityExceptionFilter, PermissionGuardModule } from '../controllers';
import { serviceProviders } from '../services/providers';
import { buildKernel } from './kernel';

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
) {
  const kernel = await buildKernel({ serviceSecrets: opts.serviceClients ?? {} });

  @Module({
    imports: [
      ServiceAuthModule.forService({
        audience: 'identity',
        jwks: async () => kernel.sessions.jwks() as never,
        tenantStatus: async (tenantId) => (await kernel.tenants.status(tenantId)).status,
        auditPort: async (event) => {
          await kernel.store.uow().run(null, (tx) => kernel.store.uow().publish(tx, event));
        },
        nowSeconds: () => kernel.now(),
      }),
      PermissionGuardModule,
      HealthModule.register({ useFactory: () => ({}) }),
    ],
    controllers: [...identityControllers, ...(opts.extraControllers ?? [])],
    providers: serviceProviders(kernel),
  })
  class TestAppModule {}

  const app = await NestFactory.create<NestFastifyApplication>(TestAppModule, new FastifyAdapter(), {
    logger: false,
  });
  app.useGlobalFilters(new IdentityExceptionFilter());
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return { app, kernel };
}
