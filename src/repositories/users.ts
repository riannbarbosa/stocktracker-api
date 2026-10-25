import { pool } from '../db/pool.ts';
import type { User } from '../types/auth.ts';

interface UserRow {
  id: string | number;
  email: string;
  password_hash: string;
  token_version: number;
  created_at: Date;
}

const COLUMNS = 'id, email, password_hash, token_version, created_at';

function toUser(row: UserRow): User {
  return {
    id: Number(row.id),
    email: row.email,
    tokenVersion: Number(row.token_version),
    createdAt: row.created_at.toISOString(),
  };
}

/* Returns null when the address is taken. ON CONFLICT DO NOTHING rather than
 * catching SQLSTATE 23505: a duplicate is an expected outcome of a public
 * register endpoint, not an exception. */
export async function createUser(email: string, passwordHash: string): Promise<User | null> {
  const { rows } = await pool.query<UserRow>(
    `INSERT INTO users (email, password_hash) VALUES ($1, $2)
     ON CONFLICT (email) DO NOTHING
     RETURNING ${COLUMNS}`,
    [email.toLowerCase(), passwordHash],
  );
  const row = rows[0];
  return row ? toUser(row) : null;
}

/* The only function that hands out the hash, and its return type says so.
 * Everything else goes through findUserById. */
export async function findUserByEmail(
  email: string,
): Promise<(User & { passwordHash: string }) | null> {
  const { rows } = await pool.query<UserRow>(
    `SELECT ${COLUMNS} FROM users WHERE email = $1`,
    [email.toLowerCase()],
  );
  const row = rows[0];
  return row ? { ...toUser(row), passwordHash: row.password_hash } : null;
}

export async function findUserById(id: number): Promise<User | null> {
  const { rows } = await pool.query<UserRow>(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [id]);
  const row = rows[0];
  return row ? toUser(row) : null;
}

/* Read on every authenticated request. A primary-key lookup on a small table,
 * which is the price of being able to revoke a stateless token at all. Returns
 * null when the user no longer exists, so a deleted account's tokens stop
 * working immediately too. */
export async function currentTokenVersion(id: number): Promise<number | null> {
  const { rows } = await pool.query<{ token_version: number }>(
    'SELECT token_version FROM users WHERE id = $1',
    [id],
  );
  const row = rows[0];
  return row ? Number(row.token_version) : null;
}

/* Invalidates every token already issued to this user. */
export async function bumpTokenVersion(id: number): Promise<number | null> {
  const { rows } = await pool.query<{ token_version: number }>(
    'UPDATE users SET token_version = token_version + 1 WHERE id = $1 RETURNING token_version',
    [id],
  );
  const row = rows[0];
  return row ? Number(row.token_version) : null;
}

/* For the forgot-password flow, which only needs to know whether to send. */
export async function findUserIdByEmail(email: string): Promise<number | null> {
  const { rows } = await pool.query<{ id: string | number }>(
    'SELECT id FROM users WHERE email = $1',
    [email.toLowerCase()],
  );
  const row = rows[0];
  return row ? Number(row.id) : null;
}

/* Sets the new hash and bumps token_version in one statement, so every token
 * issued before the reset — including any held by whoever knew the old
 * password — stops verifying at the same moment the password changes. */
export async function resetPassword(id: number, passwordHash: string): Promise<User | null> {
  const { rows } = await pool.query<UserRow>(
    `UPDATE users SET password_hash = $2, token_version = token_version + 1
     WHERE id = $1
     RETURNING ${COLUMNS}`,
    [id, passwordHash],
  );
  const row = rows[0];
  return row ? toUser(row) : null;
}
