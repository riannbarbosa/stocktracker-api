import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { config } from '../../src/config.ts';
import type { MailMessage } from '../../src/services/mailer.ts';
import {
  buildResetEmail,
  consumeResetToken,
  issueResetToken,
  requestPasswordReset,
} from '../../src/services/passwordReset.ts';
import { fakePool, type FakePool } from '../helpers/pg.ts';
import { emulateScripts, fakeRedis, type FakeRedis } from '../helpers/redis.ts';

const logger = { info: () => {} };

function secretOf(token: string): string {
  return token.split('.')[1] ?? '';
}

describe('services/passwordReset', () => {
  let redis: FakeRedis;
  let pg: FakePool;

  beforeEach(() => {
    redis = fakeRedis();
    emulateScripts(redis);
    pg = fakePool();
  });

  afterEach(() => {
    redis.restore();
    pg.restore();
  });

  describe('issueResetToken', () => {
    it('stores only a digest of the secret, per user, with the configured expiry', async () => {
      const token = await issueResetToken(42);

      assert.match(token, /^42\.[A-Za-z0-9_-]{43}$/);
      assert.equal(redis.setCalls.length, 1);
      const [set] = redis.setCalls;
      assert.equal(set?.key, 'password-reset:42');
      assert.deepEqual(set?.options, { EX: config.passwordReset.tokenTtlSeconds });
      assert.ok(!set?.value.includes(secretOf(token)), 'the secret itself reached Redis');
      assert.equal(set?.value, createHash('sha256').update(secretOf(token)).digest('hex'));
    });

    it('never hands out the same secret twice', async () => {
      assert.notEqual(await issueResetToken(42), await issueResetToken(42));
    });
  });

  describe('consumeResetToken', () => {
    it('returns the user id once, then refuses the same token', async () => {
      const token = await issueResetToken(42);

      assert.equal(await consumeResetToken(token), 42);
      assert.equal(await consumeResetToken(token), null);
    });

    /* One key per user, so a newer e-mail supersedes an older one. */
    it('refuses a token superseded by a newer one', async () => {
      const older = await issueResetToken(42);
      const newer = await issueResetToken(42);

      assert.equal(await consumeResetToken(older), null);
      assert.equal(await consumeResetToken(newer), 42);
    });

    it('leaves the real token usable after a wrong guess', async () => {
      const token = await issueResetToken(42);
      const guess = `42.${'A'.repeat(43)}`;

      assert.equal(await consumeResetToken(guess), null);
      assert.equal(await consumeResetToken(token), 42);
    });

    it('refuses a token issued to someone else', async () => {
      const token = await issueResetToken(42);

      assert.equal(await consumeResetToken(`7.${secretOf(token)}`), null);
      assert.equal(await consumeResetToken(token), 42);
    });

    it('rejects a malformed token without asking Redis', async () => {
      for (const token of ['', 'abc', '42.', '42.short', `x.${'A'.repeat(43)}`, `42.${'A'.repeat(44)}`]) {
        assert.equal(await consumeResetToken(token), null, token);
      }
      assert.equal(redis.evalCalls.length, 0);
    });
  });

  describe('requestPasswordReset', () => {
    it('e-mails a working token to a registered address', async () => {
      pg.results([{ rows: [{ id: '42' }] }]);
      const sent: MailMessage[] = [];

      await requestPasswordReset('Trader@Example.TEST', {
        logger,
        send: async (message) => void sent.push(message),
      });

      assert.equal(sent.length, 1);
      assert.equal(sent[0]?.to, 'trader@example.test');
      const token = /(\d+\.[A-Za-z0-9_-]{43})/.exec(sent[0]?.text ?? '')?.[1];
      assert.ok(token, 'no token in the e-mail');
      assert.equal(await consumeResetToken(token), 42);
    });

    it('does nothing at all for an unknown address', async () => {
      pg.results([{ rows: [] }]);
      const sent: MailMessage[] = [];

      await requestPasswordReset('nobody@example.test', {
        logger,
        send: async (message) => void sent.push(message),
      });

      assert.equal(sent.length, 0);
      assert.equal(redis.setCalls.length, 0);
    });
  });

  describe('buildResetEmail', () => {
    it('puts the token in the link fragment when a reset page is configured', () => {
      const original = config.passwordReset.url;
      config.passwordReset.url = 'https://app.example.test/reset';
      try {
        const { text } = buildResetEmail('42.secret');
        assert.ok(text.includes('https://app.example.test/reset#token=42.secret'));
        assert.ok(!text.includes('?token='), 'the token would reach server logs');
      } finally {
        config.passwordReset.url = original;
      }
    });

    it('falls back to the bare token and states the expiry', () => {
      const { subject, text } = buildResetEmail('42.secret');
      assert.match(subject, /reset/i);
      assert.ok(text.includes('42.secret'));
      assert.ok(text.includes(`${config.passwordReset.tokenTtlSeconds / 60} minutes`));
    });
  });
});
