import { describe, it, expect, vi } from 'vitest';
import { zipSync, strToU8, type Zippable } from 'fflate';
import * as fflate from 'fflate';
import { readPackageEntries, isJunkPath } from './packageZipReader';
import { PackageParseError } from './packageValidation';

// See package-fixtures.ts: re-wrap through the global Uint8Array so
// fflate's realm-sensitive instanceof check sees a leaf, not a Zippable.
const u8 = (s: string): Uint8Array => new Uint8Array(strToU8(s));

let inflaterConstructions = 0;
vi.mock('fflate', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fflate')>();
  class CountingInflate extends actual.UnzipInflate {
    constructor(...args: ConstructorParameters<typeof actual.UnzipInflate>) {
      super(...args);
      inflaterConstructions++;
    }
  }
  return { ...actual, UnzipInflate: CountingInflate };
});

function buildZip(entries: Record<string, string | [string, { level: 0 }]>): Uint8Array {
  const z: Zippable = {};
  for (const [path, body] of Object.entries(entries)) {
    z[path] = Array.isArray(body) ? [u8(body[0]), body[1]] : u8(body);
  }
  return zipSync(z);
}

async function collect(
  input: Blob | ArrayBuffer | Uint8Array,
  want: (p: string) => boolean = () => true,
  chunkSize?: number,
): Promise<Record<string, string>> {
  const seen: Record<string, string> = {};
  await readPackageEntries(input, {
    want,
    onEntry: (path, bytes) => {
      seen[path] = new TextDecoder().decode(bytes);
    },
    chunkSize,
  });
  return seen;
}

const THREE = {
  'account/user.json': '{"id":"1","username":"a"}',
  'messages/c200/channel.json': '{"id":"200"}',
  'messages/c200/messages.json': '[{"ID":"1","Timestamp":"t"}]',
};

