/* The quote service talks to the redis singleton directly, so the tests shadow
 * the handful of commands it uses with own properties on that instance and put
 * the original descriptors back afterwards. Nothing ever connects. */

import { redisClient } from '../../src/redis/redis.ts';

export interface RecordedSet {
  key: string;
  value: string;
  options: { EX: number };
}

export interface RecordedEval {
  script: string;
  keys: string[];
  args: string[];
}

export type EvalHandler = (script: string, keys: string[], args: string[]) => unknown;

export interface FakeRedis {
  /** Seed with `cacheKey -> serialized quote` to prime cache hits. */
  stored: Map<string, string>;
  setCalls: RecordedSet[];
  mGetCalls: string[][];
  delCalls: string[];
  evalCalls: RecordedEval[];
  readonly execCount: number;
  /** Reply to EVAL; the default answers null. */
  handleEval: (handler: EvalHandler) => void;
  setReady: (ready: boolean) => void;
  failMGet: (error: Error) => void;
  failExec: (error: Error) => void;
  failDel: (error: Error) => void;
  restore: () => void;
}

export function fakeRedis(): FakeRedis {
  const original = new Map<string, PropertyDescriptor | undefined>();
  const stored = new Map<string, string>();
  const setCalls: RecordedSet[] = [];
  const mGetCalls: string[][] = [];
  const delCalls: string[] = [];
  const evalCalls: RecordedEval[] = [];
  let evalHandler: EvalHandler = () => null;
  let execCount = 0;
  let mGetError: Error | null = null;
  let execError: Error | null = null;
  let delError: Error | null = null;

  function shadow(key: string, value: unknown): void {
    if (!original.has(key)) original.set(key, Object.getOwnPropertyDescriptor(redisClient, key));
    Object.defineProperty(redisClient, key, { value, configurable: true, writable: true });
  }

  const tx = {
    set(key: string, value: string, options: { EX: number }) {
      setCalls.push({ key, value, options });
      return tx;
    },
    async exec() {
      execCount += 1;
      if (execError) throw execError;
      return [];
    },
  };

  shadow('isReady', true);
  shadow('mGet', async (keys: string[]) => {
    mGetCalls.push(keys);
    if (mGetError) throw mGetError;
    return keys.map((key) => stored.get(key) ?? null);
  });
  shadow('multi', () => tx);
  /* A direct SET lands in the same records as one queued on a transaction. */
  shadow('set', async (key: string, value: string, options: { EX: number }) => {
    setCalls.push({ key, value, options });
    stored.set(key, value);
    return 'OK';
  });
  shadow('eval', async (script: string, options: { keys?: string[]; arguments?: string[] } = {}) => {
    const call = { script, keys: options.keys ?? [], args: options.arguments ?? [] };
    evalCalls.push(call);
    return evalHandler(call.script, call.keys, call.args);
  });
  shadow('del', async (key: string) => {
    delCalls.push(key);
    if (delError) throw delError;
    return 1;
  });

  return {
    stored,
    setCalls,
    mGetCalls,
    delCalls,
    evalCalls,
    get execCount() {
      return execCount;
    },
    handleEval(handler) {
      evalHandler = handler;
    },
    setReady(ready) {
      shadow('isReady', ready);
    },
    failMGet(error) {
      mGetError = error;
    },
    failExec(error) {
      execError = error;
    },
    failDel(error) {
      delError = error;
    },
    restore() {
      for (const [key, descriptor] of original) {
        if (descriptor) Object.defineProperty(redisClient, key, descriptor);
        else Reflect.deleteProperty(redisClient, key);
      }
      original.clear();
    },
  };
}

/* Gives EVAL the behaviour of the two scripts the app runs — the rate limiter's
 * INCR/EXPIRE and the reset token's compare-and-delete — over `stored`, so a
 * test can exercise them end to end without a server. TTL is reported as the
 * full window. */
export function emulateScripts(redis: FakeRedis): void {
  const windows = new Map<string, number>();
  redis.handleEval((script, keys, args) => {
    const key = keys[0] ?? '';
    if (script.includes("'INCR'")) {
      const count = Number(redis.stored.get(key) ?? 0) + 1;
      redis.stored.set(key, String(count));
      if (count === 1) windows.set(key, Number(args[0]));
      return [count, windows.get(key) ?? -1];
    }
    if (script.includes("'DEL'")) {
      if (redis.stored.get(key) !== args[0]) return 0;
      redis.stored.delete(key);
      return 1;
    }
    throw new Error(`unexpected script: ${script}`);
  });
}
