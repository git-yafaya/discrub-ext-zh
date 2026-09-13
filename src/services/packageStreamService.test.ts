import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import {
  streamPackageToStorage,
  importPackageToStorage,
  loadChannelMessagesFromStorage,
  resumePackageFromStorage,
  clearPackageContents,
  hasStoredPackage,
  PackageStreamCancelledError,
  PKG_SCHEMA_VERSION,
} from './packageStreamService';
import { PackageParseError } from './packageValidation';
import { storage } from '@/extension/storage';
import { buildFixturePackage } from '@/test/package-fixtures';
import * as fflate from 'fflate';

// #210 regression guard: wrap fflate's unzip entry points in pass-through
// spies (behaviour preserved via `...actual`) so a test can assert the import
// path decompresses with the SYNCHRONOUS `unzipSync` and never fflate's
// worker-backed async `unzip` — the latter structured-clones each entry across
// postMessage and OOMs ("Data cannot be cloned" / "Array buffer allocation
// failed") on multi-GB packages. See backlog #210/#203/#162.
let unzipConstructions = 0;
vi.mock('fflate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fflate')>();
  class CountingUnzip extends actual.Unzip {
    constructor(...args: ConstructorParameters<typeof actual.Unzip>) {
      super(...args);
      unzipConstructions++;
    }
  }
  return { ...actual, Unzip: CountingUnzip, unzipSync: vi.fn(actual.unzipSync), unzip: vi.fn(actual.unzip) };
});

// jsdom does not implement URL.createObjectURL. Stub it with a counter-keyed
// fake so tests can assert the streamer produced a blob URL string and that
// resume mints a distinct one each time it's called. Real browsers handle
// this natively; we're only patching the test environment.
let blobUrlCounter = 0;
beforeAll(() => {
  if (typeof URL.createObjectURL !== 'function') {
    Object.assign(URL, {
      createObjectURL: () => `blob:fake/${++blobUrlCounter}`,
      revokeObjectURL: () => {},
    });
  }
});

beforeEach(async () => {
  await storage.package.clear();
});

