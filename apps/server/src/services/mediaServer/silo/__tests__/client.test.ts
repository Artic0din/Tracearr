import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as HttpModule from '../../../../utils/http.js';

vi.mock('../../../../utils/http.js', async (importActual) => {
  const actual = await importActual<typeof HttpModule>();
  return { ...actual, fetchJson: vi.fn() };
});

import { fetchJson, HttpClientError } from '../../../../utils/http.js';
import { SiloClient } from '../client.js';
import { createMediaServerClient } from '../../index.js';
import { NOT_NEEDED } from '../../types.js';

const mockFetchJson = vi.mocked(fetchJson);
const URL = 'http://silo.local:8091';

function httpError(statusCode: number): HttpClientError {
  return new HttpClientError({ service: 'silo', statusCode, statusText: 'error', url: `${URL}/x` });
}

function respond(routes: Record<string, unknown>) {
  mockFetchJson.mockImplementation(async (url: string) => {
    const path = url.replace(`${URL}/api/v2`, '');
    if (!(path in routes)) throw new Error(`unexpected fetch ${path}`);
    const value = routes[path];
    if (value instanceof Error) throw value;
    return value;
  });
}

function movie(id: string) {
  return {
    content_id: id,
    type: 'movie',
    title: id,
    added_at: '2026-10-07T00:00:00Z',
    versions: [],
  };
}

