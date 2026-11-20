import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockFetchJson, mockSseManager, mockGetSettings, mockDbServers } = vi.hoisted(() => ({
  mockFetchJson: vi.fn(),
  mockSseManager: {
    setLatestPluginVersion: vi.fn(),
    getPluginVersion: vi.fn().mockReturnValue(null),
    isInFallback: vi.fn().mockReturnValue(false),
  },
  mockGetSettings: vi.fn().mockResolvedValue({
    pluginUpdateCheckEnabled: true,
    pluginManifestUrl: null,
  }),
  mockDbServers: vi.fn().mockResolvedValue([]),
}));

vi.mock('../../utils/http.js', () => ({ fetchJson: mockFetchJson }));
vi.mock('../../services/sseManager.js', () => ({ sseManager: mockSseManager }));
vi.mock('../../services/settings.js', () => ({ getSettings: mockGetSettings }));
vi.mock('../../services/liveServers.js', () => ({ liveServers: mockDbServers }));

const mockDispatchPluginUpdate = vi.fn().mockResolvedValue(undefined);
vi.mock('../../services/automations/events/producers.js', () => ({
  dispatchPluginUpdate: (...args: unknown[]) => mockDispatchPluginUpdate(...args),
}));

import { runPluginUpdateCheck, _resetNudgeStateForTests } from '../pluginUpdateChecker.js';

const MANIFEST = [
  {
    versions: [{ version: '0.1.0.0' }, { version: '0.2.0.0' }],
  },
];

describe('runPluginUpdateCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetNudgeStateForTests();
    mockGetSettings.mockResolvedValue({ pluginUpdateCheckEnabled: true, pluginManifestUrl: null });
    mockFetchJson.mockResolvedValue(MANIFEST);
    mockDbServers.mockResolvedValue([
      { id: 's1', name: 'JF', type: 'jellyfin' },
      { id: 's2', name: 'Plex', type: 'plex' },
    ]);
  });

  it('reads the server list through the live filter', async () => {
    await runPluginUpdateCheck();
    expect(mockDbServers).toHaveBeenCalledWith();
  });

  it('publishes the max manifest version to sseManager', async () => {
    await runPluginUpdateCheck();
    expect(mockSseManager.setLatestPluginVersion).toHaveBeenCalledWith('0.2.0.0');
  });

  it('nudges once for an outdated jellyfin plugin and dedups repeats', async () => {
    mockSseManager.getPluginVersion.mockReturnValue('0.1.0.0');
    await runPluginUpdateCheck();
    await runPluginUpdateCheck();

    expect(mockDispatchPluginUpdate).toHaveBeenCalledTimes(1);
    expect(mockDispatchPluginUpdate).toHaveBeenCalledWith({
      server: { id: 's1', name: 'JF', type: 'jellyfin' },
      installedVersion: '0.1.0.0',
      latestVersion: '0.2.0.0',
      downloadUrl: 'https://github.com/Tracearr/Media-Server-SSE/releases/latest',
    });
  });

  it('re-arms when a newer version appears', async () => {
    mockSseManager.getPluginVersion.mockReturnValue('0.1.0.0');
    await runPluginUpdateCheck();
    mockFetchJson.mockResolvedValue([{ versions: [{ version: '0.3.0.0' }] }]);
    await runPluginUpdateCheck();

    expect(mockDispatchPluginUpdate).toHaveBeenCalledTimes(2);
  });

  it('does not nudge an up to date plugin', async () => {
    mockSseManager.getPluginVersion.mockReturnValue('0.2.0.0');
    await runPluginUpdateCheck();
    expect(mockDispatchPluginUpdate).not.toHaveBeenCalled();
  });

  it('never nudges plex or silo servers', async () => {
    mockDbServers.mockResolvedValue([
      { id: 's2', name: 'Plex', type: 'plex' },
      { id: 's3', name: 'Silo', type: 'silo' },
    ]);
    await runPluginUpdateCheck();
    expect(mockDispatchPluginUpdate).not.toHaveBeenCalled();
  });

  it('skips servers in fallback (no live plugin connection)', async () => {
    mockSseManager.isInFallback.mockReturnValue(true);
    mockSseManager.getPluginVersion.mockReturnValue('0.1.0.0');
    await runPluginUpdateCheck();
    expect(mockDispatchPluginUpdate).not.toHaveBeenCalled();
  });

  it('fails soft on manifest fetch error', async () => {
    mockFetchJson.mockRejectedValue(new Error('network'));
    await expect(runPluginUpdateCheck()).resolves.toBeUndefined();
    expect(mockSseManager.setLatestPluginVersion).not.toHaveBeenCalled();
    expect(mockDispatchPluginUpdate).not.toHaveBeenCalled();
  });

  it('does nothing when disabled', async () => {
    mockGetSettings.mockResolvedValue({ pluginUpdateCheckEnabled: false, pluginManifestUrl: null });
    await runPluginUpdateCheck();
    expect(mockFetchJson).not.toHaveBeenCalled();
  });
});
