/* Password reset tokens live in Redis, not Postgres: the expiry is the key's
 * TTL, so there is nothing to clean up, and consuming one is a single atomic
 * script, so the same token cannot be redeemed twice by racing requests.
 *
 * The token handed out is `<userId>.<secret>`. Only the SHA-256 of the secret
 * is stored, under one key per user — a leaked Redis dump cannot be replayed,
 * and issuing a new token overwrites the previous one, so only the latest
 * e-mail ever works. */

import { createHash, randomBytes } from 'node:crypto';
import { config } from '../config.ts';
import { redisClient } from '../redis/redis.ts';
import { findUserIdByEmail } from '../repositories/users.ts';
import { sendMail, type SendMail } from './mailer.ts';

interface Logger {
  info: (obj: object, msg?: string) => void;
}

const KEY_PREFIX = 'password-reset:';
const SECRET_BYTES = 32;
/* 32 bytes in base64url, no padding. */
const TOKEN_PATTERN = /^(\d{1,19})\.([A-Za-z0-9_-]{43})$/;

/* Deletes the key only when the stored digest matches, and reports whether it
 * did. A wrong guess therefore leaves the real token usable. */
const CONSUME = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('DEL', KEYS[1])
  return 1
end
return 0
`;

function keyOf(userId: number | string): string {
  return `${KEY_PREFIX}${userId}`;
}

/* Exported for the rate limiter, which keys on the address without storing it. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export async function issueResetToken(userId: number): Promise<string> {
  const secret = randomBytes(SECRET_BYTES).toString('base64url');
  await redisClient.set(keyOf(userId), sha256(secret), { EX: config.passwordReset.tokenTtlSeconds });
  return `${userId}.${secret}`;
}

/* Returns the user id the token was issued to, or null when it is malformed,
 * expired, already used or superseded by a newer one. */
export async function consumeResetToken(token: string): Promise<number | null> {
  const match = TOKEN_PATTERN.exec(token);
  if (!match) return null;
  const [, userId, secret] = match as unknown as [string, string, string];

  const consumed = await redisClient.eval(CONSUME, {
    keys: [keyOf(userId)],
    arguments: [sha256(secret)],
  });
  return consumed === 1 ? Number(userId) : null;
}

export function buildResetEmail(token: string): { subject: string; text: string } {
  const minutes = Math.round(config.passwordReset.tokenTtlSeconds / 60);
  /* The fragment never leaves the browser, so the token stays out of server
   * logs and Referer headers. */
  const action = config.passwordReset.url
    ? `Open this link to choose a new password:\n${config.passwordReset.url}#token=${token}`
    : `Send this token to POST /auth/reset-password with your new password:\n${token}`;

  return {
    subject: 'Reset your stocktracker password',
    text: [
      'Someone asked to reset the password for this account.',
      '',
      action,
      '',
      `It expires in ${minutes} minutes and works once. Asking again cancels this one.`,
      'If it was not you, ignore this e-mail: your password has not changed.',
    ].join('\n'),
  };
}

/* Runs after the route has already answered, so its duration — including
 * whether the address exists and whether SMTP is slow — never shows up in the
 * response time. Unknown addresses end here silently. */
export async function requestPasswordReset(
  email: string,
  { logger, send = sendMail }: { logger: Logger; send?: SendMail },
): Promise<void> {
  const userId = await findUserIdByEmail(email);
  if (userId === null) return;

  const token = await issueResetToken(userId);
  await send({ to: email.toLowerCase(), ...buildResetEmail(token) });
  logger.info({ userId }, 'password reset e-mail sent');
}