describe('SiloClient', () => {
  beforeEach(() => {
    mockFetchJson.mockReset();
  });

  it('is what the factory builds for a silo server and supports watch history', () => {
    const client = createMediaServerClient({ type: 'silo', url: URL, token: 'sa_k' });
    expect(client).toBeInstanceOf(SiloClient);
    expect(client.serverType).toBe('silo');
    expect(typeof (client as SiloClient).getWatchHistory).toBe('function');
  });

  it('reads every page of admin sessions with the bearer key and supports sessionKey filtering', async () => {
    respond({
      '/admin/sessions?limit=200': {
        items: [{ session_id: 's1', user_id: '1' }],
        page: { has_more: true, next_cursor: 'c/2' },
      },
      '/admin/sessions?limit=200&cursor=c%2F2': {
        items: [{ session_id: 's2', user_id: '2' }, { session_id: '' }],
        page: { has_more: false },
      },
    });
    const client = new SiloClient({ url: `${URL}/`, token: 'sa_key' });

    const sessions = await client.getSessions();
    expect(sessions.map((s) => s.sessionKey)).toEqual(['s1', 's2']);
    const headers = mockFetchJson.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.Authorization).toBe('Bearer sa_key');

    const single = await client.getSessions('s2');
    expect(single.map((s) => s.sessionKey)).toEqual(['s2']);
  });

  it('detects a repeated cursor immediately instead of looping 500 times', async () => {
    mockFetchJson.mockResolvedValue({ items: [], page: { has_more: true, next_cursor: 'same' } });
    const client = new SiloClient({ url: URL, token: 'k' });
    await expect(client.getUsers()).rejects.toThrow('repeated cursor');
    expect(mockFetchJson).toHaveBeenCalledTimes(2);
  });

  it('terminates through the admin terminate route with the reason and truncates >1024 chars', async () => {
    respond({
      '/admin/sessions/a%2Fb/terminate': { session_id: 'a/b' },
      '/admin/sessions/s2/terminate': { session_id: 's2' },
    });
    const client = new SiloClient({ url: URL, token: 'k' });

    await expect(client.terminateSession('a/b', 'Too many streams')).resolves.toBe(true);
    const init = mockFetchJson.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ reason: 'Too many streams' }));

    const longReason = 'x'.repeat(1500);
    await expect(client.terminateSession('s2', longReason)).resolves.toBe(true);
    const body = JSON.parse(String(mockFetchJson.mock.calls[1]?.[1]?.body)) as { reason: string };
    expect(body.reason).toHaveLength(1024);
  });

  it('sends an empty body when there is no reason, and reports an ended session', async () => {
    respond({ '/admin/sessions/s1/terminate': httpError(404) });
    const client = new SiloClient({ url: URL, token: 'k' });

    await expect(client.terminateSession('s1')).rejects.toThrow('Session not found');
    expect(mockFetchJson.mock.calls[0]?.[1]?.body).toBe('{}');
  });

  it('falls back from /libraries to /user/libraries on 403 for scoped monitoring keys', async () => {
    respond({
      '/libraries': httpError(403),
      '/user/libraries': {
        items: [
          { id: '1', name: 'Movies', type: 'movies', enabled: true, paths: ['/movies'] },
          { id: '2', name: 'Disabled', type: 'movies', enabled: false, paths: [] },
        ],
      },
    });
    const client = new SiloClient({ url: URL, token: 'sa_scoped' });

    const libs = await client.getLibraries();
    expect(libs).toEqual([{ id: '1', name: 'Movies', type: 'movies', locations: ['/movies'] }]);
  });

  it('lists a library once per run and pages it from memory', async () => {
    respond({
      '/admin/catalog/items?library_id=1&type=movie&limit=200': {
        items: [movie('a'), movie('b'), movie('c')],
        page: { has_more: false },
      },
    });
    const client = new SiloClient({ url: URL, token: 'k' });

    const head = await client.getLibraryItems('1', { offset: 0, limit: 1, libraryType: 'movies' });
    const page = await client.getLibraryItems('1', { offset: 1, limit: 2, libraryType: 'movies' });

    expect(head.totalCount).toBe(3);
    expect(page.items.map((i) => i.ratingKey)).toEqual(['b', 'c']);
    expect(mockFetchJson).toHaveBeenCalledTimes(1);
  });

  it('fetches both movies and series for mixed libraries', async () => {
    respond({
      '/admin/catalog/items?library_id=5&type=movie&limit=200': {
        items: [movie('m1')],
        page: { has_more: false },
      },
      '/admin/catalog/items?library_id=5&type=series&limit=200': {
        items: [
          {
            content_id: 's1',
            type: 'series',
            title: 'Show',
            added_at: '2026-10-07T00:00:00Z',
            versions: [],
          },
        ],
        page: { has_more: false },
      },
    });
    const client = new SiloClient({ url: URL, token: 'k' });

    const result = await client.getLibraryItems('5', { libraryType: 'mixed' });
    expect(result.items.map((i) => i.ratingKey)).toEqual(['m1', 's1']);
    expect(result.totalCount).toBe(2);
  });

  it('lists series for tvshows libraries and episodes as leaves', async () => {
    respond({
      '/admin/catalog/items?library_id=2&type=series&limit=200': { items: [], page: {} },
      '/admin/catalog/items?library_id=2&type=episode&limit=200': { items: [], page: {} },
    });
    const client = new SiloClient({ url: URL, token: 'k' });

    await client.getLibraryItems('2', { libraryType: 'tvshows' });
    await client.getLibraryLeaves('2');

    expect(mockFetchJson).toHaveBeenCalledTimes(2);
  });

  it('lists only items added since the last sync for incremental runs', async () => {
    const since = new Date('2026-11-01T00:00:00.000Z');
    const after = 'added_after=2026-11-01T00%3A00%3A00.000Z&limit=200';
    respond({
      [`/admin/catalog/items?library_id=2&type=series&${after}`]: { items: [], page: {} },
      [`/admin/catalog/items?library_id=2&type=episode&${after}`]: {
        items: [
          {
            content_id: 'ep-9',
            type: 'episode',
            title: 'New',
            added_at: '2026-11-05T00:00:00Z',
            versions: [],
          },
        ],
        page: {},
      },
    });
    const client = new SiloClient({ url: URL, token: 'k' });

    await expect(
      client.getLibraryItemsSince('2', { kind: 'date', since }, { libraryType: 'tvshows' })
    ).resolves.toEqual({
      items: [],
      totalCount: 0,
      feed: NOT_NEEDED,
    });
    const leaves = await client.getLibraryLeavesSince('2', { kind: 'date', since });
    expect(leaves.totalCount).toBe(1);
    expect(leaves.items[0]?.ratingKey).toBe('ep-9');
  });

  it('batches findExistingRatingKeys up to 200 content_ids per request', async () => {
    const keys = Array.from({ length: 205 }, (_, i) => `movie-${i}`);
    mockFetchJson.mockImplementation(async (url: string) => {
      const parsed = new globalThis.URL(url);
      const ids = parsed.searchParams.getAll('content_ids');
      expect(parsed.searchParams.get('library_id')).toBe('1');
      // Report only even-numbered keys as existing
      return {
        items: ids.filter((_, idx) => idx % 2 === 0).map((id) => ({ content_id: id })),
        page: { has_more: false },
      };
    });

    const client = new SiloClient({ url: URL, token: 'k' });
    const found = await client.findExistingRatingKeys(keys, { id: '1', type: 'movies' });

    expect(mockFetchJson).toHaveBeenCalledTimes(2);
    expect(found.has('movie-0')).toBe(true);
    expect(found.has('movie-1')).toBe(false);
    expect(found.has('movie-200')).toBe(true);
    expect(found.has('movie-204')).toBe(true);
  });

  it('reads watch history from /admin/playback-history', async () => {
    respond({
      '/admin/playback-history?user_id=4&limit=10': {
        items: [
          {
            id: 'h1',
            user_id: '4',
            username: 'alice',
            media_item_id: 'movie-1',
            media_type: 'movie',
            media_title: 'Heat',
            ended_at: '2026-11-10T20:00:00Z',
            duration_watched_seconds: 9000,
            file_duration: 10200,
          },
        ],
        page: { has_more: false },
      },
    });
    const client = new SiloClient({ url: URL, token: 'k' });

    const history = await client.getWatchHistory({ userId: '4', limit: 10 });
    expect(history).toHaveLength(1);
    expect(history[0]).toEqual({
      mediaId: 'movie-1',
      title: 'Heat',
      type: 'movie',
      watchedAt: '2026-11-10T20:00:00Z',
      userId: '4',
    });
  });

  it('retries a library listing that failed earlier in the run', async () => {
    const path = '/admin/catalog/items?library_id=1&type=movie&limit=200';
    respond({ [path]: httpError(503) });
    const client = new SiloClient({ url: URL, token: 'k' });
    await expect(client.getLibraryItems('1')).rejects.toThrow();

    respond({ [path]: { items: [movie('a')], page: {} } });
    await expect(client.getLibraryItems('1')).resolves.toMatchObject({ totalCount: 1 });
  });

  it('reads identity and version from the system routes, treating "unavailable" as null', async () => {
    respond({
      '/system/identity': { server_id: 'srv-1' },
      '/system/info': { server_version: 'a5294117' },
    });
    const client = new SiloClient({ url: URL, token: 'k' });
    await expect(client.getServerIdentity()).resolves.toBe('srv-1');
    await expect(client.getSoftwareVersion()).resolves.toBe('a5294117');

    respond({ '/system/info': { server_version: 'unavailable' } });
    await expect(client.getSoftwareVersion()).resolves.toBeNull();
  });

  it('tests connection against /admin/sessions?limit=1', async () => {
    respond({ '/admin/sessions?limit=1': { items: [], page: {} } });
    const client = new SiloClient({ url: URL, token: 'k' });
    await expect(client.testConnection()).resolves.toBe(true);

    respond({ '/admin/sessions?limit=1': httpError(403) });
    await expect(client.testConnection()).resolves.toBe(false);
  });

  it('reports unsupported library operations as NOT_NEEDED', async () => {
    const client = new SiloClient({ url: URL, token: 'k' });
    await expect(client.getLibraryRevision()).resolves.toBe(NOT_NEEDED);
    await expect(client.getLibrarySeasons()).resolves.toBe(NOT_NEEDED);
    await expect(client.getLibrarySeasonsSince()).resolves.toBe(NOT_NEEDED);
    await expect(client.getLibraryAlbums()).resolves.toBe(NOT_NEEDED);
    await expect(client.getLibraryAlbumsSince()).resolves.toBe(NOT_NEEDED);
    await expect(client.checkFilesExist()).resolves.toBe(NOT_NEEDED);
  });
});

