/**
 * secret-box unit tests — seal/open roundtrip, tamper detection, key handling.
 * Env is passed explicitly (no process.env mutation) — the module accepts an env arg.
 */

import { describe, it, expect } from 'vitest';
import { sealSecret, openSecret, isSealed, hasSecretKey, maskSecret } from '~/server/security/secret-box';

const ENV = { KIN_SECRET_KEY: 'test-master-key-0123456789abcdef' } as NodeJS.ProcessEnv;
const OTHER = { KIN_SECRET_KEY: 'a-different-master-key' } as NodeJS.ProcessEnv;
const EMPTY = {} as NodeJS.ProcessEnv;

describe('secret-box', () => {
  it('roundtrips plaintext', () => {
    const sealed = sealSecret('sk-ant-verysecret-123', ENV);
    expect(isSealed(sealed)).toBe(true);
    expect(sealed).not.toContain('verysecret');
    expect(openSecret(sealed, ENV)).toBe('sk-ant-verysecret-123');
  });

  it('roundtrips unicode + long values', () => {
    const long = '密钥🔑'.repeat(500);
    expect(openSecret(sealSecret(long, ENV), ENV)).toBe(long);
  });

  it('produces distinct ciphertexts for the same plaintext (random IV)', () => {
    expect(sealSecret('same', ENV)).not.toBe(sealSecret('same', ENV));
  });

  it('rejects tampered ciphertext (GCM auth)', () => {
    const sealed = sealSecret('secret', ENV);
    const parts = sealed.split('.');
    // flip a char in the ciphertext part
    parts[3] = parts[3].slice(0, -2) + (parts[3].endsWith('A') ? 'BB' : 'AA');
    expect(() => openSecret(parts.join('.'), ENV)).toThrow(/decryption failed/);
  });

  it('rejects the wrong master key', () => {
    const sealed = sealSecret('secret', ENV);
    expect(() => openSecret(sealed, OTHER)).toThrow(/decryption failed/);
  });

  it('throws clearly when KIN_SECRET_KEY is unset', () => {
    expect(hasSecretKey(EMPTY)).toBe(false);
    expect(hasSecretKey(ENV)).toBe(true);
    expect(() => sealSecret('x', EMPTY)).toThrow(/KIN_SECRET_KEY/);
    const sealed = sealSecret('x', ENV);
    expect(() => openSecret(sealed, EMPTY)).toThrow(/KIN_SECRET_KEY/);
  });

  it('isSealed distinguishes sealed values from plaintext', () => {
    expect(isSealed('sk-ant-raw-token')).toBe(false);
    expect(isSealed('')).toBe(false);
    expect(isSealed(sealSecret('x', ENV))).toBe(true);
  });

  it('masks secrets to last 4 chars', () => {
    expect(maskSecret('sk-abcdefgh1234')).toBe('••••1234');
    expect(maskSecret('')).toBe('');
  });
});