describe('streamPackageToStorage', () => {
  describe('happy path', () => {
    it('returns the same ParsedPackage shape parsePackageZip returns', async () => {
      const blob = await buildFixturePackage();
      const parsed = await streamPackageToStorage(blob);

      expect(parsed.user.id).toBe('253286221395001345');
      expect(parsed.user.username).toBe('prathercc');
      expect(parsed.user.globalName).toBe('Aaron');
      expect(parsed.guilds).toEqual([{ id: '100', name: 'Test Guild' }]);
      expect(parsed.channels).toHaveLength(2);
      expect(parsed.totalMessages).toBe(4);
    });

    it('reads through the streaming Unzip, never unzipSync or the worker-backed unzip (#269, #210)', async () => {
      const blob = await buildFixturePackage();
      vi.mocked(fflate.unzipSync).mockClear();
      vi.mocked(fflate.unzip).mockClear();
      unzipConstructions = 0;
      await streamPackageToStorage(blob);
      expect(fflate.unzipSync).not.toHaveBeenCalled();
      expect(fflate.unzip).not.toHaveBeenCalled();
      // Two passes: one to find user.json, one for everything else.
      expect(unzipConstructions).toBe(2);
    });

    it('writes pkg:meta:{userId} as the commit marker, last', async () => {
      const blob = await buildFixturePackage();
      await streamPackageToStorage(blob);

      const meta = await storage.package.get('pkg:meta:253286221395001345');
      expect(meta).toBeTruthy();
      expect((meta as any).user.id).toBe('253286221395001345');
      // avatarBlobUrl is realm-scoped and must NOT be in the persisted meta
      // (see resume flow: the URL is rebuilt from the stored Blob each time).
      expect((meta as any).avatarBlobUrl).toBeUndefined();
    });

    it('writes pkg:msgs:{userId}:{channelId} for every channel', async () => {
      const blob = await buildFixturePackage();
      await streamPackageToStorage(blob);

      // Default fixture: channel 200 (guild text, 3 msgs) + channel 300 (DM, 1 msg).
      const ch200 = await storage.package.get('pkg:msgs:253286221395001345:200');
      const ch300 = await storage.package.get('pkg:msgs:253286221395001345:300');

      expect(Array.isArray(ch200)).toBe(true);
      expect(Array.isArray(ch300)).toBe(true);
      expect((ch200 as any[]).length).toBe(3);
      expect((ch300 as any[]).length).toBe(1);
    });

    it('writes pkg:schema-version=1', async () => {
      const blob = await buildFixturePackage();
      await streamPackageToStorage(blob);
      expect(await storage.package.get('pkg:schema-version')).toBe(PKG_SCHEMA_VERSION);
    });

    it('returns a fresh avatarBlobUrl when account/avatar.png is present', async () => {
      const blob = await buildFixturePackage({ includeAvatar: true });
      const parsed = await streamPackageToStorage(blob);

      expect(parsed.avatarBlobUrl).toMatch(/^blob:/);
      // The bytes were persisted (as Uint8Array, not Blob — see comment in
      // streamPackageToStorage for why). fake-indexeddb's structured clone
      // returns a cross-realm Uint8Array, so `instanceof` fails; check the
      // byte count instead.
      const persisted = await storage.package.get<Uint8Array>('pkg:avatar:253286221395001345');
      expect(persisted).toBeTruthy();
      expect(persisted!.length).toBe(8);
    });

    it('omits avatarBlobUrl when account/avatar.png is absent', async () => {
      const blob = await buildFixturePackage(); // no avatar
      const parsed = await streamPackageToStorage(blob);
      expect(parsed.avatarBlobUrl).toBeUndefined();
      expect(await storage.package.get('pkg:avatar:253286221395001345')).toBeNull();
    });
  });

  describe('input handling (#210/#203)', () => {
    // jsdom's Blob lacks `.arrayBuffer()`; mirror the production FileReader
    // fallback to extract the bytes for these tests.
    const readBlobBytes = (b: Blob): Promise<ArrayBuffer> =>
      new Promise((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(r.result as ArrayBuffer);
        r.onerror = () => reject(r.error ?? new Error('read failed'));
        r.readAsArrayBuffer(b);
      });

    it('accepts a pre-read ArrayBuffer and parses it identically (#203 eager-read path)', async () => {
      const blob = await buildFixturePackage();
      const buffer = await readBlobBytes(blob);
      const parsed = await streamPackageToStorage(buffer);

      expect(parsed.user.id).toBe('253286221395001345');
      expect(parsed.user.username).toBe('prathercc');
    });

    it('retries a transient NotReadableError on the initial read then succeeds (#203)', async () => {
      const blob = await buildFixturePackage();
      const realBuffer = await readBlobBytes(blob);

      // Fake a File whose first read throws NotReadableError (transient AV /
      // synced-folder relock) and whose second read succeeds.
      let reads = 0;
      const flakyFile = {
        size: realBuffer.byteLength,
        arrayBuffer: vi.fn(async () => {
          reads += 1;
          if (reads === 1) {
            const err = new Error('The requested file could not be read');
            err.name = 'NotReadableError';
            throw err;
          }
          return realBuffer;
        }),
      } as unknown as Blob;

      const parsed = await streamPackageToStorage(flakyFile);

      expect(flakyFile.arrayBuffer).toHaveBeenCalledTimes(2);
      expect(parsed.user.id).toBe('253286221395001345');
    });

    it('does not retry a non-NotReadableError read failure (#203)', async () => {
      const boom = {
        size: 10,
        arrayBuffer: vi.fn(async () => {
          throw new Error('some other failure');
        }),
      } as unknown as Blob;

      await expect(streamPackageToStorage(boom)).rejects.toThrow('some other failure');
      expect(boom.arrayBuffer).toHaveBeenCalledTimes(1);
    });
  });

  describe('progress reporting', () => {
    it('fires onProgress at least once per channel + once for avatar + once for meta', async () => {
      const blob = await buildFixturePackage();
      const onProgress = vi.fn();
      await streamPackageToStorage(blob, { onProgress });

      // 2 channels + avatar + meta = 4 ticks minimum
      expect(onProgress).toHaveBeenCalledTimes(4);
      // Final tick reports the meta-write step.
      const lastCall = onProgress.mock.calls[onProgress.mock.calls.length - 1];
      const final = lastCall[0];
      expect(final.current).toBe(4);
      expect(final.total).toBe(4);
      expect(final.path).toBe('package metadata');
    });

    it('progress current values monotonically increase from 1 to total', async () => {
      const blob = await buildFixturePackage();
      const seen: number[] = [];
      await streamPackageToStorage(blob, {
        onProgress: ({ current }) => seen.push(current),
      });
      // Each value should be 1 greater than the previous.
      seen.forEach((c, i) => expect(c).toBe(i + 1));
    });
  });

  describe('cancellation', () => {
    it('throws PackageStreamCancelledError when shouldStop returns true mid-stream', async () => {
      const blob = await buildFixturePackage();
      let calls = 0;
      const shouldStop = () => {
        calls++;
        // Allow the unzip to complete; cancel before the per-channel loop
        // makes its first IDB write.
        return calls > 1;
      };

      await expect(streamPackageToStorage(blob, { shouldStop }))
        .rejects.toBeInstanceOf(PackageStreamCancelledError);
    });

    it('cleans up partial pkg:* writes for the user when cancelled', async () => {
      const blob = await buildFixturePackage();
      let calls = 0;
      const shouldStop = () => {
        calls++;
        // Cancel after the user's id is known (call 1 lets unzip + readUserJson
        // through; call 2 fires before the channel-write loop's first iter).
        return calls > 1;
      };

      try {
        await streamPackageToStorage(blob, { shouldStop });
      } catch {
        // expected
      }
      // No meta key should exist for the cancelled user.
      const meta = await storage.package.get('pkg:meta:253286221395001345');
      expect(meta).toBeNull();
      // No channel msgs either.
      const allKeys = await storage.package.keys();
      const userKeys = allKeys.filter((k) => k.includes(':253286221395001345'));
      expect(userKeys).toEqual([]);
    });
  });

  describe('isolation across packages', () => {
    it('clears any prior pkg:* keys before writing the new package', async () => {
      // Pre-seed a prior import for a different user; it should be wiped
      // when a new import starts.
      await storage.package.set('pkg:meta:111111111111111111', { user: { id: '111111111111111111' } });
      await storage.package.set('pkg:msgs:111111111111111111:abc', [{ id: 'a' }]);
      await storage.package.set('pkg:avatar:111111111111111111', new Blob(['old']));

      const blob = await buildFixturePackage();
      await streamPackageToStorage(blob);

      // Old user's data is gone.
      expect(await storage.package.get('pkg:meta:111111111111111111')).toBeNull();
      expect(await storage.package.get('pkg:msgs:111111111111111111:abc')).toBeNull();
      expect(await storage.package.get('pkg:avatar:111111111111111111')).toBeNull();
      // New user's data is present.
      expect(await storage.package.get('pkg:meta:253286221395001345')).toBeTruthy();
    });

    it('preserves the pkg:schema-version key across imports', async () => {
      await storage.package.set('pkg:schema-version', PKG_SCHEMA_VERSION);
      await storage.package.set('pkg:meta:old-user', {});

      const blob = await buildFixturePackage();
      await streamPackageToStorage(blob);

      expect(await storage.package.get('pkg:schema-version')).toBe(PKG_SCHEMA_VERSION);
      expect(await storage.package.get('pkg:meta:old-user')).toBeNull();
    });

    it('does NOT touch the existing enriched: or deleted: namespaces', async () => {
      // The enrichment cache and deleted-message cache live in the same
      // Discrub-package store under different prefixes; the new pkg:* logic
      // must not collide with them.
      await storage.package.set('enriched:user-x:channel-y', { foo: 'bar' });
      await storage.package.set('deleted:user-x', { 'channel-y': ['msg-1'] });

      const blob = await buildFixturePackage();
      await streamPackageToStorage(blob);

      expect(await storage.package.get('enriched:user-x:channel-y')).toEqual({ foo: 'bar' });
      expect(await storage.package.get('deleted:user-x')).toEqual({ 'channel-y': ['msg-1'] });
    });
  });

  describe('format coverage (regression guards from the legacy parser)', () => {
    it('handles wrapper directories transparently', async () => {
      const blob = await buildFixturePackage({
        wrapperDir: 'Discord Data Package - prathercc',
      });
      const parsed = await streamPackageToStorage(blob);
      expect(parsed.user.id).toBe('253286221395001345');
      expect(parsed.totalMessages).toBe(4);
    });

    it('handles capitalized top-level directories', async () => {
      const blob = await buildFixturePackage({ capitalizeTopDirs: true });
      const parsed = await streamPackageToStorage(blob);
      expect(parsed.channels).toHaveLength(2);
    });

    it('handles non-English locale (German: konto / nachrichten / server)', async () => {
      const blob = await buildFixturePackage({
        localeOverride: { account: 'konto', messages: 'nachrichten', servers: 'server' },
      });
      const parsed = await streamPackageToStorage(blob);
      expect(parsed.user.id).toBe('253286221395001345');
      expect(parsed.totalMessages).toBe(4);
    });

    it('handles current packages with bare {snowflake}/ channel dirs', async () => {
      const blob = await buildFixturePackage({ channelDirPrefix: 'none' });
      const parsed = await streamPackageToStorage(blob);
      expect(parsed.channels).toHaveLength(2);
      expect(parsed.totalMessages).toBe(4);
    });

    it('handles current packages with messages.json (post-2024-01-03)', async () => {
      const blob = await buildFixturePackage({ messagesFormat: 'json' });
      const parsed = await streamPackageToStorage(blob);
      expect(parsed.totalMessages).toBe(4);
      const ch200 = await storage.package.get<any[]>('pkg:msgs:253286221395001345:200');
      expect(ch200).toBeTruthy();
      expect(ch200!.length).toBe(3);
    });

    it('flags isLegacyFormat=false for messages.json packages', async () => {
      // Current Discord format. Attachments here ship with the uc=dp
      // discriminator and don't need rehydration to render.
      const blob = await buildFixturePackage({ messagesFormat: 'json' });
      const parsed = await streamPackageToStorage(blob);
      expect(parsed.isLegacyFormat).toBe(false);
    });

    it('flags isLegacyFormat=true for messages.csv packages', async () => {
      // Pre-2025 Discord format. Attachment URLs may have already
      // expired; UI shows a soft warn so users can rehydrate before
      // export.
      const blob = await buildFixturePackage({ messagesFormat: 'csv' });
      const parsed = await streamPackageToStorage(blob);
      expect(parsed.isLegacyFormat).toBe(true);
    });

    it('flags orphan channels (type 0 without guild)', async () => {
      const blob = await buildFixturePackage({ includeOrphanChannel: true });
      const parsed = await streamPackageToStorage(blob);
      const orphan = parsed.channels.find((c) => c.id === '400');
      expect(orphan?.isOrphan).toBe(true);
      expect(orphan?.guildId).toBeUndefined();
    });

    it('regression: disambiguates messages/ from servers/ when both have index.json', async () => {
      // The default fixture now ships both `servers/index.json` and
      // `messages/index.json` (matches Discord's current export format).
      // The sniff must pick the dir with channel-file children, not the
      // first dir whose name happens to have an index.json. Pre-fix this
      // returned 0 channels on the user's real-world dogfood package.
      const blob = await buildFixturePackage();
      const parsed = await streamPackageToStorage(blob);
      expect(parsed.channels.length).toBe(2);
      expect(parsed.totalMessages).toBe(4);
      // pkg:msgs:{userId}:{channelId} keys must exist for every channel.
      const ch200 = await storage.package.get('pkg:msgs:253286221395001345:200');
      expect(Array.isArray(ch200)).toBe(true);
      expect((ch200 as any[]).length).toBe(3);
    });

    it('skips activity directories at decompress-time (their bytes never enter memory)', async () => {
      const blob = await buildFixturePackage({ includeActivity: true });
      const parsed = await streamPackageToStorage(blob);

      // No activity-derived channels appear.
      expect(parsed.channels.every((c) => !c.id.startsWith('activity'))).toBe(true);
      // And no pkg:msgs key references an activity path.
      const allKeys = await storage.package.keys();
      const activityKeys = allKeys.filter((k) => k.toLowerCase().includes('activity'));
      expect(activityKeys).toEqual([]);
    });
  });

  describe('error handling', () => {
    it('throws PackageParseError when account/user.json is missing', async () => {
      const blob = await buildFixturePackage({ omitUserJson: true });
      await expect(streamPackageToStorage(blob))
        .rejects.toBeInstanceOf(PackageParseError);
    });

    it('throws PackageParseError when account/user.json is malformed', async () => {
      const blob = await buildFixturePackage({ malformedUserJson: true });
      await expect(streamPackageToStorage(blob)).rejects.toThrow();
    });

    it('does not write a meta key when parse fails', async () => {
      const blob = await buildFixturePackage({ omitUserJson: true });
      try {
        await streamPackageToStorage(blob);
      } catch {
        /* expected */
      }
      const allKeys = await storage.package.keys();
      const metaKeys = allKeys.filter((k) => k.startsWith('pkg:meta:'));
      expect(metaKeys).toEqual([]);
    });

    it('rejects with PackageParseError on a non-ZIP input', async () => {
      const garbage = new Blob(['not a zip'], { type: 'application/octet-stream' });
      await expect(streamPackageToStorage(garbage))
        .rejects.toBeInstanceOf(PackageParseError);
    });
  });

  describe('snowflake precision in metadata JSON files (Backlog #174)', () => {
    // Stream-service mirror of the parse-service snowflake suite. The
    // two services share the JSON helper but parse the bytes through
    // different code paths (streaming-decompress vs. eager unzip), so
    // both need their own regression guard.
    const realUserSnowflake = '253286221395001999';

    it('preserves user.id when account/user.json ships an unquoted snowflake', async () => {
      const blob = await buildFixturePackage({
        userId: realUserSnowflake,
        unquotedSnowflakes: true,
      });
      const parsed = await streamPackageToStorage(blob);
      expect(parsed.user.id).toBe(realUserSnowflake);
    });

    it('preserves recipients in DM channel.json when shipped unquoted', async () => {
      const blob = await buildFixturePackage({
        userId: realUserSnowflake,
        includeGroupDm: true,
        unquotedSnowflakes: true,
      });
      const parsed = await streamPackageToStorage(blob);
      const dm = parsed.channels.find((c) => c.id === '300');
      expect(dm?.recipients).toContain(realUserSnowflake);
      const group = parsed.channels.find((c) => c.id === '500');
      expect(group?.recipients).toEqual([realUserSnowflake, '888', '777']);
      for (const id of group?.recipients ?? []) {
        expect(typeof id).toBe('string');
      }
    });
  });
});