describe('SiloClient.verifyServerAdmin', () => {
  beforeEach(() => {
    mockFetchJson.mockReset();
  });

  it('accepts an admin key when api_major is 2 and /admin/sessions?limit=1 succeeds', async () => {
    respond({ '/system/info': { api_major: 2 }, '/admin/sessions?limit=1': { items: [] } });
    await expect(SiloClient.verifyServerAdmin('sa_k', URL)).resolves.toEqual({ success: true });
  });

  it('rejects an unsupported api_major version', async () => {
    respond({ '/system/info': { api_major: 3 } });
    await expect(SiloClient.verifyServerAdmin('sa_k', URL)).resolves.toMatchObject({
      success: false,
      code: 'CONNECTION_FAILED',
    });
  });

  it('separates an unreachable server, a bad key and a non-admin or under-scoped key', async () => {
    respond({ '/system/info': new Error('ECONNREFUSED') });
    await expect(SiloClient.verifyServerAdmin('k', URL)).resolves.toMatchObject({
      success: false,
      code: 'CONNECTION_FAILED',
    });

    respond({ '/system/info': { api_major: 2 }, '/admin/sessions?limit=1': httpError(401) });
    await expect(SiloClient.verifyServerAdmin('k', URL)).resolves.toMatchObject({
      success: false,
      code: 'INVALID_KEY',
    });

    respond({ '/system/info': { api_major: 2 }, '/admin/sessions?limit=1': httpError(403) });
    await expect(SiloClient.verifyServerAdmin('k', URL)).resolves.toMatchObject({
      success: false,
      code: 'NOT_ADMIN',
    });
  });
});
