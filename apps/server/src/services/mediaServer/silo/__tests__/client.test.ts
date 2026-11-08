import { describe, it, expect, vi, beforeEach } from 'vitest';
import type * as HttpModule from '../../../../utils/http.js';

vi.mock('../../../../utils/http.js', async (importActual) => {
  const actual = await importActual<typeof HttpModule>();
  return { ...actual, fetchJson: vi.fn() };
});

import { fetchJson, HttpClientError } from '../../../../utils/http.js';
import { SiloClient } from '../client.js';
import { createMediaServerClient } from '../../index.js';

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

  it('is what the factory builds for a silo server', () => {
    const client = createMediaServerClient({ type: 'silo', url: URL, token: 'sa_k' });
    expect(client).toBeInstanceOf(SiloClient);
    expect(client.serverType).toBe('silo');
  });

  it('reads every page of admin sessions with the bearer key', async () => {
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
  });

  it('stops a cursor that never ends instead of polling forever', async () => {
    mockFetchJson.mockResolvedValue({ items: [], page: { has_more: true, next_cursor: 'same' } });
    const client = new SiloClient({ url: URL, token: 'k' });
    await expect(client.getUsers()).rejects.toThrow('exceeded 500 pages');
  });

  it('terminates through the admin terminate route with the reason', async () => {
    respond({ '/admin/sessions/a%2Fb/terminate': { session_id: 'a/b' } });
    const client = new SiloClient({ url: URL, token: 'k' });

    await expect(client.terminateSession('a/b', 'Too many streams')).resolves.toBe(true);

    const init = mockFetchJson.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect(init?.body).toBe(JSON.stringify({ reason: 'Too many streams' }));
  });

  it('sends an empty body when there is no reason, and reports an ended session', async () => {
    respond({ '/admin/sessions/s1/terminate': httpError(404) });
    const client = new SiloClient({ url: URL, token: 'k' });

    await expect(client.terminateSession('s1')).rejects.toThrow('Session not found');
    expect(mockFetchJson.mock.calls[0]?.[1]?.body).toBe('{}');
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

  it('retries a library listing that failed earlier in the run', async () => {
    const path = '/admin/catalog/items?library_id=1&type=movie&limit=200';
    respond({ [path]: httpError(503) });
    const client = new SiloClient({ url: URL, token: 'k' });
    await expect(client.getLibraryItems('1')).rejects.toThrow();

    respond({ [path]: { items: [movie('a')], page: {} } });
    await expect(client.getLibraryItems('1')).resolves.toMatchObject({ totalCount: 1 });
  });

  it('reads identity and version from the system routes', async () => {
    respond({
      '/system/identity': { server_id: 'srv-1' },
      '/system/info': { server_version: 'a5294117' },
    });
    const client = new SiloClient({ url: URL, token: 'k' });
    await expect(client.getServerIdentity()).resolves.toBe('srv-1');
    await expect(client.getSoftwareVersion()).resolves.toBe('a5294117');
  });
});

describe('SiloClient.verifyServerAdmin', () => {
  beforeEach(() => {
    mockFetchJson.mockReset();
  });

  it('accepts an admin key', async () => {
    respond({ '/system/info': {}, '/admin/sessions/capabilities': { allowed: true } });
    await expect(SiloClient.verifyServerAdmin('sa_k', URL)).resolves.toEqual({ success: true });
  });

  it('separates an unreachable server, a bad key and a non-admin key', async () => {
    respond({ '/system/info': new Error('ECONNREFUSED') });
    await expect(SiloClient.verifyServerAdmin('k', URL)).resolves.toMatchObject({
      success: false,
      code: 'CONNECTION_FAILED',
    });

    respond({ '/system/info': {}, '/admin/sessions/capabilities': httpError(401) });
    await expect(SiloClient.verifyServerAdmin('k', URL)).resolves.toMatchObject({
      success: false,
      code: 'INVALID_KEY',
    });

    respond({ '/system/info': {}, '/admin/sessions/capabilities': httpError(403) });
    await expect(SiloClient.verifyServerAdmin('k', URL)).resolves.toMatchObject({
      success: false,
      code: 'NOT_ADMIN',
    });
  });
});
