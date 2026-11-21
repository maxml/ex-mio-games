import {
  Global,
  Inject,
  Injectable,
  Module,
  type DynamicModule,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import type { DataSource } from 'typeorm';
import type { EventEnvelope } from '@ex-mio/contracts';
import {
  BusModule,
  BusRuntime,
  DATA_SOURCE,
  Db,
  HealthModule,
  probe,
  ServiceAuthModule,
} from '@ex-mio/service-kit';
import type { Config } from './config';
import { identityControllers, PermissionGuardModule } from './controllers';
import { makeDataSource } from './model/data-source';
import { PgUnitOfWork, pgRepos } from './model/pg-repos';
import { AccessService } from './services/access.service';
import { AuditService } from './services/audit.service';
import { CredentialsService } from './services/credentials.service';
import { FakeIdentityProvider } from './services/fake-identity-provider';
import { FirebaseEmulatorProvider } from './services/firebase-emulator-provider';
import { LaunchService } from './services/launch.service';
import { PlayersService } from './services/players.service';
import { SessionsService } from './services/sessions.service';
import { StaffService } from './services/staff.service';
import { TenantsService } from './services/tenants.service';
import { wireServices, type Services } from './services/wire';

const IDENTITY_CONFIG = Symbol('IDENTITY_CONFIG');
const IDENTITY_SERVICES = Symbol('IDENTITY_SERVICES');

/** What the in-process sources of the entry point read once the services exist. */
interface Bound {
  services?: Services;
  db?: Db;
}

const SERVICE_CLASSES: Array<[new (...a: never[]) => unknown, keyof Services]> = [
  [TenantsService, 'tenants'],
  [AuditService, 'audit'],
  [AccessService, 'access'],
  [SessionsService, 'sessions'],
  [StaffService, 'staff'],
  [CredentialsService, 'credentials'],
  [PlayersService, 'players'],
  [LaunchService, 'launch'],
];

/** Boot work that needs the wired services: the signing keys and the seeded platform admin. */
@Injectable()
class IdentityBootstrap implements OnApplicationBootstrap {
  constructor(
    @Inject(IDENTITY_CONFIG) private readonly config: Config,
    private readonly sessions: SessionsService,
    private readonly staff: StaffService,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.sessions.init();
    await this.staff.createPlatformAdmin({
      email: this.config.PLATFORM_ADMIN_EMAIL,
      password: this.config.PLATFORM_ADMIN_PASSWORD,
    });
  }
}

@Global()
@Module({})
class IdentityCoreModule implements OnApplicationShutdown {
  constructor(@Inject(DATA_SOURCE) private readonly dataSource: DataSource) {}

  static register(config: Config, bound: Bound): DynamicModule {
    const classProviders: Provider[] = SERVICE_CLASSES.map(([token, key]) => ({
      provide: token,
      inject: [IDENTITY_SERVICES],
      useFactory: (s: Services) => s[key],
    }));
    return {
      module: IdentityCoreModule,
      providers: [
        { provide: IDENTITY_CONFIG, useValue: config },
        { provide: DATA_SOURCE, useFactory: async (): Promise<DataSource> => makeDataSource().initialize() },
        Db,
        {
          provide: IDENTITY_SERVICES,
          inject: [Db],
          useFactory: (db: Db): Services => {
            const provider =
              config.IDENTITY_PROVIDER === 'fake'
                ? new FakeIdentityProvider()
                : new FirebaseEmulatorProvider(config.FIREBASE_AUTH_EMULATOR_HOST, config.FIREBASE_PROJECT);
            bound.db = db;
            bound.services = wireServices({
              uow: new PgUnitOfWork(db),
              repos: pgRepos(),
              clock: { now: () => Math.floor(Date.now() / 1000) },
              provider,
              baseDomain: config.BASE_DOMAIN,
              kek: config.CREDENTIALS_KEK,
              serviceSecrets: config.SERVICE_CLIENT_SECRETS,
            });
            return bound.services;
          },
        },
        ...classProviders,
      ],
      exports: [DATA_SOURCE, Db, IDENTITY_CONFIG, ...SERVICE_CLASSES.map(([t]) => t)],
    };
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.dataSource.isInitialized) await this.dataSource.destroy();
  }
}

/**
 * Identity is wired like every other service: `ServiceAuthModule.forService` is the one auth entry
 * point. Identity IS the source of the JWKS and the tenant status, so it hands the entry point
 * in-process sources (bound once the services exist) and writes its audit events to its own
 * outbox, which it also consumes (D-11, D-14).
 */
export function createAppModule(config: Config): DynamicModule {
  const bound: Bound = {};
  const services = (): Services => {
    if (!bound.services) throw new Error('identity services are not ready');
    return bound.services;
  };
  const db = (): Db => {
    if (!bound.db) throw new Error('database is not ready');
    return bound.db;
  };
  const auditPort = Object.assign(
    async (event: EventEnvelope): Promise<void> => {
      await db().platformTx((tx) => db().publish(tx, event));
    },
    {
      /** Persist the final outcome while the event is still in the outbox. */
      finalize: async (event: EventEnvelope): Promise<void> => {
        await db().platformTx((tx) =>
          tx.query(`UPDATE "outbox" SET "envelope" = $2 WHERE "event_id" = $1 AND "published_at" IS NULL`, [
            event.event_id,
            JSON.stringify(event),
          ]),
        );
      },
    },
  );

  const core = IdentityCoreModule.register(config, bound);
  const bus = BusModule.register({
    service: 'identity',
    url: config.AMQP_URL,
    bindings: ['audit.acting_request', 'audit.service_call'],
    publishes: true,
    imports: [core],
    handler: {
      inject: [AuditService],
      useFactory: (audit: AuditService) => (manager, event) => audit.handle(event, manager),
    },
  });

  @Module({
    imports: [
      core,
      ServiceAuthModule.forService({
        audience: 'identity',
        jwks: async () => services().sessions.jwks() as never,
        tenantStatus: async (tenantId) => (await services().tenants.status(tenantId)).status,
        auditPort,
      }),
      PermissionGuardModule,
      bus,
      HealthModule.register({
        imports: [core, bus],
        inject: [Db, BusRuntime],
        useFactory: (d: Db, runtime: BusRuntime) => ({
          db: () => probe(() => d.ping()),
          amqp: () => probe(async () => runtime.assertConnected()),
        }),
      }),
    ],
    controllers: identityControllers,
    providers: [IdentityBootstrap],
  })
  class IdentityModule {}

  return { module: IdentityModule };
}
