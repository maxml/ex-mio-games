import { connect, type ChannelModel } from 'amqplib';

export interface ConnectOptions {
  retries?: number;
  delayMs?: number;
}

/**
 * Connect to RabbitMQ, retrying while the broker boots. Compose waits for the
 * broker's healthcheck, but a restart of the broker later must not kill a service
 * that can simply try again.
 */
export async function connectAmqp(
  url: string,
  options: ConnectOptions = {},
): Promise<ChannelModel> {
  const { retries = 30, delayMs = 1000 } = options;
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await connect(url);
    } catch (err) {
      lastError = err;
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw lastError;
}
