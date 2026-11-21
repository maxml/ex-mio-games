import { Global, Module, type DynamicModule } from '@nestjs/common';
import { AUTH, DATABASE } from './app.tokens';
import { AuthHttpModule } from './auth/auth.module';
import type { AuthService } from './auth';
import type { AppDatabase } from './db';
import { HealthModule } from './health/health.module';
import { RealtimeModule } from './realtime';
import { UsersModule } from './users/users.module';

export interface AppModuleDeps {
  database: AppDatabase;
  auth: AuthService;
  realtime: boolean;
}

@Global()
@Module({})
class AppDependenciesModule {
  static register(database: AppDatabase, auth: AuthService): DynamicModule {
    return {
      module: AppDependenciesModule,
      providers: [
        { provide: DATABASE, useValue: database },
        { provide: AUTH, useValue: auth },
      ],
      exports: [DATABASE, AUTH],
    };
  }
}

@Module({})
class AppModule {}

export function createAppModule(deps: AppModuleDeps): DynamicModule {
  return {
    module: AppModule,
    imports: [
      AppDependenciesModule.register(deps.database, deps.auth),
      HealthModule,
      AuthHttpModule,
      UsersModule,
      ...(deps.realtime ? [RealtimeModule.register(deps.auth)] : []),
    ],
  };
}
