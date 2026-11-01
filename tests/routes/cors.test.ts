import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app.ts';
import { config } from '../../src/config.ts';

const ALLOWED = 'https://front.example.test';

function preflight(app: FastifyInstance, origin: string) {
  return app.inject({
    method: 'OPTIONS',
    url: '/auth/login',
    headers: {
      origin,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type,authorization',
    },
  });
}

describe('CORS', () => {
  let app: FastifyInstance | undefined;
  const original = config.corsOrigins;

  afterEach(async () => {
    await app?.close();
    config.corsOrigins = original;
  });

  it('answers a preflight from an allowed origin', async () => {
    config.corsOrigins = [ALLOWED];
    app = await buildApp({ logger: false });

    const res = await preflight(app, ALLOWED);

    assert.equal(res.statusCode, 204);
    assert.equal(res.headers['access-control-allow-origin'], ALLOWED);
    assert.match(String(res.headers['access-control-allow-headers']), /authorization/i);
  });

  it('sends no allow-origin header to any other origin', async () => {
    config.corsOrigins = [ALLOWED];
    app = await buildApp({ logger: false });

    const res = await preflight(app, 'https://evil.example.test');

    assert.equal(res.headers['access-control-allow-origin'], undefined);
  });

  it('is off when no origin is configured', async () => {
    config.corsOrigins = [];
    app = await buildApp({ logger: false });

    const res = await preflight(app, ALLOWED);

    assert.equal(res.headers['access-control-allow-origin'], undefined);
  });
});
