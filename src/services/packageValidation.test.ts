import { describe, it, expect } from 'vitest';
import { validatePackage, PackageParseError } from './packageValidation';
import type { ParsedPackage } from '@/features/package/packageTypes';

const parsedFor = (userId: string, username = 'prathercc'): ParsedPackage => ({
  user: { id: userId, username, globalName: null, avatarHash: null },
  guilds: [],
  channels: [],
  totalMessages: 0,
  packageSizeBytes: 1,
});

describe('validatePackage', () => {
  it('returns full-access when authenticated user ID matches', () => {
    const result = validatePackage(parsedFor('253286221395001345'), '253286221395001345');
    expect(result.ok).toBe(true);
    expect(result.readOnly).toBe(false);
    expect(result.errors).toEqual([]);
  });

  it('returns read-only with a warning when auth is null', () => {
    const result = validatePackage(parsedFor('253286221395001345'), null);
    expect(result.ok).toBe(true);
    expect(result.readOnly).toBe(true);
    expect(result.warnings.length).toBeGreaterThan(0);
  });

  it('returns read-only with a warning when user ID mismatches', () => {
    const result = validatePackage(parsedFor('abc'), 'xyz');
    expect(result.ok).toBe(true);
    expect(result.readOnly).toBe(true);
    expect(result.warnings[0]).toMatch(/different user/i);
  });

  it('fails a package with no user identity', () => {
    const result = validatePackage({ ...parsedFor(''), user: { id: '', username: '', globalName: null, avatarHash: null } }, 'xyz');
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toMatch(/user\.json/);
  });
});

describe('PackageParseError', () => {
  it('carries its name for friendly error mapping', () => {
    const err = new PackageParseError('boom');
    expect(err.name).toBe('PackageParseError');
    expect(err.message).toBe('boom');
    expect(err).toBeInstanceOf(Error);
  });
});
