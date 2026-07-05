/**
 * secret-box — AES-256-GCM sealing for credentials stored in the DB (registry v2).
 *
 * Plain JS (like build-worker-env.js) so BOTH the TS app (allowJs) and the separate
 * `ws-server.mjs` node process can import it. The master key comes from the
 * `KIN_SECRET_KEY` env var — generated once at install time (e.g. `openssl rand -hex
 * 32` in the installer/compose); end users never touch it. Losing the key makes DB
 * credentials undecryptable (they must be re-entered in the admin UI) but breaks
 * nothing else — resolution falls back to env[tokenEnv].
 *
 * Sealed format (versioned, all base64url): `v1.<iv>.<authTag>.<ciphertext>`.
 * The format is self-describing so a future v2 (e.g. key rotation) can coexist.
 *
 * See docs/4. PRD/2026-07-05-模型注册表v2与全局变量-PRD.md (coordination repo) §3 K1.
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const ALG = 'aes-256-gcm';
const IV_BYTES = 12;

/** @param {NodeJS.ProcessEnv} [env] */
function deriveKey(env = process.env) {
  const raw = env.KIN_SECRET_KEY;
  if (!raw || !String(raw).trim()) return null;
  // Accept any non-empty string; hash to exactly 32 bytes. (Hex/base64/passphrase
  // all work — installers SHOULD generate ≥32 random bytes.)
  return createHash('sha256').update(String(raw), 'utf8').digest();
}

/** Whether the server has a master key configured (UI uses this to gate the paste field). */
export function hasSecretKey(env = process.env) {
  return deriveKey(env) !== null;
}

/** Quick shape check — is this value a sealed secret produced by sealSecret()? */
export function isSealed(value) {
  return typeof value === 'string' && value.startsWith(`${VERSION}.`) && value.split('.').length === 4;
}

/**
 * Encrypt a plaintext secret for DB storage.
 * @param {string} plaintext
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} sealed string `v1.<iv>.<tag>.<ct>` (base64url parts)
 */
export function sealSecret(plaintext, env = process.env) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) {
    throw new Error('sealSecret: plaintext must be a non-empty string');
  }
  const key = deriveKey(env);
  if (!key) {
    throw new Error(
      'sealSecret: KIN_SECRET_KEY is not set on the server. Generate one (e.g. `openssl rand -hex 32`) and set it in the deployment env.',
    );
  }
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALG, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
}

/**
 * Decrypt a sealed secret. Throws on missing key, wrong key, or tampering
 * (GCM auth failure) — callers treat any throw as "credential unavailable".
 * @param {string} sealed
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string} plaintext
 */
export function openSecret(sealed, env = process.env) {
  if (!isSealed(sealed)) throw new Error('openSecret: value is not a sealed secret');
  const key = deriveKey(env);
  if (!key) throw new Error('openSecret: KIN_SECRET_KEY is not set on the server');
  const [, ivB64, tagB64, ctB64] = sealed.split('.');
  const decipher = createDecipheriv(ALG, key, Buffer.from(ivB64, 'base64url'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
  try {
    return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    throw new Error('openSecret: decryption failed (wrong KIN_SECRET_KEY or corrupted value)');
  }
}

/**
 * Mask a plaintext secret for UI display: keep the last 4 chars.
 * @param {string} plaintext
 */
export function maskSecret(plaintext) {
  if (typeof plaintext !== 'string' || plaintext.length === 0) return '';
  const tail = plaintext.slice(-4);
  return `••••${tail}`;
}