describe('loadChannelMessagesFromStorage', () => {
  it('returns the messages written by streamPackageToStorage', async () => {
    const blob = await buildFixturePackage();
    await streamPackageToStorage(blob);

    const messages = await loadChannelMessagesFromStorage('253286221395001345', '200');
    expect(Array.isArray(messages)).toBe(true);
    expect(messages.length).toBe(3);
  });

  it('throws PackageParseError when channelId is unknown', async () => {
    const blob = await buildFixturePackage();
    await streamPackageToStorage(blob);

    await expect(
      loadChannelMessagesFromStorage('253286221395001345', 'does-not-exist'),
    ).rejects.toBeInstanceOf(PackageParseError);
  });

  it('throws when the userId is wrong', async () => {
    const blob = await buildFixturePackage();
    await streamPackageToStorage(blob);

    await expect(
      loadChannelMessagesFromStorage('999999999999999999', '200'),
    ).rejects.toBeInstanceOf(PackageParseError);
  });
});

describe('resumePackageFromStorage', () => {
  it('returns the persisted metadata with a fresh blob URL', async () => {
    const blob = await buildFixturePackage({ includeAvatar: true });
    await streamPackageToStorage(blob);

    const resumed = await resumePackageFromStorage('253286221395001345');
    expect(resumed).toBeTruthy();
    expect(resumed!.user.id).toBe('253286221395001345');
    expect(resumed!.channels.length).toBe(2);
    expect(resumed!.avatarBlobUrl).toMatch(/^blob:/);
  });

  it('rebuilds the avatarBlobUrl on every call (not the same URL across resumes)', async () => {
    const blob = await buildFixturePackage({ includeAvatar: true });
    await streamPackageToStorage(blob);

    const a = await resumePackageFromStorage('253286221395001345');
    const b = await resumePackageFromStorage('253286221395001345');

    expect(a!.avatarBlobUrl).toMatch(/^blob:/);
    expect(b!.avatarBlobUrl).toMatch(/^blob:/);
    // jsdom + fake-indexeddb mints a distinct blob URL per createObjectURL
    // call, so the values are different even though the underlying bytes
    // are the same. This is the contract callers depend on.
    expect(a!.avatarBlobUrl).not.toBe(b!.avatarBlobUrl);
  });

  it('returns null when no package is stored for that user', async () => {
    const resumed = await resumePackageFromStorage('999999999999999999');
    expect(resumed).toBeNull();
  });

  it('survives reading after only meta + avatar exist (channel msgs lazy-loaded later)', async () => {
    const blob = await buildFixturePackage();
    await streamPackageToStorage(blob);

    const resumed = await resumePackageFromStorage('253286221395001345');
    expect(resumed!.channels.length).toBe(2);
    // Per-channel reads still work after resume, because pkg:msgs:* keys
    // are also persisted.
    const messages = await loadChannelMessagesFromStorage('253286221395001345', '200');
    expect(messages.length).toBe(3);
  });
});

