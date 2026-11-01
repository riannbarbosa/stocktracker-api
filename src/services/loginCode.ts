/* The e-mailed security code that stands between a correct password and a
 * token, for both login and registration. Lives in Redis for the same reasons
 * as the reset token: the expiry is the key's TTL and checking a code is one
 * atomic script.
 *
 * A request gets back a challenge, `<userId>.<secret>`, and the inbox gets a
 * six-digit code. Redemption needs both, so the code alone — six digits are
 * guessable — is worthless to anyone who did not also pass the password check.
 * Only the SHA-256 of `secret:code` is stored, under one key per user, so a
 * newer request supersedes the previous code, and a few wrong guesses burn the
 * challenge outright. */

import { randomBytes, randomInt } from 'node:crypto';
import { config } from '../config.ts';
import { redisClient } from '../redis/redis.ts';
import { sendMail, type SendMail } from './mailer.ts';
import { sha256 } from './passwordReset.ts';

interface Logger {
  info: (obj: object, msg?: string) => void;
}

export interface LoginChallenge {
  challenge: string;
  code: string;
}

const KEY_PREFIX = 'login-code:';
const SECRET_BYTES = 32;
const CODE_DIGITS = 6;
/* 32 bytes in base64url, no padding. */
const CHALLENGE_PATTERN = /^(\d{1,19})\.([A-Za-z0-9_-]{43})$/;
const CODE_PATTERN = /^\d{6}$/;

/* Replaces whatever the user had, attempts included, with a fresh expiry. One
 * script so the hash can never be left without its TTL. */
const ISSUE = `
redis.call('DEL', KEYS[1])
redis.call('HSET', KEYS[1], 'digest', ARGV[1], 'attempts', 0)
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1
`;

/* 1 when the digest matches, which deletes the key. Otherwise counts the miss
 * and deletes the key once the misses reach ARGV[2]. */
const REDEEM = `
local digest = redis.call('HGET', KEYS[1], 'digest')
if not digest then return 0 end
if digest == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
local attempts = redis.call('HINCRBY', KEYS[1], 'attempts', 1)
if attempts >= tonumber(ARGV[2]) then redis.call('DEL', KEYS[1]) end
return 0
`;

function keyOf(userId: number | string): string {
  return `${KEY_PREFIX}${userId}`;
}

function digestOf(secret: string, code: string): string {
  return sha256(`${secret}:${code}`);
}

export async function issueLoginCode(userId: number): Promise<LoginChallenge> {
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  const code = String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, '0');
  await redisClient.eval(ISSUE, {
    keys: [keyOf(userId)],
    arguments: [digestOf(secret, code), String(config.loginCode.ttlSeconds)],
  });
  return { challenge: `${userId}.${secret}`, code };
}

/* Returns the user id the challenge was issued to, or null when either part is
 * malformed or wrong, the code expired, was already used, was superseded, or
 * ran out of attempts. */
export async function redeemLoginCode(challenge: string, code: string): Promise<number | null> {
  const match = CHALLENGE_PATTERN.exec(challenge);
  if (!match || !CODE_PATTERN.test(code)) return null;
  const [, userId, secret] = match as unknown as [string, string, string];

  const redeemed = await redisClient.eval(REDEEM, {
    keys: [keyOf(userId)],
    arguments: [digestOf(secret, code), String(config.loginCode.maxAttempts)],
  });
  return redeemed === 1 ? Number(userId) : null;
}

export function buildLoginCodeEmail(code: string): { subject: string; text: string } {
  const minutes = Math.round(config.loginCode.ttlSeconds / 60);
  return {
    subject: `${code} is your stocktracker security code`,
    text: [
      'Use this code to finish signing in to stocktracker:',
      '',
      code,
      '',
      `It expires in ${minutes} minutes and works once. Asking again cancels this one.`,
      'If it was not you, someone knows your password: reset it now.',
    ].join('\n'),
  };
}

/* Runs after the route has already answered, like requestPasswordReset, so a
 * slow SMTP server never shows up in the response time. The challenge is
 * issued before the reply, though: the caller needs it to redeem the code. */
export async function sendLoginCode(
  userId: number,
  email: string,
  code: string,
  { logger, send = sendMail }: { logger: Logger; send?: SendMail },
): Promise<void> {
  await send({ to: email.toLowerCase(), ...buildLoginCodeEmail(code) });
  logger.info({ userId }, 'login code e-mail sent');
}
