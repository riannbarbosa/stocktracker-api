import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { config } from '../config.ts';
import { hitRateLimit } from '../lib/rateLimit.ts';
import { redisClient } from '../redis/redis.ts';
import { bumpTokenVersion, createUser, findUserByEmail, findUserIdByEmail, resetPassword } from '../repositories/users.ts';
import { hashPassword, verifyPassword } from '../services/auth.ts';
import { consumeResetToken, requestPasswordReset, sha256 } from '../services/passwordReset.ts';
import { ownerOf } from '../plugins/authenticate.ts';

interface CredentialsBody {
  email: string;
  password: string;
}

interface ForgotPasswordBody {
  email: string;
}

interface ResetPasswordBody {
  token: string;
  password: string;
}

const registerBodySchema = {
  type: 'object',
  required: ['email', 'password'],
  additionalProperties: false,
  properties: {
    email: { type: 'string', format: 'email', description: 'Login identity.' },
    /* maxLength matters: scrypt hashes whatever it is handed, so an unbounded
     * password is free CPU for whoever sends it. 15+ characters of anything, or
     * 8+ with a digit and a lowercase letter. */
    password: {
      type: 'string',
      maxLength: 256,
      anyOf: [{ minLength: 15 }, { minLength: 8, pattern: '^(?=.*\\d)(?=.*\\p{Ll})' }],
    },
  },
} as const;

/* Login does not re-impose minLength — a password that predates a policy change
 * should fail with 401, not a confusing 400. */
const loginBodySchema = {
  type: 'object',
  required: ['email', 'password'],
  additionalProperties: false,
  properties: {
    email: { type: 'string', format: 'email' },
    password: { type: 'string', maxLength: 256 },
  },
} as const;

const tokenSchema = {
  type: 'object',
  properties: {
    token: { type: 'string', description: 'Send as `Authorization: Bearer <token>`.' },
    expiresIn: { type: 'integer', description: 'Seconds until the token expires.' },
  },
} as const;

const errorSchema = { type: 'object', properties: { error: { type: 'string' } } } as const;

const forgotPasswordBodySchema = {
  type: 'object',
  required: ['email'],
  additionalProperties: false,
  properties: { email: { type: 'string', format: 'email' } },
} as const;

/* No pattern on token: a malformed one gets the same 400 as an expired one,
 * from the handler, instead of a validation message describing the format. */
const resetPasswordBodySchema = {
  type: 'object',
  required: ['token', 'password'],
  additionalProperties: false,
  properties: {
    token: { type: 'string', maxLength: 128, description: 'From the reset e-mail.' },
    password: registerBodySchema.properties.password,
  },
} as const;

const FORGOT_ACCEPTED = { message: 'a reset e-mail is on its way' };
const EMAIL_NOT_REGISTERED = { error: 'email not registered' };
const RESET_UNAVAILABLE = { error: 'password reset is temporarily unavailable' };
const INVALID_RESET_TOKEN = { error: 'invalid or expired token' };

/* Checks each [key, limit] in order and answers 429 at the first one exceeded.
 * Returns whether it did. A boolean, not the reply: FastifyReply is thenable,
 * so an awaited reply resolves to undefined and the handler would carry on. */
async function rateLimited(
  reply: FastifyReply,
  limits: Array<[key: string, limit: number]>,
): Promise<boolean> {
  for (const [key, limit] of limits) {
    const result = await hitRateLimit(key, limit, config.passwordReset.windowSeconds);
    if (!result.allowed) {
      reply
        .code(429)
        .header('retry-after', String(result.retryAfterSeconds))
        .send({ error: 'too many requests' });
      return true;
    }
  }
  return false;
}

/* A real hash of a throwaway secret, verified when the e-mail is unknown so a
 * login attempt costs the same either way and response time does not reveal
 * which addresses are registered. */