describe('hasStoredPackage', () => {
  it('returns true after a successful stream', async () => {
    const blob = await buildFixturePackage();
    await streamPackageToStorage(blob);
    expect(await hasStoredPackage('253286221395001345')).toBe(true);
  });

  it('returns false for an unknown user', async () => {
    expect(await hasStoredPackage('999999999999999999')).toBe(false);
  });

  it('returns false after clearPackageContents wipes the user', async () => {
    const blob = await buildFixturePackage();
    await streamPackageToStorage(blob);
    await clearPackageContents('253286221395001345');
    expect(await hasStoredPackage('253286221395001345')).toBe(false);
  });
});

describe('clearPackageContents', () => {
  it('with userId: removes only that user\'s pkg:* keys', async () => {
    const blob = await buildFixturePackage({ includeAvatar: true });
    await streamPackageToStorage(blob);
    // Pre-seed a second user so we can assert isolation.
    await storage.package.set('pkg:meta:second-user', { user: { id: 'second-user' } });
    await storage.package.set('pkg:msgs:second-user:abc', [{ id: 'a' }]);
    await storage.package.set('pkg:avatar:second-user', new Uint8Array([1, 2, 3]));

    await clearPackageContents('253286221395001345');

    expect(await storage.package.get('pkg:meta:253286221395001345')).toBeNull();
    expect(await storage.package.get('pkg:msgs:253286221395001345:200')).toBeNull();
    expect(await storage.package.get('pkg:avatar:253286221395001345')).toBeNull();

    // The second user's data is intact.
    expect(await storage.package.get('pkg:meta:second-user')).toBeTruthy();
    expect(await storage.package.get('pkg:msgs:second-user:abc')).toBeTruthy();
    // Cross-realm Uint8Array — duck-type the byte count instead of instanceof.
    const secondAvatar = await storage.package.get<Uint8Array>('pkg:avatar:second-user');
    expect(secondAvatar).toBeTruthy();
    expect(secondAvatar!.length).toBe(3);
  });

  it('without userId: removes every pkg:* key except schema-version', async () => {
    const blob = await buildFixturePackage();
    await streamPackageToStorage(blob);
    await storage.package.set('pkg:meta:second-user', { user: { id: 'second-user' } });

    await clearPackageContents();

    const remaining = await storage.package.keys();
    expect(remaining.filter((k) => k.startsWith('pkg:') && k !== 'pkg:schema-version'))
      .toEqual([]);
    expect(remaining).toContain('pkg:schema-version');
  });

  it('does NOT touch the enriched: or deleted: namespaces', async () => {
    await storage.package.set('enriched:u:c', { foo: 1 });
    await storage.package.set('deleted:u', {});
    const blob = await buildFixturePackage();
    await streamPackageToStorage(blob);

    await clearPackageContents();

    expect(await storage.package.get('enriched:u:c')).toEqual({ foo: 1 });
    expect(await storage.package.get('deleted:u')).toEqual({});
  });
});


