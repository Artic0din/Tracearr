/**
 * Silo Media Server Client
 *
 * Reads Silo through its native admin API (/api/v2) with an admin-owned API key
 * (`sa_...`), either unscoped or scoped with `admin:monitor:read` (+ `libraries:read`
 * for library discovery and `admin:sessions:control` for session termination).
 */

import { fetchJson, HttpClientError } from '../../../utils/http.js';
import {
  cursorDate,
  NOT_NEEDED,
  type DownloadSourceDescription,
  type DownloadSourceRequest,
  type IMediaServerClientWithHistory,
  type MediaLibrary,
  type MediaLibraryItem,
  type MediaServerConfig,
  type MediaSession,
  type MediaUser,
  type MediaWatchHistoryItem,
  type NotNeeded,
  type SyncCursor,
} from '../types.js';
import {
  nextCursor,
  pageItems,
  parseCatalogItem,
  parseLibrary,
  parseSession,
  parseUser,
  parseWatchHistoryEntry,
} from './parser.js';

const PAGE_LIMIT = 200;
const MAX_CONTENT_IDS = 200;
const MAX_TERMINATE_REASON_LEN = 1024;
// A runaway listing must not spin the poller forever.
const MAX_PAGES = 500;
const TIMEOUT_MS = 15_000;

type VerifyResult = { success: true } | { success: false; code: string; message: string };

