/* Cloudflare Turnstile, checked on the routes that send e-mail to an address
 * the caller chooses: register and forgot-password. The widget in the browser
 * only produces a token; this is where it is worth something, since a bot can
 * call the API without ever loading the page. */

import { config } from '../config.ts';

const VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

interface SiteverifyResponse {
  success: boolean;
  'error-codes'?: string[];
}

export function captchaEnabled(): boolean {
  return config.captcha.secretKey !== null;
}

/* True when Cloudflare accepts the token. A token is single use, so the page
 * has to fetch a new one after every attempt. Throws when Cloudflare cannot be
 * reached; the route fails closed on that. */
export async function verifyCaptcha(token: string | undefined, ip: string): Promise<boolean> {
  if (!config.captcha.secretKey) return true;
  if (!token) return false;

  const response = await fetch(VERIFY_URL, {
    method: 'POST',
    body: new URLSearchParams({ secret: config.captcha.secretKey, response: token, remoteip: ip }),
    signal: AbortSignal.timeout(config.captcha.timeoutMs),
  });
  if (!response.ok) throw new Error(`siteverify answered ${response.status}`);

  const body = (await response.json()) as SiteverifyResponse;
  return body.success === true;
}
