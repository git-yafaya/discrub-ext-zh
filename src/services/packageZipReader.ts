/**
 * Streaming ZIP reader for Discord data packages (#269).
 *
 * The old path read the whole File into one ArrayBuffer and inflated
 * every kept entry at once. Chrome refuses `blob.arrayBuffer()` past
 * about 2 GiB, so a full package (Activity alone is most of it) could
 * not be opened at all. This reader pushes the archive through fflate's
 * streaming `Unzip` in small chunks, decides per entry whether it is
 * wanted before anything is inflated, and hands each wanted entry's
 * bytes to the caller as soon as it is complete. Unwanted entries never
 * inflate: their compressed bytes go to a discard decoder.
 *
 * Facts about fflate 0.8.2 `Unzip` this leans on (esm/index.mjs):
 *   - Bytes of an entry whose `start()` was never called are buffered
 *     forever, so every entry, wanted or not, is started.
 *   - `start()` looks the decoder up by compression method at call
 *     time, so registering a discard decoder right before `start()` and
 *     restoring the real ones right after skips the inflate. This only
 *     works when `start()` runs synchronously inside `onfile`.
 *   - `push` recurses once per entry found in a chunk, so the platform
 *     chunk is re-sliced into small pushes before it goes in.
 *   - A final push with an entry still open throws "invalid zip data".
 *     Every push is wrapped so that surfaces as a PackageParseError.
 *   - `file.size` is undefined for data-descriptor entries, so nothing
 *     here relies on it.
 */

import {
  Unzip,
  UnzipInflate,
  UnzipPassThrough,
  type UnzipDecoder,
  type AsyncFlateStreamHandler,
} from 'fflate';
import { PackageParseError } from './packageValidation';

export interface ReadPackageEntriesHandlers {
  /** Decided synchronously from the path, before any inflate. */
  want: (path: string) => boolean;
  /** Called with the full bytes of every wanted entry, in archive order. */
  onEntry: (path: string, bytes: Uint8Array) => Promise<void> | void;
  /** Progress in compressed bytes read from the source. */
  onBytes?: (readBytes: number, totalBytes: number) => void;
  /** Checked between pushes; true stops reading and resolves normally. */
  shouldStop?: () => boolean;
  /** Bytes per push into fflate. Default 64 KiB; tests use tiny values. */
  chunkSize?: number;
}

export type PackageZipSource = Blob | ArrayBuffer | Uint8Array;

export const DEFAULT_CHUNK_SIZE = 64 * 1024;

/** Paths that are never part of a package: macOS resource forks and junk. */
export function isJunkPath(path: string): boolean {
  if (path.startsWith('__MACOSX/') || path.includes('/__MACOSX/')) return true;
  const name = path.split('/').pop() ?? '';
  if (name.startsWith('._')) return true;
  if (name === '.DS_Store') return true;
  return false;
}

/** A decoder that swallows a stored entry's bytes without keeping them. */
class DiscardStored implements UnzipDecoder {
  static compression = 0;
  ondata: AsyncFlateStreamHandler = () => {};
  push(): void {}
}

/** A decoder that swallows a deflated entry's bytes without inflating. */
class DiscardDeflate implements UnzipDecoder {
  static compression = 8;
  ondata: AsyncFlateStreamHandler = () => {};
  push(): void {}
}

function concat(chunks: Uint8Array[]): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  let total = 0;
  for (const c of chunks) total += c.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

function archiveError(err: unknown): PackageParseError {
  const message = err instanceof Error ? err.message : String(err);
  return new PackageParseError(`Failed to read package archive: ${message}`);
}

/**
 * Reads every entry of a ZIP, inflating only those `want()` accepts.
 * Resolves when the archive ends or `shouldStop` returns true. Rejects
 * with a PackageParseError for a broken archive, with whatever
 * `onEntry` threw, or with the source's own read error unchanged (a
 * NotReadableError from a File stream, for instance, so the caller can
 * retry).
 */