export class SiloClient implements IMediaServerClientWithHistory {
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
  private async drain(path: string, maxItems?: number): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    const sep = path.includes('?') ? '&' : '?';
    const seenCursors = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_PAGES; page++) {
      const remaining = maxItems !== undefined ? maxItems - rows.length : PAGE_LIMIT;
      if (remaining <= 0) return rows;
      const limit = Math.min(PAGE_LIMIT, Math.max(1, remaining));
      const query = `${sep}limit=${limit}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const data = await this.get<unknown>(`${path}${query}`);
      rows.push(...pageItems(data));
      if (maxItems !== undefined && rows.length >= maxItems) {
        return rows.slice(0, maxItems);
      }
      const next = nextCursor(data);
      if (!next) return rows;
      if (seenCursors.has(next)) {
        throw new Error(`Silo listing ${path} returned a repeated cursor`);
      }
      seenCursors.add(next);
      cursor = next;
    }
    throw new Error(`Silo listing ${path} exceeded ${MAX_PAGES} pages`);
  }

  static async verifyServerAdmin(apiKey: string, serverUrl: string): Promise<VerifyResult> {
    const base = `${serverUrl.replace(/\/$/, '')}/api/v2`;
    try {
      const info = await fetchJson<{ api_major?: unknown }>(`${base}/system/info`, {
        headers: { Accept: 'application/json' },
        service: 'silo',
        timeout: 10_000,
      });
      if (info?.api_major !== undefined && info.api_major !== 2) {
        return {
          success: false,
          code: SiloClient.AdminVerifyError.CONNECTION_FAILED,
          message: `Unsupported Silo API major version: ${String(info.api_major)}.`,
        };
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unable to connect to server';
      return {
        success: false,
        code: SiloClient.AdminVerifyError.CONNECTION_FAILED,
        message: `Cannot reach Silo server at ${serverUrl}. ${message}`,
      };
    }

    try {
      // Probe /admin/sessions?limit=1 rather than /admin/sessions/capabilities:
      // the capabilities endpoint is also admitted by summary-only keys
      // (`admin:sessions:summary:read`) that cannot list sessions, users, or catalog.
      await fetchJson<unknown>(`${base}/admin/sessions?limit=1`, {
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
          message:
            'This Silo API key lacks administrator monitoring access (use an admin key, unscoped or with admin:monitor:read).',
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
      await this.get<unknown>('/admin/sessions?limit=1');
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
    if (typeof server_version !== 'string') return null;
    const trimmed = server_version.trim();
    if (!trimmed || trimmed.toLowerCase() === 'unavailable') return null;
    return trimmed;
  }

  async getSessions(sessionKey?: string): Promise<MediaSession[]> {
    const rows = await this.drain('/admin/sessions');
    const sessions = rows.map(parseSession).filter((s): s is MediaSession => s !== null);
    return sessionKey ? sessions.filter((s) => s.sessionKey === sessionKey) : sessions;
  }

  async describeDownloadSource(request: DownloadSourceRequest): Promise<DownloadSourceDescription> {
    return {
      version: null,
      delivered: null,
      device: {
        deviceId: request.deviceId,
        playerName: request.device,
        product: request.app,
        platform: null,
      },
      ipAddress: null,
    };
  }

  async getUsers(): Promise<MediaUser[]> {
    const rows = await this.drain('/admin/users');
    return rows.map(parseUser).filter((u): u is MediaUser => u !== null);
  }

  async getLibraries(): Promise<MediaLibrary[]> {
    let data: unknown;
    try {
      data = await this.get<unknown>('/libraries');
    } catch (error) {
      // Scoped monitoring keys (`admin:monitor:read` + `libraries:read`) are intentionally
      // denied /libraries because it carries host paths; fall back to /user/libraries.
      if (error instanceof HttpClientError && error.statusCode === 403) {
        data = await this.get<unknown>('/user/libraries');
      } else {
        throw error;
      }
    }
    return pageItems(data)
      .map(parseLibrary)
      .filter((l): l is MediaLibrary => l !== null);
  }

  async terminateSession(sessionId: string, reason?: string): Promise<boolean> {
    const trimmedReason = reason?.trim().slice(0, MAX_TERMINATE_REASON_LEN);
    try {
      await fetchJson<unknown>(
        `${this.baseUrl}/api/v2/admin/sessions/${encodeURIComponent(sessionId)}/terminate`,
        {
          method: 'POST',
          headers: { ...SiloClient.headers(this.apiKey), 'Content-Type': 'application/json' },
          body: JSON.stringify(trimmedReason ? { reason: trimmedReason } : {}),
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

  private catalogTypesFor(libraryType?: string): readonly ('movie' | 'series')[] {
    const normalized = libraryType?.trim().toLowerCase();
    if (normalized === 'tvshows' || normalized === 'series' || normalized === 'show') {
      return ['series'];
    }
    if (normalized === 'mixed') {
      return ['movie', 'series'];
    }
    return ['movie'];
  }

  private catalog(
    libraryId: string,
    types: readonly ('movie' | 'series' | 'episode')[]
  ): Promise<MediaLibraryItem[]> {
    const key = `${libraryId}:${types.join(',')}`;
    let listing = this.catalogCache.get(key);
    if (!listing) {
      listing = Promise.all(
        types.map((type) =>
          this.drain(
            `/admin/catalog/items?library_id=${encodeURIComponent(libraryId)}&type=${type}`
          ).then((rows) =>
            rows.map(parseCatalogItem).filter((i): i is MediaLibraryItem => i !== null)
          )
        )
      ).then((chunks) => chunks.flat());
      // A failed listing must not poison the rest of the run.
      listing.catch(() => this.catalogCache.delete(key));
      this.catalogCache.set(key, listing);
    }
    return listing;
  }

  private async slice(
    libraryId: string,
    types: readonly ('movie' | 'series' | 'episode')[],
    options?: { offset?: number; limit?: number }
  ): Promise<{ items: MediaLibraryItem[]; totalCount: number; rawCount: number }> {
    const all = await this.catalog(libraryId, types);
    const offset = options?.offset ?? 0;
    const items = all.slice(offset, offset + (options?.limit ?? all.length));
    return { items, totalCount: all.length, rawCount: items.length };
  }

  getLibraryItems(
    libraryId: string,
    options?: { offset?: number; limit?: number; libraryType?: string }
  ): Promise<{ items: MediaLibraryItem[]; totalCount: number; rawCount?: number }> {
    return this.slice(libraryId, this.catalogTypesFor(options?.libraryType), options);
  }

  getLibraryLeaves(
    libraryId: string,
    options?: { offset?: number; limit?: number }
  ): Promise<{ items: MediaLibraryItem[]; totalCount: number; rawCount?: number }> {
    return this.slice(libraryId, ['episode'], options);
  }

  // Silo filters by date added only, so edited metadata waits for the periodic full scan.
  private async addedSince(
    libraryId: string,
    types: readonly ('movie' | 'series' | 'episode')[],
    since: Date
  ): Promise<{ items: MediaLibraryItem[]; totalCount: number }> {
    const after = encodeURIComponent(since.toISOString());
    const chunks = await Promise.all(
      types.map((type) =>
        this.drain(
          `/admin/catalog/items?library_id=${encodeURIComponent(libraryId)}&type=${type}&added_after=${after}`
        ).then((rows) =>
          rows.map(parseCatalogItem).filter((i): i is MediaLibraryItem => i !== null)
        )
      )
    );
    const items = chunks.flat();
    return { items, totalCount: items.length };
  }

  async getLibraryItemsSince(
    libraryId: string,
    since: SyncCursor,
    options?: { offset?: number; limit?: number; libraryType?: string }
  ): Promise<{ items: MediaLibraryItem[]; totalCount: number; feed: NotNeeded }> {
    const result = await this.addedSince(
      libraryId,
      this.catalogTypesFor(options?.libraryType),
      cursorDate(since)
    );
    return { ...result, feed: NOT_NEEDED };
  }

  getLibraryLeavesSince(
    libraryId: string,
    since: SyncCursor
  ): Promise<{ items: MediaLibraryItem[]; totalCount: number }> {
    return this.addedSince(libraryId, ['episode'], cursorDate(since));
  }

  async getLibraryRevision(): Promise<NotNeeded> {
    return NOT_NEEDED;
  }

  async getLibrarySeasons(): Promise<NotNeeded> {
    return NOT_NEEDED;
  }

  async getLibrarySeasonsSince(): Promise<NotNeeded> {
    return NOT_NEEDED;
  }

  async getLibraryAlbums(): Promise<NotNeeded> {
    return NOT_NEEDED;
  }

  async getLibraryAlbumsSince(): Promise<NotNeeded> {
    return NOT_NEEDED;
  }

  async checkFilesExist(): Promise<NotNeeded> {
    return NOT_NEEDED;
  }

  async findExistingRatingKeys(
    ratingKeys: string[],
    library: { id: string; type: string }
  ): Promise<Set<string>> {
    const present = new Set<string>();
    const unique = [...new Set(ratingKeys.filter((k) => k.length > 0))];
    for (let i = 0; i < unique.length; i += MAX_CONTENT_IDS) {
      const batch = unique.slice(i, i + MAX_CONTENT_IDS);
      const idParams = batch.map((id) => `content_ids=${encodeURIComponent(id)}`).join('&');
      const rows = await this.drain(
        `/admin/catalog/items?library_id=${encodeURIComponent(library.id)}&${idParams}`
      );
      for (const row of rows) {
        const contentId = row.content_id;
        if (typeof contentId === 'string' && contentId) {
          present.add(contentId);
        }
      }
    }
    return present;
  }

  async getWatchHistory(options?: {
    userId?: string;
    limit?: number;
  }): Promise<MediaWatchHistoryItem[]> {
    const query = options?.userId ? `?user_id=${encodeURIComponent(options.userId)}` : '';
    const rows = await this.drain(`/admin/playback-history${query}`, options?.limit);
    return rows.map(parseWatchHistoryEntry).filter((e): e is MediaWatchHistoryItem => e !== null);
  }
}
