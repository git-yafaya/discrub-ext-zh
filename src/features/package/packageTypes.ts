/**
 * Types for the Discord data package import feature.
 *
 * Source: user's exported data package from Discord
 * (Settings → Privacy & Safety → Request All of My Data).
 */

/**
 * Channel types present in data packages (Discord API channel types),
 * plus UNKNOWN for a channel.json whose type Discrub could not resolve
 * or infer (#270).
 */
export const PACKAGE_CHANNEL_TYPE = {
  GUILD_TEXT: 0,
  DM: 1,
  GROUP_DM: 3,
  GUILD_ANNOUNCEMENT_THREAD: 10,
  GUILD_PUBLIC_THREAD: 11,
  GUILD_PRIVATE_THREAD: 12,
  GUILD_FORUM: 15,
  UNKNOWN: -1,
} as const;

export type PackageChannelType =
  (typeof PACKAGE_CHANNEL_TYPE)[keyof typeof PACKAGE_CHANNEL_TYPE];

const CHANNEL_TYPE_NAMES: Record<string, PackageChannelType> = {
  GUILD_TEXT: PACKAGE_CHANNEL_TYPE.GUILD_TEXT,
  DM: PACKAGE_CHANNEL_TYPE.DM,
  GROUP_DM: PACKAGE_CHANNEL_TYPE.GROUP_DM,
  ANNOUNCEMENT_THREAD: PACKAGE_CHANNEL_TYPE.GUILD_ANNOUNCEMENT_THREAD,
  GUILD_ANNOUNCEMENT_THREAD: PACKAGE_CHANNEL_TYPE.GUILD_ANNOUNCEMENT_THREAD,
  PUBLIC_THREAD: PACKAGE_CHANNEL_TYPE.GUILD_PUBLIC_THREAD,
  GUILD_PUBLIC_THREAD: PACKAGE_CHANNEL_TYPE.GUILD_PUBLIC_THREAD,
  PRIVATE_THREAD: PACKAGE_CHANNEL_TYPE.GUILD_PRIVATE_THREAD,
  GUILD_PRIVATE_THREAD: PACKAGE_CHANNEL_TYPE.GUILD_PRIVATE_THREAD,
  GUILD_FORUM: PACKAGE_CHANNEL_TYPE.GUILD_FORUM,
  FORUM: PACKAGE_CHANNEL_TYPE.GUILD_FORUM,
};

const KNOWN_NUMERIC_TYPES = new Set<number>(
  Object.values(PACKAGE_CHANNEL_TYPE).filter((v) => v !== PACKAGE_CHANNEL_TYPE.UNKNOWN),
);

/**
 * #270: resolves whatever `channel.json` carries as `type` to a known
 * package channel type. Accepts the API numbers, numeric strings, and
 * the enum names some exports ship ("DM", "GROUP_DM", "GUILD_TEXT",
 * ...), case-insensitively. Returns null when nothing matches so the
 * import can infer from the rest of the record.
 */
export function normalizePackageChannelType(raw: unknown): PackageChannelType | null {
  if (typeof raw === 'number') {
    return KNOWN_NUMERIC_TYPES.has(raw) ? (raw as PackageChannelType) : null;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (/^\d+$/.test(trimmed)) {
      const n = Number(trimmed);
      return KNOWN_NUMERIC_TYPES.has(n) ? (n as PackageChannelType) : null;
    }
    const named = CHANNEL_TYPE_NAMES[trimmed.toUpperCase()];
    return named ?? null;
  }
  return null;
}

/** Types that live inside a server. A guild-less one of these is an orphan. */
export const GUILD_CHANNEL_TYPES: ReadonlySet<PackageChannelType> = new Set<PackageChannelType>([
  PACKAGE_CHANNEL_TYPE.GUILD_TEXT,
  PACKAGE_CHANNEL_TYPE.GUILD_ANNOUNCEMENT_THREAD,
  PACKAGE_CHANNEL_TYPE.GUILD_PUBLIC_THREAD,
  PACKAGE_CHANNEL_TYPE.GUILD_PRIVATE_THREAD,
  PACKAGE_CHANNEL_TYPE.GUILD_FORUM,
]);