export async function readPackageEntries(
  input: PackageZipSource,
  handlers: ReadPackageEntriesHandlers,
): Promise<void> {
  const chunkSize = Math.max(1, handlers.chunkSize ?? DEFAULT_CHUNK_SIZE);
  const pending: Promise<void>[] = [];
  let failure: unknown = null;

  const unzip = new Unzip((file) => {
    const path = file.name;
    const wanted = !path.endsWith('/') && !isJunkPath(path) && handlers.want(path);
    if (!wanted) {
      unzip.register(DiscardStored);
      unzip.register(DiscardDeflate);
      file.ondata = () => {};
      try {
        file.start();
      } catch (err) {
        failure ??= err;
      } finally {
        unzip.register(UnzipPassThrough);
        unzip.register(UnzipInflate);
      }
      return;
    }
    const chunks: Uint8Array[] = [];
    file.ondata = (err, data, final) => {
      if (err) {
        failure ??= err;
        return;
      }
      if (data && data.length > 0) chunks.push(data);
      if (final) {
        const bytes = concat(chunks);
        chunks.length = 0;
        pending.push(Promise.resolve().then(() => handlers.onEntry(path, bytes)));
      }
    };
    try {
      file.start();
    } catch (err) {
      failure ??= err;
    }
  });
  unzip.register(UnzipInflate);

  const push = (chunk: Uint8Array, final: boolean) => {
    try {
      unzip.push(chunk, final);
    } catch (err) {
      throw archiveError(err);
    }
    if (failure) {
      const err = failure;
      failure = null;
      throw archiveError(err);
    }
  };

  const drain = async () => {
    if (pending.length === 0) return;
    const batch = pending.splice(0);
    await Promise.all(batch);
  };

  const stopped = () => handlers.shouldStop?.() === true;

  // Re-slice whatever the platform hands us so no single push carries
  // more than chunkSize bytes (bounds fflate's per-entry recursion).
  const feed = async (data: Uint8Array): Promise<boolean> => {
    for (let offset = 0; offset < data.length; offset += chunkSize) {
      push(data.subarray(offset, Math.min(offset + chunkSize, data.length)), false);
      await drain();
      if (stopped()) return false;
    }
    return true;
  };

  const totalBytes = sizeOf(input);
  let readBytes = 0;
  const report = () => handlers.onBytes?.(readBytes, totalBytes);

  // fflate's streaming reader never looks at the central directory, so
  // an archive cut off between entries would read "clean". Keep the
  // last bytes seen and require the end-of-central-directory record
  // (which every complete ZIP ends with, at most 65 KiB plus its
  // comment from the end) before calling the read whole.
  let tail = new Uint8Array(0);
  const remember = (chunk: Uint8Array) => {
    const keep = 66 * 1024;
    if (chunk.length >= keep) {
      tail = chunk.slice(chunk.length - keep);
      return;
    }
    const joined = new Uint8Array(Math.min(keep, tail.length + chunk.length));
    const fromTail = joined.length - chunk.length;
    joined.set(tail.subarray(tail.length - fromTail), 0);
    joined.set(chunk, fromTail);
    tail = joined;
  };
  const assertEndRecord = () => {
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail[i] === 0x50 && tail[i + 1] === 0x4b && tail[i + 2] === 0x05 && tail[i + 3] === 0x06) return;
    }
    throw new PackageParseError('Failed to read package archive: the end of the archive is missing, the file may be cut short');
  };

  if (input instanceof ArrayBuffer || input instanceof Uint8Array) {
    const bytes = input instanceof ArrayBuffer ? new Uint8Array(input) : input;
    if (stopped()) return;
    for (let offset = 0; offset < bytes.length; offset += chunkSize) {
      const slice = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.length));
      push(slice, false);
      remember(slice);
      readBytes += slice.length;
      await drain();
      if (stopped()) {
        report();
        return;
      }
    }
    push(new Uint8Array(0), true);
    await drain();
    assertEndRecord();
    report();
    return;
  }

  if (typeof input.stream === 'function') {
    const reader = input.stream().getReader();
    try {
      for (;;) {
        if (stopped()) return;
        const { done, value } = await reader.read();
        if (done) break;
        if (value && value.length > 0) {
          readBytes += value.length;
          const keepGoing = await feed(value);
          remember(value);
          report();
          if (!keepGoing) return;
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* the stream may already be closed */
      }
    }
    push(new Uint8Array(0), true);
    await drain();
    assertEndRecord();
    report();
    return;
  }

  // No streaming API (very old browsers, some test doubles): one read.
  const buffer = await readBlobAsArrayBuffer(input);
  await readPackageEntries(buffer, handlers);
}

function sizeOf(input: PackageZipSource): number {
  if (input instanceof ArrayBuffer) return input.byteLength;
  if (input instanceof Uint8Array) return input.length;
  return typeof input.size === 'number' ? input.size : 0;
}

/** Reads a Blob-like into an ArrayBuffer, preferring the native method. */
export function readBlobAsArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') {
    return blob.arrayBuffer();
  }
  return new Promise<ArrayBuffer>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as ArrayBuffer);
    reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
    reader.readAsArrayBuffer(blob);
  });
}
