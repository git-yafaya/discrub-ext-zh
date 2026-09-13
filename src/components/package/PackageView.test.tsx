import { describe, it, expect, vi } from 'vitest';
import { renderWithProviders, screen, fireEvent } from '@/test/test-utils';
import { virtualizerMock } from '@/test/virtualizer-mock';
import PackageView from './PackageView';

vi.mock('@tanstack/react-virtual', () => virtualizerMock);
import {
  PACKAGE_CHANNEL_TYPE,
  type PackageChannel,
  type ParsedPackage,
} from '@features/package/packageTypes';

const channel: PackageChannel = {
  id: '200',
  type: PACKAGE_CHANNEL_TYPE.GUILD_TEXT,
  name: 'general',
  guildId: 'g1',
  guildName: 'Guild A',
  messageCount: 5,
  isOrphan: false,
};

const parsed: ParsedPackage = {
  user: { id: 'u1', username: 'tester', globalName: 'Tester', avatarHash: null },
  guilds: [{ id: 'g1', name: 'Guild A' }],
  channels: [channel],
  totalMessages: 5,
  packageSizeBytes: 1,
};

function statePackageLoaded(
  selectedChannelId: string | null = null,
  deletedMessageIds: Record<string, string[]> = {},
) {
  return {
    package: {
      status: 'ready',
      parsed,
      validation: { ok: true, readOnly: false, warnings: [], errors: [] },
      error: null,
      selectedChannelId,
      loadedChannels: selectedChannelId
        ? {
            [selectedChannelId]: [
              {
                id: '1',
                timestamp: '2022-07-28 22:30:52.800000+00:00',
                content: 'sample message',
                attachments: [],
              },
            ],
          }
        : {},
      loadedOrder: [],
      loadingChannelId: null,
      selectedMessageIds: {},
      timelineStatus: 'idle',
      timelineTimestamps: [],
      timelineProgress: null,
      timelineError: null,
      deleteStatus: 'idle',
      deleteProgress: null,
      deleteResult: null,
      deleteError: null,
      exportStatus: 'idle',
      exportError: null,
      deletedMessageIds,
      goneMessageIds: {},
      enrichmentStatus: {},
      enrichmentProgress: {},
      enrichedMessages: {},
      enrichmentMisses: {},
      enrichmentError: {},
      enrichmentLastFetched: {},
      activeEnrichmentChannelId: null,
    },
  } as never;
}

describe('<PackageView /> routing', () => {
  it('shows upload prompt when no package is loaded', () => {
    renderWithProviders(<PackageView />);
    expect(screen.getByText(/Import a Discord Data Package/i)).toBeInTheDocument();
  });

  it('shows summary + analytics when package loaded but no channel selected', () => {
    renderWithProviders(<PackageView />, { preloadedState: statePackageLoaded(null) });
    expect(screen.getByText(/Top channels by message count/i)).toBeInTheDocument();
    expect(screen.getByText(/Select a channel/i)).toBeInTheDocument();
  });

  it('shows message table when a channel is selected', () => {
    renderWithProviders(<PackageView />, { preloadedState: statePackageLoaded('200') });
    expect(screen.getByText('sample message')).toBeInTheDocument();
    expect(screen.queryByText(/Top channels by message count/i)).not.toBeInTheDocument();
  });

  it('back button clears channel selection', () => {
    const { store } = renderWithProviders(<PackageView />, {
      preloadedState: statePackageLoaded('200'),
    });
    fireEvent.click(screen.getByLabelText(/Back to analytics/i));
    expect(store.getState().package.selectedChannelId).toBeNull();
  });
});

describe('<PackageView /> — #236 live remaining counts', () => {
  it('summary chip shows the live remaining total with an explanatory tooltip', async () => {
    renderWithProviders(<PackageView />, {
      preloadedState: statePackageLoaded(null, { '200': ['1', '2'] }),
    });
    // 5 in the archive minus 2 deleted via Discrub.
    const chipLabel = screen.getByText('3 messages');
    fireEvent.mouseOver(chipLabel);
    expect(
      await screen.findByText('5 in package, 2 deleted via Discrub'),
    ).toBeInTheDocument();
  });

  it('summary chip shows the raw archive total when nothing was deleted', () => {
    renderWithProviders(<PackageView />, {
      preloadedState: statePackageLoaded(null),
    });
    expect(screen.getByText('5 messages')).toBeInTheDocument();
  });

  it('channel header caption subtracts deleted ids', () => {
    renderWithProviders(<PackageView />, {
      preloadedState: statePackageLoaded('200', { '200': ['1', '2'] }),
    });
    expect(screen.getByText('Guild A · 3 messages')).toBeInTheDocument();
  });

  it('deleted ids from channels outside the package do not skew the total', () => {
    renderWithProviders(<PackageView />, {
      preloadedState: statePackageLoaded(null, { 'stale-channel': ['9'] }),
    });
    // The scoped remaining total ignores the stale entry entirely.
    expect(screen.getByText('5 messages')).toBeInTheDocument();
  });

  it('counts DMs the way the sidebar does: inferred DMs in, orphans out (#270)', () => {
    const state = statePackageLoaded(null) as any;
    state.package.parsed = {
      ...parsed,
      channels: [
        channel,
        { id: '300', type: 1, name: null, messageCount: 1, isOrphan: false, recipients: ['u1', 'x'] },
        { id: '301', type: 3, name: null, messageCount: 1, isOrphan: false },
        { id: '302', type: 1, name: null, messageCount: 1, isOrphan: true },
        { id: '303', type: -1, name: 'mystery', messageCount: 1, isOrphan: false },
      ],
    };
    renderWithProviders(<PackageView />, { preloadedState: state });
    expect(screen.getByText('2 DMs')).toBeInTheDocument();
  });
});
