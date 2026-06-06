import { createHash, randomBytes } from 'crypto';
import { v4 as uuidv4 } from 'uuid';
import { getPool } from '../config-sql/database.js';
import { SELF_REGISTRATION_ROUTE_KEY } from '../utils/joiningSelfRegistration.util.js';

/** Self-registration campus QR never expires (unlike 5-minute staff invite links). */
export const SELF_REGISTRATION_PERMANENT_EXPIRES_AT = '2099-12-31 23:59:59';

let selfRegTableReady = false;

async function ensureSelfRegistrationLinkTable(pool) {
  if (selfRegTableReady) return;
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS joining_self_registration_link (
      id CHAR(36) PRIMARY KEY,
      token_plain VARCHAR(128) NOT NULL,
      token_hash CHAR(64) NOT NULL,
      public_edit_token_id CHAR(36) NULL,
      created_by CHAR(36) NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uk_self_reg_token_hash (token_hash)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  selfRegTableReady = true;
}

function resolvePublicJoiningBaseUrl() {
  const base =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.FRONTEND_URL ||
    process.env.PUBLIC_JOINING_FORM_BASE_URL ||
    '';
  return base ? String(base).replace(/\/$/, '') : '';
}

export function buildSelfRegistrationPublicLink(rawToken) {
  const path = `/joining/public?t=${encodeURIComponent(rawToken)}`;
  const base = resolvePublicJoiningBaseUrl();
  const publicUrl = base ? `${base}${path}` : path;
  return {
    path,
    publicUrl,
    token: rawToken,
    permanent: true,
    expiresAt: null,
    ttlSeconds: null,
  };
}

async function readStoredSelfRegistrationLink(pool) {
  await ensureSelfRegistrationLinkTable(pool);
  const [rows] = await pool.execute(
    `SELECT id, token_plain, token_hash, public_edit_token_id, created_at, updated_at
     FROM joining_self_registration_link
     ORDER BY created_at ASC
     LIMIT 1`
  );
  return rows.length ? rows[0] : null;
}

async function insertPermanentSelfRegistrationToken(pool, rawToken, userId) {
  const tokenHash = createHash('sha256').update(rawToken, 'utf8').digest('hex');
  const configId = uuidv4();
  const publicTokenId = uuidv4();

  await pool.execute(
    `INSERT INTO joining_public_edit_tokens (id, token_hash, route_key, expires_at, created_by)
     VALUES (?, ?, ?, ?, ?)`,
    [
      publicTokenId,
      tokenHash,
      SELF_REGISTRATION_ROUTE_KEY,
      SELF_REGISTRATION_PERMANENT_EXPIRES_AT,
      userId || null,
    ]
  );

  await pool.execute(
    `INSERT INTO joining_self_registration_link
       (id, token_plain, token_hash, public_edit_token_id, created_by)
     VALUES (?, ?, ?, ?, ?)`,
    [configId, rawToken, tokenHash, publicTokenId, userId || null]
  );

  return { configId, publicTokenId, tokenHash, rawToken };
}

async function deleteSelfRegistrationLinkArtifacts(pool) {
  await ensureSelfRegistrationLinkTable(pool);
  const stored = await readStoredSelfRegistrationLink(pool);
  if (stored?.public_edit_token_id) {
    await pool.execute('DELETE FROM joining_public_edit_tokens WHERE id = ?', [
      stored.public_edit_token_id,
    ]);
  }
  await pool.execute(`DELETE FROM joining_public_edit_tokens WHERE route_key = ?`, [
    SELF_REGISTRATION_ROUTE_KEY,
  ]);
  await pool.execute('DELETE FROM joining_self_registration_link');
}

/**
 * Return the campus self-registration URL/QR payload. Creates once, then reuses forever.
 * @param {{ forceRegenerate?: boolean }} options
 */
export async function ensureSelfRegistrationPublicLink(userId = null, options = {}) {
  const pool = getPool();
  const { forceRegenerate = false } = options;

  if (forceRegenerate) {
    await deleteSelfRegistrationLinkArtifacts(pool);
  }

  const existing = await readStoredSelfRegistrationLink(pool);
  if (existing?.token_plain) {
    const plain = String(existing.token_plain).trim();
    const [tokenRow] = await pool.execute(
      `SELECT id FROM joining_public_edit_tokens
       WHERE token_hash = ? AND route_key = ?
       LIMIT 1`,
      [existing.token_hash, SELF_REGISTRATION_ROUTE_KEY]
    );

    if (tokenRow.length > 0) {
      return {
        ...buildSelfRegistrationPublicLink(plain),
        created: false,
        configuredAt: existing.created_at,
      };
    }

    // Config row exists but public token row missing — repair without rotating the QR.
    const tokenHash = createHash('sha256').update(plain, 'utf8').digest('hex');
    const publicTokenId = uuidv4();
    await pool.execute(
      `INSERT INTO joining_public_edit_tokens (id, token_hash, route_key, expires_at, created_by)
       VALUES (?, ?, ?, ?, ?)`,
      [
        publicTokenId,
        tokenHash,
        SELF_REGISTRATION_ROUTE_KEY,
        SELF_REGISTRATION_PERMANENT_EXPIRES_AT,
        userId || null,
      ]
    );
    await pool.execute(
      `UPDATE joining_self_registration_link
       SET public_edit_token_id = ?, token_hash = ?, updated_at = NOW()
       WHERE id = ?`,
      [publicTokenId, tokenHash, existing.id]
    );
    return {
      ...buildSelfRegistrationPublicLink(plain),
      created: false,
      configuredAt: existing.created_at,
      repaired: true,
    };
  }

  const rawToken = randomBytes(16).toString('base64url');
  await insertPermanentSelfRegistrationToken(pool, rawToken, userId);
  return {
    ...buildSelfRegistrationPublicLink(rawToken),
    created: true,
  };
}

/** Read stored link only (no create). Returns null when not configured yet. */
export async function getSelfRegistrationPublicLinkIfConfigured() {
  const pool = getPool();
  const existing = await readStoredSelfRegistrationLink(pool);
  if (!existing?.token_plain) return null;

  const plain = String(existing.token_plain).trim();
  const [tokenRow] = await pool.execute(
    `SELECT id FROM joining_public_edit_tokens
     WHERE token_hash = ? AND route_key = ?
     LIMIT 1`,
    [existing.token_hash, SELF_REGISTRATION_ROUTE_KEY]
  );
  if (!tokenRow.length) return null;

  return {
    ...buildSelfRegistrationPublicLink(plain),
    configuredAt: existing.created_at,
  };
}