/** Thread types, grouped together in the sidebar. */
export const THREAD_CHANNEL_TYPES: ReadonlySet<PackageChannelType> = new Set<PackageChannelType>([
  PACKAGE_CHANNEL_TYPE.GUILD_ANNOUNCEMENT_THREAD,
  PACKAGE_CHANNEL_TYPE.GUILD_PUBLIC_THREAD,
  PACKAGE_CHANNEL_TYPE.GUILD_PRIVATE_THREAD,
]);

/** Identity of the user who requested the package (from account/user.json). */
export interface PackageUser {
  id: string;
  username: string;
  globalName: string | null;
  avatarHash: string | null;
  email?: string;
}

/** Guild metadata (from servers/{id}/guild.json). */
export interface PackageGuild {
  id: string;
  name: string;
}

/**
 * Channel metadata (from messages/c{id}/channel.json) plus derived fields.
 *
 * `isOrphan` flags channels where the user's server context is gone —
 * typically a type-0 text channel with no guild field, meaning the user
 * has left the server. Messages still exist in the package, but API
 * delete/edit calls will 403.
 */
export interface PackageChannel {
  id: string;
  type: PackageChannelType;
  name: string | null;
  guildId?: string;
  guildName?: string;
  recipients?: string[];
  messageCount: number;
  isOrphan: boolean;
}

/** A single parsed message row from messages/c{id}/messages.csv. */
export interface PackageMessage {
  id: string;
  timestamp: string;
  content: string;
  /**
   * Discord serializes multi-attachment messages as a single CSV cell
   * containing the URLs separated by whitespace. We split into a list
   * up front (Backlog #159) so downstream consumers don't have to know
   * about the encoding. Empty / no attachments → `[]`.
   */
  attachments: string[];
}

/** Root parsed-package shape returned by parsePackageZip. */
export interface ParsedPackage {
  user: PackageUser;
  guilds: PackageGuild[];
  channels: PackageChannel[];
  totalMessages: number;
  packageSizeBytes: number;
  avatarBlobUrl?: string;
  /**
   * True when the package predates Discord's 2025-06-14 export format
   * change. Detected by the presence of any `messages.csv` channel file
   * (current packages ship `messages.json`). Pre-2025 packages have
   * ephemeral attachment URLs that may have already expired; the UI
   * surfaces a soft warn so users can rehydrate before export to
   * refresh URLs and bundle media locally. Doesn't block any feature.
   */
  isLegacyFormat?: boolean;
}

/**
 * What the import saw while reading the archive (#269). Returned beside
 * the parsed package, never stored in pkg:meta, so a resume does not
 * re-log it.
 */
export interface ImportDiagnostics {
  /** Every entry the archive listed, wanted or not. */
  entriesSeen: number;
  /** Channel folders that had at least one channel file. */
  channelFoldersSeen: number;
  /** Channels that made it into the package. */
  channelsBuilt: number;
  /** Folders with a messages file but no channel.json. */
  droppedMissingChannelJson: number;
  /** Folders with a channel.json but no messages file. */
  droppedMissingMessages: number;
  /** Folders whose channel.json did not parse. */
  droppedUnparsableChannelJson: number;
  /** Channels whose messages file had rows but none Discrub could store. */
  channelsWithNoStoredRows: number;
  /** Key names from the first row that could not be stored, if any. */
  sampleRowKeys: string[] | null;
  /** Channels whose type could neither be read nor inferred (#270). */
  unrecognizedTypes: number;
  /** Compressed bytes read from the source. */
  bytesRead: number;
}

/** Result of validating a parsed package against the current auth context. */
export interface PackageValidationResult {
  ok: boolean;
  readOnly: boolean;
  warnings: string[];
  errors: string[];
}