describe('importPackageToStorage — streaming reader (#269)', () => {
  beforeEach(async () => {
    await storage.package.clear();
  });

  const readBlobBytes = (b: Blob): Promise<ArrayBuffer> =>
    new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(r.result as ArrayBuffer);
      r.onerror = () => reject(r.error ?? new Error('read failed'));
      r.readAsArrayBuffer(b);
    });

  describe('entry order does not matter', () => {
    it('finds user.json when it is the last entry', async () => {
      const parsed = await streamPackageToStorage(await buildFixturePackage({ entryOrder: 'userLast' }));
      expect(parsed.user.id).toBe('253286221395001345');
      expect(parsed.channels).toHaveLength(2);
    });

    it('resolves names from an index.json that arrives after the channels', async () => {
      const parsed = await streamPackageToStorage(await buildFixturePackage({ entryOrder: 'indexAfterChannels' }));
      const dm = parsed.channels.find((c) => c.id === '300');
      expect(dm?.name).toBe('Direct Message with friend#0');
    });

    it('accepts messages.json before channel.json inside one folder', async () => {
      const parsed = await streamPackageToStorage(await buildFixturePackage({ entryOrder: 'messagesFirst' }));
      expect(parsed.channels.find((c) => c.id === '200')?.messageCount).toBe(3);
      const rows = await storage.package.get<unknown[]>('pkg:msgs:253286221395001345:200');
      expect(rows).toHaveLength(3);
    });

    it('reads the same package through tiny pushes', async () => {
      const parsed = await streamPackageToStorage(await buildFixturePackage(), { chunkSize: 7 });
      expect(parsed.totalMessages).toBe(4);
    });
  });

  describe('dropped folders and diagnostics', () => {
    it('counts folders missing one file or with an unreadable channel.json, by reason', async () => {
      const blob = await buildFixturePackage({
        includeOrphanChannel: true,
        includeGroupDm: true,
        brokenFolders: [
          { id: '200', drop: 'messages' },
          { id: '300', drop: 'channelJson' },
          { id: '400', drop: 'unparsable' },
        ],
      });
      const { parsed, diagnostics } = await importPackageToStorage(blob);
      expect(parsed.channels.map((c) => c.id)).toEqual(['500']);
      expect(diagnostics.droppedMissingMessages).toBe(1);
      expect(diagnostics.droppedMissingChannelJson).toBe(1);
      expect(diagnostics.droppedUnparsableChannelJson).toBe(1);
      expect(diagnostics.channelFoldersSeen).toBe(4);
      expect(diagnostics.channelsBuilt).toBe(1);
    });

    it('reports renamed message keys as counted but not stored, with a key sample', async () => {
      const { parsed, diagnostics } = await importPackageToStorage(await buildFixturePackage({ renamedMessageKeys: true }));
      const general = parsed.channels.find((c) => c.id === '200');
      expect(general?.messageCount).toBe(3);
      const rows = await storage.package.get<unknown[]>('pkg:msgs:253286221395001345:200');
      expect(rows).toEqual([]);
      expect(diagnostics.channelsWithNoStoredRows).toBe(1);
      expect(diagnostics.sampleRowKeys).toEqual(['id', 'timestamp', 'contents', 'attachments']);
    });

    it('reports a clean package with zero drops and the bytes it read', async () => {
      const blob = await buildFixturePackage();
      const { diagnostics } = await importPackageToStorage(blob);
      expect(diagnostics.droppedMissingChannelJson + diagnostics.droppedMissingMessages + diagnostics.droppedUnparsableChannelJson).toBe(0);
      expect(diagnostics.channelsWithNoStoredRows).toBe(0);
      expect(diagnostics.channelsBuilt).toBe(2);
      expect(diagnostics.bytesRead).toBe(blob.size);
      expect(diagnostics.entriesSeen).toBeGreaterThan(5);
    });
  });

  describe('never inflates what it does not need', () => {
    it('imports cleanly when the deflated Activity entry is corrupt', async () => {
      const parsed = await streamPackageToStorage(await buildFixturePackage({ corruptActivityPayload: true }));
      expect(parsed.totalMessages).toBe(4);
    });

    it('imports cleanly past stored Activity entries and thousands of tiny entries', async () => {
      const parsed = await streamPackageToStorage(
        await buildFixturePackage({ includeStoredActivity: true, manyTinyEntries: 2500 }),
      );
      expect(parsed.totalMessages).toBe(4);
    });
  });

  describe('flaky sources', () => {
    const notReadable = () => {
      const err = new Error('The requested file could not be read');
      err.name = 'NotReadableError';
      return err;
    };

    it('retries once when the stream fails with NotReadableError mid-read', async () => {
      const bytes = new Uint8Array(await readBlobBytes(await buildFixturePackage()));
      let opens = 0;
      const flaky = {
        size: bytes.length,
        stream: () => {
          opens++;
          const failThisOpen = opens === 1;
          let sent = false;
          return new ReadableStream<Uint8Array>({
            pull(controller) {
              if (failThisOpen) throw notReadable();
              if (sent) {
                controller.close();
                return;
              }
              sent = true;
              controller.enqueue(bytes);
            },
          });
        },
      } as unknown as File;

      const parsed = await streamPackageToStorage(flaky);
      expect(parsed.user.id).toBe('253286221395001345');
      // Failed open, then pass 1 and pass 2 on fresh streams.
      expect(opens).toBe(3);
    });

    it('gives up after the second NotReadableError and leaves no pkg:* keys', async () => {
      const bytes = new Uint8Array(await readBlobBytes(await buildFixturePackage()));
      let opens = 0;
      const flaky = {
        size: bytes.length,
        stream: () => {
          opens++;
          // Pass 1 succeeds (user.json is early); pass 2 fails every time.
          const fail = opens % 2 === 0;
          let sent = false;
          return new ReadableStream<Uint8Array>({
            pull(controller) {
              if (fail && sent) throw notReadable();
              if (sent) {
                controller.close();
                return;
              }
              sent = true;
              controller.enqueue(bytes.subarray(0, 400));
              if (!fail) controller.enqueue(bytes.subarray(400));
            },
          });
        },
      } as unknown as File;

      await expect(streamPackageToStorage(flaky)).rejects.toMatchObject({ name: 'NotReadableError' });
      const keys = (await storage.package.keys()).filter((k) => k.startsWith('pkg:') && k !== 'pkg:schema-version');
      expect(keys).toEqual([]);
    });

    it('onBytes climbs to the total', async () => {
      const blob = await buildFixturePackage();
      const ticks: Array<[number, number]> = [];
      await streamPackageToStorage(blob, { onBytes: (read, total) => ticks.push([read, total]) });
      expect(ticks[ticks.length - 1]).toEqual([blob.size, blob.size]);
    });
  });

  describe('channel type resolution (#270)', () => {
    it('accepts a named type string from a newer export', async () => {
      const parsed = await streamPackageToStorage(await buildFixturePackage({ dmTypeOverride: 'DM' }));
      const dm = parsed.channels.find((c) => c.id === '300');
      expect(dm?.type).toBe(1);
      expect(dm?.isOrphan).toBe(false);
    });

    it('accepts a numeric string type', async () => {
      const parsed = await streamPackageToStorage(await buildFixturePackage({ dmTypeOverride: '1' }));
      expect(parsed.channels.find((c) => c.id === '300')?.type).toBe(1);
    });

    it('infers a DM from two recipients and no guild when type is missing', async () => {
      const parsed = await streamPackageToStorage(await buildFixturePackage({ dmTypeOverride: null }));
      const dm = parsed.channels.find((c) => c.id === '300');
      expect(dm?.type).toBe(1);
      expect(dm?.isOrphan).toBe(false);
    });

    it('infers a group DM from three recipients when the type is unrecognised', async () => {
      const parsed = await streamPackageToStorage(
        await buildFixturePackage({ includeGroupDm: true, dmTypeOverride: 'nonsense' }),
      );
      // Channel 500 keeps type 3 from its own json; channel 300 gets inferred from two recipients.
      expect(parsed.channels.find((c) => c.id === '300')?.type).toBe(1);
      expect(parsed.channels.find((c) => c.id === '500')?.type).toBe(3);
    });

    it('infers a DM from the index label when there is nothing else to go on', async () => {
      // The fixture's index.json labels 300 "Direct Message with friend#0".
      const parsed = await streamPackageToStorage(await buildFixturePackage({ dmTypeOverride: null }));
      expect(parsed.channels.find((c) => c.id === '300')?.type).toBe(1);
    });

    it('marks a channel with no type, guild, recipients, or label as UNKNOWN and counts it', async () => {
      const { parsed, diagnostics } = await importPackageToStorage(await buildFixturePackage({ extraChannelType: null }));
      const mystery = parsed.channels.find((c) => c.id === '700');
      expect(mystery?.type).toBe(-1);
      expect(mystery?.isOrphan).toBe(false);
      expect(diagnostics.unrecognizedTypes).toBe(1);
    });

    it('keeps an orphan only for guild-type channels without a guild', async () => {
      const parsed = await streamPackageToStorage(
        await buildFixturePackage({ includeOrphanChannel: true, extraChannelType: 'GUILD_TEXT' }),
      );
      expect(parsed.channels.find((c) => c.id === '400')?.isOrphan).toBe(true);
      expect(parsed.channels.find((c) => c.id === '700')?.isOrphan).toBe(true);
      expect(parsed.channels.find((c) => c.id === '300')?.isOrphan).toBe(false);
    });
  });
});
