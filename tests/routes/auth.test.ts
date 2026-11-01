import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import type { FastifyInstance } from 'fastify';

import { buildApp } from '../../src/app.ts';
import type { JwtPayload } from '../../src/types/auth.ts';
import { hashPassword } from '../../src/services/auth.ts';
import { config } from '../../src/config.ts';
import { issueLoginCode } from '../../src/services/loginCode.ts';
import { issueResetToken } from '../../src/services/passwordReset.ts';
import { fakePool, queryMatching, type FakePool } from '../helpers/pg.ts';
import { emulateScripts, fakeRedis, type FakeRedis } from '../helpers/redis.ts';

const PASSWORD = 'a-long-enough-password';

function userRow(passwordHash: string) {
  return {
    id: '42',
    email: 'trader@example.test',
    password_hash: passwordHash,
    token_version: 0,
    created_at: new Date('2026-09-04T20:06:00.000Z'),
  };
}

interface ChallengeBody {
  message: string;
  challenge: string;
  expiresIn: number;
}

describe('routes/auth', () => {
  let app: FastifyInstance;
  let pg: FakePool;
  let redis: FakeRedis;
  let hash: string;

  beforeEach(async () => {
    pg = fakePool();
    redis = fakeRedis();
    emulateScripts(redis);
    app = await buildApp({ logger: false });
    await app.ready();
    hash = await hashPassword(PASSWORD);
  });

  /* login, register and forgot-password finish their work after replying; let
   * it settle before the fakes are taken away. */
  afterEach(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10));
    await app.close();
    redis.restore();
    pg.restore();
  });

  function verify(challenge: string, code: string, ip = '203.0.113.7') {
    return app.inject({
      method: 'POST',
      url: '/auth/verify-code',
      payload: { challenge, code },
      remoteAddress: ip,
    });
  }

  describe('POST /auth/register', () => {
    it('creates the account and answers with a challenge, not a token', async () => {
      pg.results([{ rows: [userRow(hash)] }]);

      const response = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'trader@example.test', password: PASSWORD },
      });

      assert.equal(response.statusCode, 201);
      const body = response.json() as ChallengeBody & { token?: string };
      assert.equal(body.token, undefined, 'register must not sign the user in by itself');
      assert.match(body.challenge, /^42\.[A-Za-z0-9_-]{43}$/);
      assert.equal(body.expiresIn, config.loginCode.ttlSeconds);
      assert.ok(redis.stored.has('login-code:42'), 'no code was issued');
    });

    /* The point of the whole flow: the token from verify-code is accepted by a
     * protected route, and formatUser turns `sub` into the owner id the
     * repository is scoped by. */
    it('issues, once the code checks out, a token a protected route accepts', async () => {
      pg.handle((sql) => {
        if (sql.includes('INSERT INTO users')) return { rows: [userRow(hash)] };
        if (sql.includes('FROM users WHERE id')) return { rows: [userRow(hash)] };
        if (sql.includes('token_version')) return { rows: [{ token_version: 0 }] };
        return { rows: [] };
      });

      const registered = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'trader@example.test', password: PASSWORD },
      });
      assert.equal(registered.statusCode, 201);

      /* The code only travels by e-mail, so the test issues its own — which
       * also supersedes the one register sent. */
      const { challenge, code } = await issueLoginCode(42);
      const verified = await verify(challenge, code);
      assert.equal(verified.statusCode, 200);
      const { token } = verified.json() as { token: string };

      const response = await app.inject({
        method: 'GET',
        url: '/watchlist',
        headers: { authorization: `Bearer ${token}` },
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(
        queryMatching(pg.queries, 'FROM watchlist')?.params,
        [42],
        'the query is scoped by the id carried in the token',
      );
    });

    it('never stores the password itself', async () => {
      pg.results([{ rows: [userRow(hash)] }]);

      await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'trader@example.test', password: PASSWORD },
      });

      const insert = queryMatching(pg.queries, 'INSERT INTO users');
      assert.ok(insert);
      assert.equal(insert.params[0], 'trader@example.test');
      assert.notEqual(insert.params[1], PASSWORD, 'the plaintext reached the database');
      assert.match(String(insert.params[1]), /^scrypt\$/);
    });

    it('lower-cases the address so it cannot be registered twice by casing', async () => {
      pg.results([{ rows: [userRow(hash)] }]);

      await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'Trader@Example.TEST', password: PASSWORD },
      });

      assert.equal(queryMatching(pg.queries, 'INSERT INTO users')?.params[0], 'trader@example.test');
    });

    /* ON CONFLICT DO NOTHING returns no row; the route turns that into a 409
     * rather than sniffing SQLSTATE. */
    it('answers 409 when the address is taken', async () => {
      pg.results([{ rows: [] }]);

      const response = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'trader@example.test', password: PASSWORD },
      });

      assert.equal(response.statusCode, 409);
      assert.deepEqual(response.json(), { error: 'email already registered' });
      assert.equal(redis.stored.size, 0, 'a code was issued for an existing account');
    });

    it('fails closed with 503, before creating anything, when Redis is down', async () => {
      redis.setReady(false);

      const response = await app.inject({
        method: 'POST',
        url: '/auth/register',
        payload: { email: 'trader@example.test', password: PASSWORD },
      });

      assert.equal(response.statusCode, 503);
      assert.equal(pg.queries.length, 0);
    });

    it('rejects a short password and a malformed address', async () => {
      for (const payload of [
        { email: 'trader@example.test', password: 'short' },
        { email: 'not-an-email', password: PASSWORD },
      ]) {
        const response = await app.inject({ method: 'POST', url: '/auth/register', payload });
        assert.equal(response.statusCode, 400, JSON.stringify(payload));
      }
      assert.equal(pg.queries.length, 0, 'nothing reached the database');
    });

    /* 15+ characters of anything, or 8+ with a digit and a lowercase letter. */
    it('applies the password policy', async () => {
      const cases: [string, number][] = [
        ['abcdef12', 201],
        ['çãoéíõú1', 201],
        ['ABCDEFGHIJKLMNO', 201],
        ['abcdefgh', 400],
        ['ABCDEF12', 400],
        ['abcde12', 400],
        ['ABCDEFGHIJKLMN', 400],
      ];
      for (const [password, status] of cases) {
        pg.results([{ rows: [userRow(hash)] }]);
        const response = await app.inject({
          method: 'POST',
          url: '/auth/register',
          payload: { email: 'trader@example.test', password },
        });
        assert.equal(response.statusCode, status, password);
      }
    });
  });

  describe('POST /auth/login', () => {
    function login(password = PASSWORD, email = 'trader@example.test') {
      return app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });
    }

    it('answers the right password with a challenge, not a token', async () => {
      pg.results([{ rows: [userRow(hash)] }]);

      const response = await login();

      assert.equal(response.statusCode, 202);
      const body = response.json() as ChallengeBody & { token?: string };
      assert.equal(body.token, undefined, 'a password alone must not be enough to sign in');
      assert.match(body.challenge, /^42\.[A-Za-z0-9_-]{43}$/);
      assert.equal(body.expiresIn, config.loginCode.ttlSeconds);
      assert.ok(redis.stored.has('login-code:42'));
    });

    it('answers 401 for the wrong password, without sending a code', async () => {
      pg.results([{ rows: [userRow(hash)] }]);

      const response = await login('not-the-password');

      assert.equal(response.statusCode, 401);
      assert.deepEqual(response.json(), { error: 'invalid credentials' });
      assert.equal(redis.evalCalls.length, 0);
    });

    it('limits the codes sent to one address, with a Retry-After', async () => {
      pg.results([{ rows: [userRow(hash)] }]);
      for (let i = 0; i < config.loginCode.maxPerEmail; i++) {
        assert.equal((await login()).statusCode, 202);
      }

      const response = await login();

      assert.equal(response.statusCode, 429);
      assert.equal(response.headers['retry-after'], String(config.loginCode.windowSeconds));
      assert.ok(
        redis.evalCalls.every((call) => !call.keys.some((key) => key.includes('trader@'))),
        'the address reached Redis in clear',
      );
    });

    it('fails closed with 503 when Redis is down', async () => {
      redis.setReady(false);
      pg.results([{ rows: [userRow(hash)] }]);

      assert.equal((await login()).statusCode, 503);
    });

    /* Same status and same body for an unknown address as for a wrong password,
     * so the endpoint cannot be used to discover which e-mails are registered. */
    it('answers 401 identically for an unknown address', async () => {
      pg.results([{ rows: [] }]);

      const response = await app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: 'nobody@example.test', password: PASSWORD },
      });

      assert.equal(response.statusCode, 401);
      assert.deepEqual(response.json(), { error: 'invalid credentials' });
    });
  });

  describe('POST /auth/verify-code', () => {
    it('exchanges the challenge and its code for a token with the current version', async () => {
      const { challenge, code } = await issueLoginCode(42);
      pg.results([{ rows: [{ ...userRow(hash), token_version: 3 }] }]);

      const response = await verify(challenge, code);

      assert.equal(response.statusCode, 200);
      const body = response.json() as { token: string; expiresIn: number };
      assert.equal(body.expiresIn, config.auth.tokenTtlSeconds);
      const claims = app.jwt.verify<JwtPayload>(body.token);
      assert.equal(claims.sub, '42');
      assert.equal(claims.ver, 3);
    });

    it('accepts a code only once', async () => {
      const { challenge, code } = await issueLoginCode(42);
      pg.results([{ rows: [userRow(hash)] }]);

      assert.equal((await verify(challenge, code)).statusCode, 200);
      const again = await verify(challenge, code);

      assert.equal(again.statusCode, 400);
      assert.deepEqual(again.json(), { error: 'invalid or expired code' });
    });

    it('discards the challenge after too many wrong codes', async () => {
      const { challenge, code } = await issueLoginCode(42);
      const wrong = code === '000000' ? '000001' : '000000';
      pg.results([{ rows: [userRow(hash)] }]);

      for (let i = 0; i < config.loginCode.maxAttempts; i++) {
        assert.equal((await verify(challenge, wrong)).statusCode, 400);
      }

      assert.equal((await verify(challenge, code)).statusCode, 400, 'the right code still worked');
    });

    it('refuses a code once a newer one was sent', async () => {
      const first = await issueLoginCode(42);
      const second = await issueLoginCode(42);
      pg.results([{ rows: [userRow(hash)] }]);

      assert.equal((await verify(first.challenge, first.code)).statusCode, 400);
      assert.equal((await verify(second.challenge, second.code)).statusCode, 200);
    });

    it('answers the same 400 for a malformed challenge or code', async () => {
      const { challenge } = await issueLoginCode(42);
      for (const [c, code] of [['garbage', '123456'], [challenge, 'abc'], [challenge, '1234567']]) {
        const response = await verify(c ?? '', code ?? '');
        assert.equal(response.statusCode, 400, `${c} ${code}`);
        assert.deepEqual(response.json(), { error: 'invalid or expired code' });
      }
      assert.equal(pg.queries.length, 0);
    });

    it('answers 400 when the account was deleted after the code went out', async () => {
      const { challenge, code } = await issueLoginCode(42);
      pg.results([{ rows: [] }]);

      assert.equal((await verify(challenge, code)).statusCode, 400);
    });

    it('limits attempts per IP', async () => {
      for (let i = 0; i < config.loginCode.maxPerIp; i++) {
        assert.equal((await verify('garbage', '000000')).statusCode, 400);
      }

      const { challenge, code } = await issueLoginCode(42);
      pg.results([{ rows: [userRow(hash)] }]);

      assert.equal((await verify(challenge, code)).statusCode, 429);
      assert.equal((await verify(challenge, code, '192.0.2.1')).statusCode, 200);
    });

    it('fails closed with 503 when Redis is down', async () => {
      redis.setReady(false);

      assert.equal((await verify(`42.${'A'.repeat(43)}`, '123456')).statusCode, 503);
    });
  });

  describe('POST /auth/logout-all', () => {
    function tokenFor(version: number): string {
      return app.jwt.sign({ sub: '42', email: 'trader@example.test', ver: version });
    }

    it('needs a token of its own', async () => {
      const response = await app.inject({ method: 'POST', url: '/auth/logout-all' });

      assert.equal(response.statusCode, 401);
      assert.equal(pg.queries.length, 0, 'nothing reached the database');
    });

    it('bumps the version and reports the new one', async () => {
      pg.handle((sql) =>
        sql.includes('UPDATE users')
          ? { rows: [{ token_version: 1 }] }
          : { rows: [{ token_version: 0 }] },
      );

      const response = await app.inject({
        method: 'POST',
        url: '/auth/logout-all',
        headers: { authorization: `Bearer ${tokenFor(0)}` },
      });

      assert.equal(response.statusCode, 200);
      assert.deepEqual(response.json(), { tokenVersion: 1 });
      assert.deepEqual(queryMatching(pg.queries, 'UPDATE users')?.params, [42]);
    });

    /* The point of the whole mechanism: a signature that still verifies is no
     * longer enough once the stored version has moved on. */
    it('stops a still-unexpired token from working afterwards', async () => {
      pg.handle(() => ({ rows: [{ token_version: 1 }] }));

      const response = await app.inject({
        method: 'GET',
        url: '/watchlist',
        headers: { authorization: `Bearer ${tokenFor(0)}` },
      });

      assert.equal(response.statusCode, 401);
      assert.deepEqual(response.json(), { error: 'invalid or expired token' });
      assert.equal(queryMatching(pg.queries, 'FROM watchlist'), undefined, 'the handler still ran');
    });

    it('keeps accepting a token signed with the current version', async () => {
      pg.handle((sql) =>
        sql.includes('token_version') ? { rows: [{ token_version: 1 }] } : { rows: [] },
      );

      const response = await app.inject({
        method: 'GET',
        url: '/watchlist',
        headers: { authorization: `Bearer ${tokenFor(1)}` },
      });

      assert.equal(response.statusCode, 200);
    });

    /* A deleted account reads back as no row at all, which has to fail closed. */
    it('rejects a token belonging to a user that no longer exists', async () => {
      pg.handle(() => ({ rows: [] }));

      const response = await app.inject({
        method: 'GET',
        url: '/watchlist',
        headers: { authorization: `Bearer ${tokenFor(0)}` },
      });

      assert.equal(response.statusCode, 401);
    });
  });

  describe('password reset', () => {
    function forgot(email: string, ip = '203.0.113.7') {
      return app.inject({ method: 'POST', url: '/auth/forgot-password', payload: { email }, remoteAddress: ip });
    }

    function reset(token: string, password = 'a-brand-new-password', ip = '203.0.113.7') {
      return app.inject({
        method: 'POST',
        url: '/auth/reset-password',
        payload: { token, password },
        remoteAddress: ip,
      });
    }

    describe('POST /auth/forgot-password', () => {
      it('answers 202 for a registered address and 404 for an unknown one', async () => {
        pg.handle((_sql, params) => ({ rows: params[0] === 'trader@example.test' ? [{ id: '42' }] : [] }));

        const known = await forgot('trader@example.test');
        const unknown = await forgot('nobody@example.test');

        assert.equal(known.statusCode, 202);
        assert.equal(unknown.statusCode, 404);
        assert.deepEqual(unknown.json(), { error: 'email not registered' });
      });

      it('stores a token for a registered address only', async () => {
        pg.handle((_sql, params) => ({ rows: params[0] === 'trader@example.test' ? [{ id: '42' }] : [] }));

        await forgot('nobody@example.test');
        await forgot('Trader@Example.TEST');
        await new Promise((resolve) => setTimeout(resolve, 10));

        assert.deepEqual(redis.setCalls.map((call) => call.key), ['password-reset:42']);
      });

      it('limits requests per address, across IPs, with a Retry-After', async () => {
        pg.results([{ rows: [{ id: '42' }] }]);
        for (let i = 0; i < config.passwordReset.maxPerEmail; i++) {
          assert.equal((await forgot('trader@example.test', `198.51.100.${i}`)).statusCode, 202);
        }

        const lookupsBefore = pg.queries.length;
        const response = await forgot('Trader@example.test', '198.51.100.99');
        await new Promise((resolve) => setTimeout(resolve, 10));

        assert.equal(response.statusCode, 429);
        assert.equal(pg.queries.length, lookupsBefore, 'a limited request still went on to send');
        assert.equal(response.headers['retry-after'], String(config.passwordReset.windowSeconds));
        assert.ok(
          redis.evalCalls.every((call) => !call.keys.some((key) => key.includes('trader@'))),
          'the address reached Redis in clear',
        );
      });

      /* Unknown addresses count too, so the 404 cannot be used to check a list. */
      it('limits requests per IP, across addresses', async () => {
        for (let i = 0; i < config.passwordReset.maxPerIp; i++) {
          assert.equal((await forgot(`user${i}@example.test`)).statusCode, 404);
        }

        assert.equal((await forgot('another@example.test')).statusCode, 429);
        assert.equal((await forgot('another@example.test', '192.0.2.1')).statusCode, 404);
      });

      it('fails closed with 503 when Redis is down', async () => {
        redis.setReady(false);

        const response = await forgot('trader@example.test');

        assert.equal(response.statusCode, 503);
        assert.equal(pg.queries.length, 0);
      });

      it('rejects a malformed address', async () => {
        assert.equal((await forgot('not-an-email')).statusCode, 400);
        assert.equal(redis.evalCalls.length, 0);
      });
    });

    describe('POST /auth/reset-password', () => {
      it('sets the new password and revokes old tokens without signing anyone in', async () => {
        const token = await issueResetToken(42);
        pg.results([{ rows: [{ ...userRow('ignored'), token_version: 3 }] }]);

        const response = await reset(token);

        assert.equal(response.statusCode, 200);
        const update = queryMatching(pg.queries, 'UPDATE users');
        assert.ok(update);
        assert.match(update.sql, /token_version = token_version \+ 1/);
        assert.equal(update.params[0], 42);
        assert.notEqual(update.params[1], 'a-brand-new-password', 'the plaintext reached the database');
        assert.match(String(update.params[1]), /^scrypt\$/);

        /* The new password has to go through login and its e-mailed code. */
        assert.deepEqual(response.json(), { message: 'password updated, sign in with the new one' });
      });

      it('accepts a token only once', async () => {
        const token = await issueResetToken(42);
        pg.results([{ rows: [userRow('ignored')] }]);

        assert.equal((await reset(token)).statusCode, 200);
        const again = await reset(token);

        assert.equal(again.statusCode, 400);
        assert.deepEqual(again.json(), { error: 'invalid or expired token' });
      });

      it('answers the same 400 for a malformed, unknown or expired token', async () => {
        for (const token of ['garbage', `42.${'A'.repeat(43)}`]) {
          const response = await reset(token);
          assert.equal(response.statusCode, 400, token);
          assert.deepEqual(response.json(), { error: 'invalid or expired token' });
        }
        assert.equal(queryMatching(pg.queries, 'UPDATE users'), undefined);
      });

      /* Validation runs before the handler, so a password that breaks the
       * policy does not burn the token. */
      it('keeps the token usable when the new password is too short', async () => {
        const token = await issueResetToken(42);
        pg.results([{ rows: [userRow('ignored')] }]);

        assert.equal((await reset(token, 'short')).statusCode, 400);
        assert.equal((await reset(token)).statusCode, 200);
      });

      it('answers 400 when the account was deleted after the e-mail went out', async () => {
        const token = await issueResetToken(42);
        pg.results([{ rows: [] }]);

        assert.equal((await reset(token)).statusCode, 400);
      });

      it('limits attempts per IP', async () => {
        for (let i = 0; i < config.passwordReset.maxPerIp; i++) {
          assert.equal((await reset('garbage')).statusCode, 400);
        }

        const token = await issueResetToken(42);
        pg.results([{ rows: [userRow('ignored')] }]);

        assert.equal((await reset(token)).statusCode, 429);
        assert.equal(queryMatching(pg.queries, 'UPDATE users'), undefined, 'a limited request still reset');
      });

      it('fails closed with 503 when Redis is down', async () => {
        redis.setReady(false);

        assert.equal((await reset(`42.${'A'.repeat(43)}`)).statusCode, 503);
        assert.equal(pg.queries.length, 0);
      });
    });
  });

  describe('openapi spec', () => {
    it('leaves the auth routes public and marks the rest as bearer-protected', () => {
      const paths = app.swagger().paths ?? {};
      const security = (path: string, method: string) =>
        (paths[path] as Record<string, { security?: unknown[] }> | undefined)?.[method]?.security;

      assert.equal(security('/auth/login', 'post'), undefined, 'login must not require a token');
      assert.equal(security('/auth/verify-code', 'post'), undefined);
      assert.equal(security('/auth/forgot-password', 'post'), undefined);
      assert.equal(security('/auth/reset-password', 'post'), undefined);
      assert.deepEqual(security('/alerts', 'get'), [{ bearerAuth: [] }]);
      assert.deepEqual(security('/watchlist', 'get'), [{ bearerAuth: [] }]);
    });
  });
});
