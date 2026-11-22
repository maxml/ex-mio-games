import 'reflect-metadata';
import { Body, Controller, Post } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { registerRawJsonParser } from './ingest.controller';

/**
 * Review F7. `registerRawJsonParser` swaps Fastify's JSON parser for every route; the replacement
 * must keep Fastify's prototype-poisoning guard for the routes that get a parsed body.
 *
 * Mutation: parse with bare `JSON.parse` again (no secure-json-parse / no `__proto__` check)
 * -> INV-PARSER-PROTO-POISON goes red.
 */
@Controller('echo')
class EchoController {
  @Post()
  echo(@Body() body: unknown) {
    return { ownProto: Object.prototype.hasOwnProperty.call(body, '__proto__') };
  }
}

describe('registerRawJsonParser: non-ingest routes keep the poisoning guard (F7)', () => {
  let app: NestFastifyApplication;
  beforeEach(async () => {
    const mod = await Test.createTestingModule({ controllers: [EchoController] }).compile();
    app = mod.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    registerRawJsonParser(app.getHttpAdapter().getInstance());
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });
  afterEach(() => app.close());

  const post = (payload: string) =>
    app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload,
    });

  it('control: an ordinary JSON body is parsed', async () => {
    const res = await post('{"a":1}');
    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual({ ownProto: false });
  });

  it('INV-PARSER-PROTO-POISON: a body with an own `__proto__` key is rejected with a 400, not handed to the handler', async () => {
    const res = await post('{"__proto__":{"admin":true}}');
    expect(res.statusCode).toBe(400);
  });

  it('INV-PARSER-PROTO-POISON: `constructor.prototype` is rejected too', async () => {
    const res = await post('{"constructor":{"prototype":{"admin":true}}}');
    expect(res.statusCode).toBe(400);
  });
});
