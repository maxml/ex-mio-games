import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import type net from 'node:net';
import { z } from 'zod';
import {
  isInternalAddress,
  isInternalHostLiteral,
  TenantIntegration as TenantIntegrationSchema,
} from '@ex-mio/contracts';
import type { Transport } from './adapter';
import type { TenantIntegration, TenantIntegrationPort } from './ports';

/**
 * Development stand-in for the identity service's integration credentials (spec section 10): the
 * `INGEST_STATIC_TENANTS` JSON, keyed by tenant slug. Every record is parsed with identity's own
 * `TenantIntegration` contract (X-7), so the dev path enforces the same shape the identity client
 * returns: 1..2 non-empty webhook secrets, `platform`, `environment`. The real identity client
 * replaces it.
 */
export function staticTenantIntegrations(raw: string | undefined): TenantIntegrationPort {
  const parsed = z.record(TenantIntegrationSchema).parse(raw ? JSON.parse(raw) : {});
  const bySlug = new Map<string, TenantIntegration>(Object.entries(parsed));
  const byId = new Map<string, TenantIntegration>(
    [...bySlug.values()].map((t) => [t.tenant_id, t]),
  );
  return {
    lookup: async (slug) => bySlug.get(slug),
    lookupById: async (id) => byId.get(id),
  };
}

const MAX_RESPONSE_BYTES = 256 * 1024;
const SOCKET_TIMEOUT_MS = 15_000;

/** Hosts (comma separated `REWARD_API_ALLOW_HOSTS`, read per call) exempt from the address and https rules. */
const allowedHosts = (): Set<string> =>
  new Set(
    (process.env.REWARD_API_ALLOW_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter((h) => h !== ''),
  );

/**
 * F1: the address check runs HERE, on the addresses the name resolves to at call time, and the
 * socket connects to exactly the address that was checked (the `lookup` hook), so a name that
 * changes its answer between a check and the connect (DNS rebinding) is no way round it.
 */
const guardedLookup: net.LookupFunction = (hostname, options, callback) => {
  dns.lookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 4);
    const list = addresses as dns.LookupAddress[];
    const bad = list.find((a) => isInternalAddress(a.address));
    if (bad || list.length === 0) {
      return callback(new Error('reward API host resolves to an internal address'), '', 4);
    }
    if (options.all) return callback(null, list as never, 4);
    return callback(null, list[0]!.address, list[0]!.family);
  });
};

/**
 * The outbound transport of the casino adapters: one JSON request, the parsed body back.
 * It refuses a URL with credentials, plain http in production, and (unless the host is listed in
 * `REWARD_API_ALLOW_HOSTS`, D-30) any host that resolves to a loopback, private, link-local,
 * unspecified or metadata address. It never follows a redirect: a 3xx is returned as the answer,
 * which the adapters map to `unknown`. A refusal throws, which `callCasino` also maps to `unknown`.
 */
export const fetchTransport: Transport = (req) =>
  new Promise((resolve, reject) => {
    let url: URL;
    try {
      url = new URL(req.url);
    } catch {
      return reject(new Error('reward API URL is not valid'));
    }
    const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const allowed = allowedHosts().has(host);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return reject(new Error('reward API scheme must be http or https'));
    }
    if (url.username !== '' || url.password !== '') {
      return reject(new Error('reward API URL must not carry credentials'));
    }
    if (url.protocol === 'http:' && process.env.NODE_ENV === 'production' && !allowed) {
      return reject(new Error('reward API must use https in production'));
    }
    if (!allowed && isInternalHostLiteral(url.hostname)) {
      return reject(new Error('reward API host is an internal address'));
    }
    const send = url.protocol === 'https:' ? https.request : http.request;
    const payload = req.body !== undefined ? JSON.stringify(req.body) : undefined;
    const out = send(
      url,
      {
        method: req.method,
        headers: {
          ...req.headers,
          ...(payload !== undefined ? { 'content-length': Buffer.byteLength(payload) } : {}),
        },
        timeout: SOCKET_TIMEOUT_MS,
        ...(allowed ? {} : { lookup: guardedLookup }),
      },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on('data', (c: Buffer) => {
          size += c.length;
          if (size > MAX_RESPONSE_BYTES)
            return out.destroy(new Error('reward API reply too large'));
          chunks.push(c);
        });
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let body: unknown = text;
          try {
            body = text === '' ? undefined : JSON.parse(text);
          } catch {
            /* keep the text */
          }
          resolve({ status: res.statusCode ?? 0, body });
        });
        res.on('error', reject);
      },
    );
    out.on('timeout', () => out.destroy(new Error('reward API socket timeout')));
    out.on('error', reject);
    out.end(payload);
  });
