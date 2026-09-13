import { describe, it, expect } from 'vitest';
import { normalizePackageChannelType, PACKAGE_CHANNEL_TYPE, GUILD_CHANNEL_TYPES } from './packageTypes';

describe('normalizePackageChannelType (#270)', () => {
  it.each([
    [1, 1],
    ['1', 1],
    ['DM', 1],
    ['dm', 1],
    [' Group_DM ', 3],
    ['GUILD_TEXT', 0],
    [0, 0],
    [11, 11],
    [12, 12],
    [15, 15],
    ['PUBLIC_THREAD', 11],
    ['PRIVATE_THREAD', 12],
    ['ANNOUNCEMENT_THREAD', 10],
    ['GUILD_FORUM', 15],
  ])('resolves %p to %p', (raw, expected) => {
    expect(normalizePackageChannelType(raw)).toBe(expected);
  });

  it.each([[undefined], [null], ['nonsense'], [99], ['99'], [{}], [-1]])('returns null for %p', (raw) => {
    expect(normalizePackageChannelType(raw)).toBeNull();
  });

  it('never resolves to UNKNOWN itself', () => {
    expect(normalizePackageChannelType(PACKAGE_CHANNEL_TYPE.UNKNOWN)).toBeNull();
    expect(GUILD_CHANNEL_TYPES.has(PACKAGE_CHANNEL_TYPE.UNKNOWN)).toBe(false);
  });
});
