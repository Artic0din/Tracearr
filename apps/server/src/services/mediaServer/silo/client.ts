/**
 * Silo Media Server Client
 *
 * Reads Silo through its native admin API (/api/v2) with an admin-owned API key
 * (`sa_...`). Silo has no plugin event stream, so the poller covers it.
 */

import { fetchJson, HttpClientError } from '../../../utils/http.js';
import type {
  IMediaServerClient,
  MediaLibrary,
  MediaLibraryItem,
  MediaServerConfig,
  MediaSession,
  MediaUser,
} from '../types.js';
import {
  nextCursor,
  pageItems,
  parseCatalogItem,
  parseLibrary,
  parseSession,
  parseUser,
} from './parser.js';

const PAGE_LIMIT = 200;
// A runaway cursor (server bug, cursor loop) must not spin the poller forever.
const MAX_PAGES = 500;
const TIMEOUT_MS = 15_000;

type VerifyResult = { success: true } | { success: false; code: string; message: string };

export class SiloClient implements IMediaServerClient {
  public readonly serverType = 'silo' as const;

  static readonly AdminVerifyError = {
    CONNECTION_FAILED: 'CONNECTION_FAILED',
    INVALID_KEY: 'INVALID_KEY',
    NOT_ADMIN: 'NOT_ADMIN',
  } as const;

  private readonly baseUrl: string;
  private readonly apiKey: string;
  /** One sync run walks a library page by page; Silo only pages by cursor, so list it once. */
  private readonly catalogCache = new Map<string, Promise<MediaLibraryItem[]>>();

  constructor(config: MediaServerConfig) {
    this.baseUrl = config.url.replace(/\/$/, '');
    this.apiKey = config.token;
  }

  private static headers(apiKey: string): Record<string, string> {
    return { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
  }

  private get<T>(path: string): Promise<T> {
    return fetchJson<T>(`${this.baseUrl}/api/v2${path}`, {
      headers: SiloClient.headers(this.apiKey),
      service: 'silo',
      timeout: TIMEOUT_MS,
    });
  }

  /** Every row of a cursor-paged `{items, page}` listing. */
  private async drain(path: string): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    const sep = path.includes('?') ? '&' : '?';
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = `${sep}limit=${PAGE_LIMIT}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const data = await this.get<unknown>(`${path}${query}`);
      rows.push(...pageItems(data));
      cursor = nextCursor(data);
      if (!cursor) return rows;
    }
    throw new Error(`Silo listing ${path} exceeded ${MAX_PAGES} pages`);
  }

  static async verifyServerAdmin(apiKey: string, serverUrl: string): Promise<VerifyResult> {
    const base = `${serverUrl.replace(/\/$/, '')}/api/v2`;
    try {
      await fetchJson<unknown>(`${base}/system/info`, {
        headers: { Accept: 'application/json' },
        service: 'silo',
        timeout: 10_000,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to connect to server';
      return {
        success: false,
        code: SiloClient.AdminVerifyError.CONNECTION_FAILED,
        message: `Cannot reach Silo server at ${serverUrl}. ${message}`,
      };
    }

    try {
      await fetchJson<unknown>(`${base}/admin/sessions/capabilities`, {
        headers: SiloClient.headers(apiKey),
        service: 'silo',
        timeout: 10_000,
      });
      return { success: true };
    } catch (error) {
      if (error instanceof HttpClientError && error.statusCode === 401) {
        return {
          success: false,
          code: SiloClient.AdminVerifyError.INVALID_KEY,
          message: 'Silo rejected this API key.',
        };
      }
      if (error instanceof HttpClientError && error.statusCode === 403) {
        return {
          success: false,
          code: SiloClient.AdminVerifyError.NOT_ADMIN,
          message: 'This Silo API key does not belong to an administrator.',
        };
      }
      const message = error instanceof Error ? error.message : 'Unknown error';
      return {
        success: false,
        code: SiloClient.AdminVerifyError.CONNECTION_FAILED,
        message: `Silo admin check failed. ${message}`,
      };
    }
  }

  async testConnection(): Promise<boolean> {
    try {
      await this.get<unknown>('/admin/sessions/capabilities');
      return true;
    } catch {
      return false;
    }
  }

  async getServerIdentity(): Promise<string | null> {
    const { server_id } = await this.get<{ server_id?: unknown }>('/system/identity');
    return typeof server_id === 'string' && server_id ? server_id : null;
  }

  async getSoftwareVersion(): Promise<string | null> {
    const { server_version } = await this.get<{ server_version?: unknown }>('/system/info');
    return typeof server_version === 'string' && server_version ? server_version : null;
  }

  async getSessions(): Promise<MediaSession[]> {
    const rows = await this.drain('/admin/sessions');
    return rows.map(parseSession).filter((s): s is MediaSession => s !== null);
  }

  async getUsers(): Promise<MediaUser[]> {
    const rows = await this.drain('/admin/users');
    return rows.map(parseUser).filter((u): u is MediaUser => u !== null);
  }

  async getLibraries(): Promise<MediaLibrary[]> {
    const data = await this.get<unknown>('/libraries');
    return pageItems(data)
      .map(parseLibrary)
      .filter((l): l is MediaLibrary => l !== null);
  }

  async terminateSession(sessionId: string, reason?: string): Promise<boolean> {
    try {
      await fetchJson<unknown>(
        `${this.baseUrl}/api/v2/admin/sessions/${encodeURIComponent(sessionId)}/terminate`,
        {
          method: 'POST',
          headers: { ...SiloClient.headers(this.apiKey), 'Content-Type': 'application/json' },
          body: JSON.stringify(reason ? { reason } : {}),
          service: 'silo',
          timeout: TIMEOUT_MS,
        }
      );
      return true;
    } catch (error) {
      if (error instanceof HttpClientError && error.statusCode === 404) {
        throw new Error('Session not found (may have already ended)');
      }
      throw error;
    }
  }

  private catalog(libraryId: string, type: string): Promise<MediaLibraryItem[]> {
    const key = `${libraryId}:${type}`;
    let listing = this.catalogCache.get(key);
    if (!listing) {
      listing = this.drain(
        `/admin/catalog/items?library_id=${encodeURIComponent(libraryId)}&type=${type}`
      ).then((rows) => rows.map(parseCatalogItem).filter((i): i is MediaLibraryItem => i !== null));
      // A failed listing must not poison the rest of the run.
      listing.catch(() => this.catalogCache.delete(key));
      this.catalogCache.set(key, listing);
    }
    return listing;
  }

  private async slice(
    libraryId: string,
    type: string,
    options?: { offset?: number; limit?: number }
  ): Promise<{ items: MediaLibraryItem[]; totalCount: number; rawCount: number }> {
    const all = await this.catalog(libraryId, type);
    const offset = options?.offset ?? 0;
    const items = all.slice(offset, offset + (options?.limit ?? all.length));
    return { items, totalCount: all.length, rawCount: items.length };
  }

  getLibraryItems(
    libraryId: string,
    options?: { offset?: number; limit?: number; libraryType?: string }
  ): Promise<{ items: MediaLibraryItem[]; totalCount: number; rawCount?: number }> {
    const type = options?.libraryType === 'tvshows' ? 'series' : 'movie';
    return this.slice(libraryId, type, options);
  }

  getLibraryLeaves(
    libraryId: string,
    options?: { offset?: number; limit?: number }
  ): Promise<{ items: MediaLibraryItem[]; totalCount: number; rawCount?: number }> {
    return this.slice(libraryId, 'episode', options);
  }
}