describe('readPackageEntries (#269)', () => {
  it('yields identical entries from a Blob stream and from an ArrayBuffer', async () => {
    const bytes = buildZip(THREE);
    const fromBlob = await collect(new Blob([bytes as BlobPart]));
    const fromBuffer = await collect(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    expect(fromBlob).toEqual(THREE);
    expect(fromBuffer).toEqual(THREE);
  });

  it('survives headers split across pushes with a 7 byte chunk size', async () => {
    const bytes = buildZip(THREE);
    expect(await collect(bytes, () => true, 7)).toEqual(THREE);
  });

  it('handles thousands of tiny entries in one platform chunk without overflowing', async () => {
    const entries: Record<string, string> = {};
    for (let i = 0; i < 2000; i++) entries[`programs/p${i}.json`] = '1';
    entries['account/user.json'] = '{"id":"1"}';
    const bytes = buildZip(entries);
    const seen = await collect(bytes, (p) => p === 'account/user.json');
    expect(seen).toEqual({ 'account/user.json': '{"id":"1"}' });
  });

  it('only constructs an inflater for wanted entries', async () => {
    const filler = Array.from({ length: 300 }, (_, i) => `row-${i}-${(i * 31) % 97}`).join('\n');
    const bytes = buildZip({ ...THREE, 'activity/reporting.json': filler, 'activities_e/events.json': filler });
    inflaterConstructions = 0;
    const seen = await collect(bytes, (p) => p.startsWith('messages/'));
    expect(Object.keys(seen).sort()).toEqual(['messages/c200/channel.json', 'messages/c200/messages.json']);
    expect(inflaterConstructions).toBe(2);
  });

  it('never inflates an unwanted entry: a corrupted deflate stream reads clean', async () => {
    const filler = Array.from({ length: 300 }, (_, i) => `row-${i}-${(i * 31) % 97}`).join('\n');
    const bytes = buildZip({ 'activity/reporting.json': filler, ...THREE });
    // Overwrite the activity entry's compressed payload with garbage.
    const name = u8('activity/reporting.json');
    let start = -1;
    let size = 0;
    for (let i = 0; i < bytes.length - 30; i++) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 3 && bytes[i + 3] === 4) {
        const fnl = bytes[i + 26] | (bytes[i + 27] << 8);
        if (fnl === name.length && new TextDecoder().decode(bytes.subarray(i + 30, i + 30 + fnl)) === 'activity/reporting.json') {
          const es = bytes[i + 28] | (bytes[i + 29] << 8);
          size = bytes[i + 18] | (bytes[i + 19] << 8) | (bytes[i + 20] << 16);
          start = i + 30 + fnl + es;
          break;
        }
      }
    }
    expect(start).toBeGreaterThan(0);
    expect(size).toBeGreaterThan(20);
    for (let k = 0; k < size; k++) bytes[start + k] = 0xff;

    // Wanted: inflating it throws. Unwanted: it is discarded untouched.
    await expect(collect(bytes, () => true)).rejects.toBeInstanceOf(PackageParseError);
    const seen = await collect(bytes, (p) => !p.startsWith('activity/'));
    expect(seen).toEqual(THREE);
  });

  it('discards stored (method 0) unwanted entries through the pass-through path', async () => {
    const bytes = buildZip({ 'activity/reporting.json': ['x'.repeat(200), { level: 0 }], ...THREE });
    const seen = await collect(bytes, (p) => !p.startsWith('activity/'));
    expect(seen).toEqual(THREE);
  });

  it('reads stored wanted entries too', async () => {
    const bytes = buildZip({ 'account/user.json': ['{"id":"9"}', { level: 0 }] });
    expect(await collect(bytes)).toEqual({ 'account/user.json': '{"id":"9"}' });
  });

  it('reads a data-descriptor entry (flag bit 3) without relying on file.size', async () => {
    // Hand-written: one stored entry whose sizes live in a trailing descriptor.
    const name = u8('account/user.json');
    const body = u8('{"id":"7"}');
    const header = new Uint8Array(30 + name.length);
    const dv = new DataView(header.buffer);
    dv.setUint32(0, 0x04034b50, true);
    dv.setUint16(4, 20, true); // version
    dv.setUint16(6, 8, true); // flags: bit 3 = data descriptor
    dv.setUint16(8, 0, true); // stored
    dv.setUint16(26, name.length, true);
    header.set(name, 30);
    const descriptor = new Uint8Array(16);
    const ddv = new DataView(descriptor.buffer);
    ddv.setUint32(0, 0x08074b50, true);
    ddv.setUint32(4, 0, true); // crc (fflate does not verify)
    ddv.setUint32(8, body.length, true);
    ddv.setUint32(12, body.length, true);
    // End of central directory with zero entries; fflate's streaming
    // reader ignores it, but a real archive ends this way.
    const eocd = new Uint8Array(22);
    new DataView(eocd.buffer).setUint32(0, 0x06054b50, true);
    const bytes = new Uint8Array(header.length + body.length + descriptor.length + eocd.length);
    bytes.set(header, 0);
    bytes.set(body, header.length);
    bytes.set(descriptor, header.length + body.length);
    bytes.set(eocd, header.length + body.length + descriptor.length);

    expect(await collect(bytes, () => true, 5)).toEqual({ 'account/user.json': '{"id":"7"}' });
  });

  it('rejects truncated input after handing over the entries that were complete', async () => {
    const bytes = buildZip(THREE);
    const cut = bytes.subarray(0, Math.floor(bytes.length * 0.6));
    const seen: string[] = [];
    await expect(
      readPackageEntries(cut, { want: () => true, onEntry: (p) => { seen.push(p); } }),
    ).rejects.toBeInstanceOf(PackageParseError);
    // Entries that were complete before the cut still came through.
    expect(seen.length).toBeGreaterThanOrEqual(1);
    expect(seen.length).toBeLessThanOrEqual(3);
  });

  it('ignores a wrapped end-of-central-directory entry count', async () => {
    const bytes = buildZip(THREE);
    // Find the EOCD record and claim only one entry.
    for (let i = bytes.length - 22; i >= 0; i--) {
      if (bytes[i] === 0x50 && bytes[i + 1] === 0x4b && bytes[i + 2] === 5 && bytes[i + 3] === 6) {
        bytes[i + 8] = 1;
        bytes[i + 9] = 0;
        bytes[i + 10] = 1;
        bytes[i + 11] = 0;
        break;
      }
    }
    expect(await collect(bytes)).toEqual(THREE);
  });

  it('rejects with the source read error unchanged so the caller can retry', async () => {
    const err = new Error('The requested file could not be read');
    err.name = 'NotReadableError';
    const flaky = {
      size: 100,
      stream: () => new ReadableStream<Uint8Array>({ pull() { throw err; } }),
    } as unknown as Blob;
    await expect(collect(flaky)).rejects.toBe(err);
  });

  it('holds the next read while a slow onEntry is still running (backpressure)', async () => {
    const bytes = buildZip(THREE);
    const order: string[] = [];
    let reads = 0;
    const slow = {
      size: bytes.length,
      stream: () =>
        new ReadableStream<Uint8Array>({
          pull(controller) {
            reads++;
            order.push(`read${reads}`);
            if (reads === 1) controller.enqueue(bytes.subarray(0, 60));
            else if (reads === 2) controller.enqueue(bytes.subarray(60));
            else controller.close();
          },
        }),
    } as unknown as Blob;
    await readPackageEntries(slow, {
      want: (p) => p === 'account/user.json',
      onEntry: async (p) => {
        order.push(`start ${p}`);
        await new Promise((r) => setTimeout(r, 20));
        order.push(`end ${p}`);
      },
      chunkSize: 16,
    });
    const start = order.indexOf('start account/user.json');
    const end = order.indexOf('end account/user.json');
    expect(start).toBeGreaterThan(-1);
    // No read happened between the entry starting and finishing.
    expect(order.slice(start + 1, end)).toEqual([]);
  });

  it('stops reading when shouldStop returns true and resolves normally', async () => {
    const bytes = buildZip(THREE);
    const seen: string[] = [];
    await readPackageEntries(bytes, {
      want: () => true,
      onEntry: (p) => { seen.push(p); },
      shouldStop: () => seen.length >= 1,
      chunkSize: 32,
    });
    expect(seen.length).toBeLessThan(3);
  });

  it('reports bytes read up to the total', async () => {
    const bytes = buildZip(THREE);
    const ticks: Array<[number, number]> = [];
    await readPackageEntries(new Blob([bytes as BlobPart]), {
      want: () => false,
      onEntry: () => {},
      onBytes: (read, total) => ticks.push([read, total]),
    });
    expect(ticks.length).toBeGreaterThan(0);
    expect(ticks[ticks.length - 1]).toEqual([bytes.length, bytes.length]);
  });

  it('treats file names case-insensitively for the caller and skips junk paths', async () => {
    const bytes = buildZip({
      'Messages/C200/Channel.json': '{"id":"200"}',
      '__MACOSX/._x': 'junk',
      'wrapper/.DS_Store': 'junk',
      'dir/': '',
    });
    const wanted: string[] = [];
    const seen = await collect(bytes, (p) => {
      wanted.push(p);
      return /channel\.json$/i.test(p);
    });
    expect(seen).toEqual({ 'Messages/C200/Channel.json': '{"id":"200"}' });
    expect(wanted).toEqual(['Messages/C200/Channel.json']);
    expect(isJunkPath('__MACOSX/._a')).toBe(true);
    expect(isJunkPath('a/.DS_Store')).toBe(true);
    expect(isJunkPath('a/b.json')).toBe(false);
  });

  it('exposes the real fflate module to the reader (sanity)', () => {
    expect(typeof fflate.Unzip).toBe('function');
  });
});
