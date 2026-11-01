import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { config } from '../../src/config.ts';
import type { MailMessage } from '../../src/services/mailer.ts';
import {
  buildLoginCodeEmail,
  issueLoginCode,
  redeemLoginCode,
  sendLoginCode,
} from '../../src/services/loginCode.ts';
import { emulateScripts, fakeRedis, type FakeRedis } from '../helpers/redis.ts';

const logger = { info: () => {} };

describe('services/loginCode', () => {
  let redis: FakeRedis;

  beforeEach(() => {
    redis = fakeRedis();
    emulateScripts(redis);
  });

  afterEach(() => {
    redis.restore();
  });

  describe('issueLoginCode', () => {
    it('stores only a digest, per user, with the configured expiry', async () => {
      const { challenge, code } = await issueLoginCode(42);

      assert.match(challenge, /^42\.[A-Za-z0-9_-]{43}$/);
      assert.match(code, /^\d{6}$/);
      const [call] = redis.evalCalls;
      assert.deepEqual(call?.keys, ['login-code:42']);
      assert.equal(call?.args[1], String(config.loginCode.ttlSeconds));
      const secret = challenge.split('.')[1] ?? '';
      assert.ok(!call?.args[0]?.includes(secret), 'the secret itself reached Redis');
      assert.ok(!call?.args[0]?.includes(code), 'the code itself reached Redis');
    });

    it('never hands out the same challenge twice', async () => {
      const first = await issueLoginCode(42);
      const second = await issueLoginCode(42);
      assert.notEqual(first.challenge, second.challenge);
    });
  });

  describe('redeemLoginCode', () => {
    it('returns the user id once, then refuses the same pair', async () => {
      const { challenge, code } = await issueLoginCode(42);

      assert.equal(await redeemLoginCode(challenge, code), 42);
      assert.equal(await redeemLoginCode(challenge, code), null);
    });

    /* The code is bound to the challenge it was sent with: six digits are not
     * enough on their own, even for the right user id. */
    it('refuses the right code with another challenge for the same user', async () => {
      const { code } = await issueLoginCode(42);

      assert.equal(await redeemLoginCode(`42.${'A'.repeat(43)}`, code), null);
    });

    it('refuses malformed input without touching Redis', async () => {
      const before = redis.evalCalls.length;
      assert.equal(await redeemLoginCode('garbage', '123456'), null);
      assert.equal(await redeemLoginCode(`42.${'A'.repeat(43)}`, '12345'), null);
      assert.equal(redis.evalCalls.length, before);
    });
  });

  describe('sendLoginCode', () => {
    it('mails the code to the lower-cased address', async () => {
      const sent: MailMessage[] = [];

      await sendLoginCode(42, 'Trader@Example.TEST', '012345', {
        logger,
        send: async (message) => {
          sent.push(message);
        },
      });

      assert.equal(sent.length, 1);
      assert.equal(sent[0]?.to, 'trader@example.test');
      assert.ok(sent[0]?.text.includes('012345'));
    });

    it('states the expiry in minutes', () => {
      const minutes = Math.round(config.loginCode.ttlSeconds / 60);
      assert.ok(buildLoginCodeEmail('012345').text.includes(`${minutes} minutes`));
    });
  });
});
