import {
  Inject,
  Injectable,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { reportError } from '@ex-mio/service-kit';
import { RedemptionSagaService } from '../services/redemption-saga.service';
import { REDEMPTION_SAGA } from './tokens';

export const SWEEPER_INTERVAL_MS = Symbol('SWEEPER_INTERVAL_MS');

/**
 * Runs `saga.sweep` on a timer. It holds no state: what is due lives in the store's work queue, so
 * a restart, or several instances at once, only cost a few lost races (the store's `apply` lets
 * exactly one of them win each step). An interval of 0 turns it off (tests, one-off processes).
 */
@Injectable()
export class RedemptionSweeper implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;

  constructor(
    @Inject(REDEMPTION_SAGA) private readonly saga: RedemptionSagaService,
    @Inject(SWEEPER_INTERVAL_MS) private readonly intervalMs: number,
  ) {}

  onApplicationBootstrap(): void {
    if (this.intervalMs <= 0) return;
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  /** One pass; a pass still running makes this a no-op. */
  tick(): Promise<void> {
    this.running ??= this.saga
      .sweep(new Date())
      .then(
        () => undefined,
        (err: unknown) => reportError(err, { phase: 'redemption-sweeper' }),
      )
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  async onApplicationShutdown(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