const DUMMY_HASH = await hashPassword(randomBytes(32).toString('hex'));

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post<{ Body: CredentialsBody }>('/auth/register', {
    schema: {
      tags: ['auth'],
      summary: 'Create an account',
      body: registerBodySchema,
      response: { 201: tokenSchema, 409: errorSchema },
    },
  }, async (request, reply) => {
    const user = await createUser(request.body.email, await hashPassword(request.body.password));
    if (!user) return reply.code(409).send({ error: 'email already registered' });

    return reply.code(201).send({
      token: app.jwt.sign({ sub: String(user.id), email: user.email, ver: user.tokenVersion }),
      expiresIn: config.auth.tokenTtlSeconds,
    });
  });

  app.post<{ Body: CredentialsBody }>('/auth/login', {
    schema: {
      tags: ['auth'],
      summary: 'Exchange credentials for a token',
      body: loginBodySchema,
      response: { 200: tokenSchema, 401: errorSchema },
    },
  }, async (request, reply) => {
    const user = await findUserByEmail(request.body.email);
    const matches = await verifyPassword(request.body.password, user?.passwordHash ?? DUMMY_HASH);

    /* One message for both failure modes — "no such user" tells an attacker
     * which e-mails exist. */
    if (!user || !matches) return reply.code(401).send({ error: 'invalid credentials' });

    return reply.send({
      token: app.jwt.sign({ sub: String(user.id), email: user.email, ver: user.tokenVersion }),
      expiresIn: config.auth.tokenTtlSeconds,
    });
  });

  app.post<{ Body: ForgotPasswordBody }>('/auth/forgot-password', {
    schema: {
      tags: ['auth'],
      summary: 'E-mail a password reset token',
      description:
        'Answers 202 and sends the e-mail when the address is registered, 404 ' +
        'when it is not. Asking again cancels the previous token.',
      body: forgotPasswordBodySchema,
      response: {
        202: { type: 'object', properties: { message: { type: 'string' } } },
        404: errorSchema,
        429: errorSchema,
        503: errorSchema,
      },
    },
  }, async (request, reply) => {
    /* Fails closed: without Redis there is nowhere to keep the token or the
     * counters, and the answer is the same for every address. */
    if (!redisClient.isReady) return reply.code(503).send(RESET_UNAVAILABLE);
    const email = request.body.email.toLowerCase();

    try {
      /* Per address as well as per IP, so one inbox cannot be flooded from many
       * addresses. Keyed on a digest so Redis never holds the address. */
      const limited = await rateLimited(reply, [
        [`ratelimit:forgot:ip:${request.ip}`, config.passwordReset.maxPerIp],
        [`ratelimit:forgot:email:${sha256(email)}`, config.passwordReset.maxPerEmail],
      ]);
      if (limited) return reply;
    } catch (error) {
      request.log.warn({ err: (error as Error).message }, 'password reset rate limit check failed');
      return reply.code(503).send(RESET_UNAVAILABLE);
    }

    /* After the rate limit, so the 404 cannot be used to check addresses in bulk. */
    const userId = await findUserIdByEmail(email);
    if (userId === null) return reply.code(404).send(EMAIL_NOT_REGISTERED);

    /* Not awaited: see requestPasswordReset. Failures, including SMTP not being
     * configured, are logged and never reach the caller. */
    void requestPasswordReset(userId, email, { logger: request.log }).catch((error: Error) => {
      request.log.error({ err: error.message }, 'password reset e-mail failed');
    });

    return reply.code(202).send(FORGOT_ACCEPTED);
  });

  app.post<{ Body: ResetPasswordBody }>('/auth/reset-password', {
    schema: {
      tags: ['auth'],
      summary: 'Choose a new password with a reset token',
      description:
        'The token works once and expires. A successful reset revokes every ' +
        'token issued before it and returns a fresh one.',
      body: resetPasswordBodySchema,
      response: { 200: tokenSchema, 400: errorSchema, 429: errorSchema, 503: errorSchema },
    },
  }, async (request, reply) => {
    if (!redisClient.isReady) return reply.code(503).send(RESET_UNAVAILABLE);

    let userId: number | null;
    try {
      const limited = await rateLimited(reply, [
        [`ratelimit:reset:ip:${request.ip}`, config.passwordReset.maxPerIp],
      ]);
      if (limited) return reply;
      userId = await consumeResetToken(request.body.token);
    } catch (error) {
      request.log.warn({ err: (error as Error).message }, 'password reset token check failed');
      return reply.code(503).send(RESET_UNAVAILABLE);
    }
    if (userId === null) return reply.code(400).send(INVALID_RESET_TOKEN);

    /* Hashed only once the token checked out, so a stream of bad tokens does not
     * buy scrypt time. */
    const user = await resetPassword(userId, await hashPassword(request.body.password));
    if (!user) return reply.code(400).send(INVALID_RESET_TOKEN);

    request.log.info({ userId }, 'password reset');
    return reply.send({
      token: app.jwt.sign({ sub: String(user.id), email: user.email, ver: user.tokenVersion }),
      expiresIn: config.auth.tokenTtlSeconds,
    });
  });
}

/* Registered inside the protected scope in app.ts, so it needs a valid token to
 * revoke one. */
export async function accountRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/logout-all', {
    schema: {
      tags: ['auth'],
      security: [{ bearerAuth: [] }], 
      summary: 'Revoke every token issued to this account',
      description:
        'Increments the account token version, so every token signed before ' +
        'this call stops verifying — including the one used to make it. Use ' +
        'after a suspected leak. POST /auth/reset-password does the same.',
      response: {
        200: {
          type: 'object',
          properties: {
            tokenVersion: { type: 'integer', description: 'The new version; older tokens no longer verify.' },
          },
        },
        401: errorSchema,
      },
    },
  }, async (request, reply) => {
    const version = await bumpTokenVersion(ownerOf(request));
    if (version === null) return reply.code(401).send({ error: 'invalid or expired token' });

    return reply.send({ tokenVersion: version });
  });
}
