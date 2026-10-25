import Fastify from 'fastify';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUi from '@fastify/swagger-ui';
import fastifyJwt from '@fastify/jwt';
import type { FastifyInstance, FastifyServerOptions } from 'fastify';
import { config } from './config.ts';
import { authenticate } from './plugins/authenticate.ts';
import { healthRoutes } from './routes/health.ts';
import { quoteRoutes } from './routes/quotes.ts';
import { accountRoutes, authRoutes } from './routes/auth.ts';
import { alertRoutes } from './routes/alerts.ts';
import { watchlistRoutes } from './routes/watchlist.ts'
import { notificationRoutes } from './routes/notifications.ts';
import { digestRoutes } from './routes/digest.ts';

const REQUIRES_AUTH = 'Requires Auth';

export async function buildApp(options: FastifyServerOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: { level: config.logLevel },
    trustProxy: config.trustProxy,
     ajv: { customOptions: { strict: false } },
   ...options,    
  });

  /* Registered before the routes: @fastify/swagger collects each route's schema
   * as it is added, so anything registered earlier is missing from the spec. */
  await app.register(fastifySwagger, {
    openapi: {
      openapi: '3.1.0',
      info: {
        title: 'stocktracker-api',
        description:
          'REST API serving B3 stock quotes with Redis caching, plus price alerts ' +
          'evaluated by a background poller.',
        version: '1.0.0',
      },
      servers: [{ url: `http://localhost:${config.port}`, description: 'Local' }],
      tags: [
        { name: 'quotes', description: 'B3 quote lookups, served from Redis when cached.' },
        { name: 'watchlist', description: 'Tickers tracked for an owner.' },
        { name: 'alerts', description: 'Price alerts evaluated by the background poller.' },
        { name: 'notifications', description: 'In-app notifications created when an alert fires.' },
        { name: 'digest', description: 'Periodic watchlist summary sent by email.' },
        { name: 'health', description: 'Liveness and readiness probes.' },
        { name: 'auth', description: 'Account creation, token issue and password reset.' },
      ],
      /* Gives Swagger UI its Authorize button; the protected routes reference
       * this scheme from their own schema. */
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
    },
  });

  await app.register(fastifySwaggerUi, {
    routePrefix: '/docs',
    uiConfig: { docExpansion: 'list', deepLinking: true }
  });

  /* Registered before the routes so app.jwt exists when /auth/login signs, and
   * before the hook that verifies. expiresIn is in seconds — verified by
   * decoding a signed token, since fast-jwt documents some spans in ms. */
  await app.register(fastifyJwt, {
    secret: config.auth.jwtSecret,
    sign: { expiresIn: config.auth.tokenTtlSeconds },
    formatUser: (payload) => ({ id: Number(payload.sub), email: payload.email, tokenVersion: payload.ver }),
  });

  app.register(healthRoutes);
  app.register(quoteRoutes);
  app.register(authRoutes);

  /* The hook is scoped to this plugin, so every route registered inside is
   * authenticated and a new one cannot be added unprotected by accident. */
  app.register(async (secured) => {
    secured.addHook('onRequest', authenticate);
    secured.addHook('onRoute', (route) => {
      const schema = (route.schema ??= {}) as { summary?: string; security?: unknown[] };
      schema.security ??= [{ bearerAuth: [] }];
      if (!schema.summary?.includes(REQUIRES_AUTH)) {
        schema.summary = schema.summary ? `${schema.summary} (${REQUIRES_AUTH})` : REQUIRES_AUTH;
      } 
    });
    await secured.register(accountRoutes);
    await secured.register(alertRoutes);
    await secured.register(watchlistRoutes);
    await secured.register(notificationRoutes);
    await secured.register(digestRoutes);
  });

  return app; 
}
