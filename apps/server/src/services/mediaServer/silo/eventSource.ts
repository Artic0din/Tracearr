/**
 * Silo Realtime WebSocket EventSource
 *
 * Connects to Silo's native v2 realtime event socket (`silo.events.v2`):
 *   1. POST /api/v2/events/ws-ticket with `Authorization: Bearer <apiKey>`
 *      (no X-Profile-Id) to mint a single-use ticket.
 *   2. Upgrade GET /api/v2/events/ws?channels=sessions,catalog offering exact
 *      subprotocols `['silo.events.v2', 'silo.ticket.<ticket>']`.
 *   3. On `hello`, reply with `{ type: 'subscribe', channels }` intersected
 *      with `available_channels`.
 *   4. On `subscribed`, mark connected and trigger an initial session poll.
 *   5. Dispatch `sessions` and `catalog` events to SSEManager.
 *
 * Important Silo authorization contract:
 *   Only API keys carrying the `admin:monitor:read` scope can mint a ticket
 *   for admin channels. Unscoped administrator keys receive `403 permission_denied`.
 *   When the server answers 403/404/501, we enter `'unsupported'` so Tracearr
 *   seamlessly falls back to polling without error spam or reconnect storms.
 */

import { EventEmitter } from 'events';
import { SSE_CONFIG, type SSEConnectionState } from '@tracearr/shared';

export const SILO_EVENTS_PROTOCOL = 'silo.events.v2';
const DESIRED_CHANNELS = ['sessions', 'catalog'] as const;

// Handshake timeout from opening WebSocket until `subscribed` frame arrives
const HANDSHAKE_TIMEOUT_MS = 30_000;
// Ticket mint HTTP request timeout
const TICKET_MINT_TIMEOUT_MS = 10_000;
// Re-probe cadence when key lacks admin:monitor:read or server lacks realtime socket
const UNSUPPORTED_REPROBE_MS = 3 * 60 * 1000;
// Re-probe cadence after exhausting retries or receiving 4002 credential_invalid
const FALLBACK_RETRY_MS = 3 * 60 * 1000;
// Guard against rapid 4001/4003 reconnect loops if a connection dies right after opening
const MIN_STABLE_CONNECTION_MS = 5_000;
// Delay before immediate reconnect on 4001/4003
const IMMEDIATE_RECONNECT_DELAY_MS = 250;
// Cap Retry-After honored from 503 responses
const MAX_RETRY_AFTER_MS = 60_000;
// Coalesce burst catalog removals into bounded batched content_ids lookups (Silo max 200)
const REMOVAL_BATCH_DELAY_MS = 250;
const MAX_REMOVAL_BATCH_SIZE = 200;

export interface SiloSessionEvent {
  event: string;
  sessionId: string | null;
  state: string | null;
}

export interface SiloLibraryEvent {
  type: 'added' | 'removed';
  itemId: string | null;
}

export interface SiloEventSourceEvents {
  'session:event': SiloSessionEvent;
  'library:event': SiloLibraryEvent;
  'connection:state': SSEConnectionState;
  'connection:error': Error;
}

/** Minimal DOM-compatible WebSocket interface (matches Node 22+ global WebSocket) */
export interface SiloWebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
}

export interface SiloEventSourceConfig {
  serverId: string;
  serverName: string;
  url: string;
  token: string;
  /** Optional overrides for unit tests */
  fetchFn?: typeof fetch;
  webSocketFactory?: (url: string, protocols: string[]) => SiloWebSocketLike;
}

interface WsTicketResponse {
  ticket?: unknown;
  expires_in?: unknown;
  max_connection_seconds?: unknown;
  protocol?: unknown;
}

interface SiloWsFrame {
  type?: unknown;
  channel?: unknown;
  event?: unknown;
  available_channels?: unknown;
  channels?: unknown;
  data?: unknown;
  message?: unknown;
}

function defaultWebSocketFactory(url: string, protocols: string[]): SiloWebSocketLike {
  const GlobalWS = (
    globalThis as { WebSocket?: new (u: string, p?: string[]) => SiloWebSocketLike }
  ).WebSocket;
  if (!GlobalWS) {
    throw new Error('Global WebSocket is not available in this Node.js runtime');
  }
  return new GlobalWS(url, protocols);
}

function toWebSocketBaseUrl(httpUrl: string): string {
  const trimmed = httpUrl.replace(/\/+$/, '');
  if (trimmed.startsWith('https://')) {
    return `wss://${trimmed.slice('https://'.length)}`;
  }
  if (trimmed.startsWith('http://')) {
    return `ws://${trimmed.slice('http://'.length)}`;
  }
  return trimmed;
}

function parseRetryAfterMs(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.min(Math.round(seconds * 1000), MAX_RETRY_AFTER_MS);
  }
  const dateMs = Date.parse(header);
  if (!Number.isNaN(dateMs)) {
    const diff = dateMs - Date.now();
    if (diff > 0) return Math.min(diff, MAX_RETRY_AFTER_MS);
  }
  return null;
}

export class SiloEventSource extends EventEmitter {
  private readonly serverId: string;
  private readonly serverName: string;
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchFn: typeof fetch;
  private readonly webSocketFactory: (url: string, protocols: string[]) => SiloWebSocketLike;

  private ws: SiloWebSocketLike | null = null;
  private state: SSEConnectionState = 'disconnected';
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private handshakeTimer: NodeJS.Timeout | null = null;
  private stabilityTimer: NodeJS.Timeout | null = null;
  private removalFlushTimer: NodeJS.Timeout | null = null;
  private pendingRemovals = new Set<string>();
  private removalFlushInFlight = false;
  private connectedAt: Date | null = null;
  private lastEventTime: Date | null = null;
  private lastError: Error | null = null;
  private connectGeneration = 0;
  private pendingAccessChange = false;

  constructor(config: SiloEventSourceConfig) {
    super();
    this.serverId = config.serverId;
    this.serverName = config.serverName;
    this.baseUrl = config.url.replace(/\/+$/, '');
    this.token = config.token;
    this.fetchFn = config.fetchFn ?? fetch;
    this.webSocketFactory = config.webSocketFactory ?? defaultWebSocketFactory;
  }

  getState(): SSEConnectionState {
    return this.state;
  }

  getStatus(): {
    serverId: string;
    serverName: string;
    state: SSEConnectionState;
    connectedAt: Date | null;
    lastEventAt: Date | null;
    reconnectAttempts: number;
    error: string | null;
  } {
    return {
      serverId: this.serverId,
      serverName: this.serverName,
      state: this.state,
      connectedAt: this.connectedAt,
      lastEventAt: this.lastEventTime,
      reconnectAttempts: this.reconnectAttempts,
      error: this.lastError?.message ?? null,
    };
  }

  async connect(): Promise<void> {
    if (this.state === 'connected' || this.state === 'connecting') {
      return;
    }

    const generation = ++this.connectGeneration;
    this.setState('connecting');
    this.clearTimers();
    this.cleanupSocket();
    this.pendingAccessChange = false;

    const ticketResult = await this.mintTicket();
    // Bail if disconnect() or another connect() ran while minting
    if (generation !== this.connectGeneration || this.state === 'disconnected') {
      return;
    }

    if (!ticketResult.ok) {
      this.handleTicketFailure(ticketResult);
      return;
    }

    const wsUrl = `${toWebSocketBaseUrl(this.baseUrl)}/api/v2/events/ws?channels=${DESIRED_CHANNELS.join(',')}`;
    const protocols = [ticketResult.protocol, `silo.ticket.${ticketResult.ticket}`];

    console.log(`[SiloWS] Connecting to ${this.serverName} at ${wsUrl}`);

    try {
      const ws = this.webSocketFactory(wsUrl, protocols);
      this.ws = ws;
      this.startHandshakeTimeout(generation);

      ws.onmessage = (ev) => {
        if (generation !== this.connectGeneration) return;
        this.handleMessage(ev.data, generation);
      };

      ws.onerror = () => {
        if (generation !== this.connectGeneration) return;
        // Standard WebSocket always follows error with close; record error here
        // and let onclose drive reconnection so we never double-schedule.
        this.lastError = new Error('Silo WebSocket connection error');
      };

      ws.onclose = (ev) => {
        if (generation !== this.connectGeneration) return;
        this.handleClose(ev.code ?? 1006, ev.reason ?? '');
      };
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.lastError = err;
      this.emit('connection:error', err);
      this.cleanupSocket();
      this.clearTimers();
      this.scheduleReconnect();
    }
  }

  disconnect(): void {
    console.log(`[SiloWS] Disconnecting from ${this.serverName}`);
    this.connectGeneration++;
    this.clearTimers();
    this.cleanupSocket();
    this.setState('disconnected');
    this.connectedAt = null;
  }

  retryFromFallback(): void {
    if (this.state !== 'fallback' && this.state !== 'unsupported') return;
    console.log(`[SiloWS] Poll reached ${this.serverName}, retrying WebSocket from ${this.state}`);
    this.clearTimers();
    this.reconnectAttempts = 0;
    void this.connect();
  }

  private async mintTicket(): Promise<
    | { ok: true; ticket: string; protocol: string }
    | { ok: false; status: number | null; retryAfterMs: number | null; message: string }
  > {
    const url = `${this.baseUrl}/api/v2/events/ws-ticket`;
    try {
      const response = await this.fetchFn(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(TICKET_MINT_TIMEOUT_MS),
      });

      if (!response.ok) {
        const retryAfterMs = parseRetryAfterMs(response.headers?.get('retry-after') ?? null);
        await response.body?.cancel().catch(() => undefined);
        return {
          ok: false,
          status: response.status,
          retryAfterMs,
          message: `Ticket mint failed: HTTP ${response.status} ${response.statusText}`.trim(),
        };
      }

      const body = (await response.json()) as WsTicketResponse;
      if (typeof body.ticket !== 'string' || body.ticket.length === 0) {
        return {
          ok: false,
          status: response.status,
          retryAfterMs: null,
          message: 'Ticket mint response missing ticket',
        };
      }

      const protocol =
        typeof body.protocol === 'string' && body.protocol.length > 0
          ? body.protocol
          : SILO_EVENTS_PROTOCOL;

      return { ok: true, ticket: body.ticket, protocol };
    } catch (error) {
      return {
        ok: false,
        status: null,
        retryAfterMs: null,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private handleTicketFailure(failure: {
    status: number | null;
    retryAfterMs: number | null;
    message: string;
  }): void {
    this.clearTimers();
    this.lastError = new Error(failure.message);

    // 403 (e.g. unscoped admin key without admin:monitor:read), 404 or 501 (older server):
    // gracefully stay on polling and periodically re-probe in case key/server changes.
    if (failure.status === 403 || failure.status === 404 || failure.status === 501) {
      console.log(
        `[SiloWS] Realtime socket unavailable on ${this.serverName} (HTTP ${failure.status}), using polling`
      );
      this.enterUnsupported();
      return;
    }

    this.emit('connection:error', this.lastError);

    // 401: invalid/revoked key — enter fallback instead of hammering auth failures
    if (failure.status === 401) {
      console.error(`[SiloWS] Auth error minting ticket on ${this.serverName}: ${failure.message}`);
      this.enterFallback();
      return;
    }

    // 503 dependency_unavailable or transient network/5xx error: retry with backoff
    this.scheduleReconnect(failure.retryAfterMs ?? undefined);
  }

  private handleMessage(rawData: unknown, generation: number): void {
    if (typeof rawData !== 'string') return;
    this.lastEventTime = new Date();

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawData);
    } catch {
      return;
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    const frame = parsed as SiloWsFrame;

    const type = typeof frame.type === 'string' ? frame.type : null;
    if (!type) return;

    switch (type) {
      case 'hello': {
        const available = Array.isArray(frame.available_channels)
          ? frame.available_channels.filter((c): c is string => typeof c === 'string')
          : [];
        const channels = DESIRED_CHANNELS.filter((c) => available.includes(c));
        if (channels.length === 0) {
          console.log(
            `[SiloWS] ${this.serverName} exposed no monitoring channels (${available.join(', ') || 'none'}), using polling`
          );
          this.lastError = new Error('No monitoring channels available on realtime socket');
          this.connectGeneration++;
          this.clearTimers();
          this.cleanupSocket();
          this.enterUnsupported();
          return;
        }
        try {
          this.ws?.send(JSON.stringify({ type: 'subscribe', channels }));
        } catch (err) {
          if (generation !== this.connectGeneration) return;
          this.lastError = err instanceof Error ? err : new Error(String(err));
          this.cleanupSocket();
          this.clearTimers();
          this.scheduleReconnect();
        }
        return;
      }

      case 'subscribed': {
        this.clearHandshakeTimeout();
        this.connectedAt = new Date();
        this.lastError = null;
        // Only reset retry backoff once the connection stays healthy past the stability window,
        // so flapping subscribe->close loops still back off and eventually enter fallback.
        if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
        this.stabilityTimer = setTimeout(() => {
          this.stabilityTimer = null;
          if (generation === this.connectGeneration && this.state === 'connected') {
            this.reconnectAttempts = 0;
          }
        }, MIN_STABLE_CONNECTION_MS);
        console.log(`[SiloWS] Connected to ${this.serverName}`);
        this.setState('connected');
        // Per docs/realtime-api.md: read GET /api/v2/admin/sessions on subscribe to reconcile state
        this.emit('session:event', {
          event: 'subscribed',
          sessionId: null,
          state: null,
        } satisfies SiloSessionEvent);
        return;
      }

      case 'snapshot': {
        if (frame.channel === 'sessions') {
          this.emit('session:event', {
            event: 'snapshot',
            sessionId: null,
            state: null,
          } satisfies SiloSessionEvent);
        }
        return;
      }

      case 'event': {
        this.handleEventFrame(frame, generation);
        return;
      }

      case 'access_changed': {
        // Server will immediately follow with close code 4001
        this.pendingAccessChange = true;
        return;
      }

      case 'error': {
        const msg = typeof frame.message === 'string' ? frame.message : 'Silo realtime error frame';
        console.warn(`[SiloWS] ${this.serverName}: ${msg}`);
        return;
      }

      default:
        return;
    }
  }

  private handleEventFrame(frame: SiloWsFrame, generation: number): void {
    const channel = typeof frame.channel === 'string' ? frame.channel : null;
    const event = typeof frame.event === 'string' ? frame.event : null;
    const data =
      frame.data && typeof frame.data === 'object' ? (frame.data as Record<string, unknown>) : null;

    if (channel === 'sessions' && event) {
      this.emit('session:event', {
        event,
        sessionId: typeof data?.session_id === 'string' ? data.session_id : null,
        state: typeof data?.state === 'string' ? data.state : null,
      } satisfies SiloSessionEvent);
      return;
    }

    if (channel === 'catalog' && event) {
      if (event === 'catalog.item.changed') {
        const change = typeof data?.change === 'string' ? data.change : null;
        const contentId = typeof data?.content_id === 'string' ? data.content_id : null;
        if (change === 'removed') {
          if (!contentId) {
            this.emit('library:event', {
              type: 'removed',
              itemId: null,
            } satisfies SiloLibraryEvent);
          } else {
            // Silo emits catalog.item.changed(removed) per library; batch and confirm
            // absence across all enabled libraries before forwarding global tombstone ids.
            this.enqueueRemovalConfirmation(contentId, generation);
          }
        } else if (change === 'added') {
          // Only additions trigger event-driven incremental sync (Silo's added_after only
          // returns new items). files_changed and metadata_updated reconcile on the
          // periodic full scan, matching Plex/Jellyfin behavior in libraryEventSync.ts.
          this.emit('library:event', {
            type: 'added',
            itemId: contentId,
          } satisfies SiloLibraryEvent);
        }
      } else if (event === 'catalog.library.changed') {
        this.emit('library:event', {
          type: 'added',
          itemId: null,
        } satisfies SiloLibraryEvent);
      }
    }
  }

  private enqueueRemovalConfirmation(contentId: string, generation: number): void {
    this.pendingRemovals.add(contentId);
    if (this.pendingRemovals.size >= MAX_REMOVAL_BATCH_SIZE && !this.removalFlushInFlight) {
      if (this.removalFlushTimer) {
        clearTimeout(this.removalFlushTimer);
        this.removalFlushTimer = null;
      }
      void this.flushPendingRemovals(generation);
      return;
    }
    if (!this.removalFlushTimer && !this.removalFlushInFlight) {
      this.removalFlushTimer = setTimeout(() => {
        this.removalFlushTimer = null;
        void this.flushPendingRemovals(generation);
      }, REMOVAL_BATCH_DELAY_MS);
    }
  }

  private async flushPendingRemovals(generation: number): Promise<void> {
    if (this.removalFlushInFlight || this.pendingRemovals.size === 0) return;
    if (generation !== this.connectGeneration || this.state === 'disconnected') {
      this.pendingRemovals.clear();
      return;
    }

    const batch = Array.from(this.pendingRemovals).slice(0, MAX_REMOVAL_BATCH_SIZE);
    for (const id of batch) this.pendingRemovals.delete(id);

    this.removalFlushInFlight = true;
    let presentIds: Set<string> | null = null;
    try {
      const idParams = batch.map((id) => `content_ids=${encodeURIComponent(id)}`).join('&');
      const url = `${this.baseUrl}/api/v2/admin/catalog/items?${idParams}&limit=${batch.length}`;
      const response = await this.fetchFn(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${this.token}`,
          Accept: 'application/json',
        },
        signal: AbortSignal.timeout(TICKET_MINT_TIMEOUT_MS),
      });
      if (response.ok) {
        const body: unknown = await response.json();
        // Require a valid items array before treating any id as absent; a malformed
        // response must never tombstone still-present library items.
        if (
          body !== null &&
          typeof body === 'object' &&
          !Array.isArray(body) &&
          Array.isArray((body as { items?: unknown }).items)
        ) {
          presentIds = new Set<string>();
          for (const item of (body as { items: unknown[] }).items) {
            if (item && typeof item === 'object') {
              const cid = (item as Record<string, unknown>).content_id;
              if (typeof cid === 'string' && cid) presentIds.add(cid);
            }
          }
        }
      } else {
        await response.body?.cancel().catch(() => undefined);
      }
    } catch {
      // Fail safe: fall back to a sync-only event rather than falsely tombstoning.
      presentIds = null;
    } finally {
      this.removalFlushInFlight = false;
    }

    if (generation !== this.connectGeneration) return;

    if (presentIds === null) {
      this.emit('library:event', { type: 'removed', itemId: null } satisfies SiloLibraryEvent);
    } else {
      let sawStillPresent = false;
      for (const id of batch) {
        if (presentIds.has(id)) {
          sawStillPresent = true;
        } else {
          this.emit('library:event', { type: 'removed', itemId: id } satisfies SiloLibraryEvent);
        }
      }
      if (sawStillPresent) {
        this.emit('library:event', { type: 'removed', itemId: null } satisfies SiloLibraryEvent);
      }
    }

    if (this.pendingRemovals.size > 0 && !this.removalFlushTimer) {
      this.removalFlushTimer = setTimeout(() => {
        this.removalFlushTimer = null;
        void this.flushPendingRemovals(generation);
      }, REMOVAL_BATCH_DELAY_MS);
    }
  }

  private handleClose(code: number, reason: string): void {
    if (this.state === 'disconnected') return;

    const wasStable =
      this.state === 'connected' &&
      this.connectedAt !== null &&
      Date.now() - this.connectedAt.getTime() >= MIN_STABLE_CONNECTION_MS;

    this.clearTimers();
    this.cleanupSocket();

    // 4002 credential_invalid: API key deleted or admin account disabled/deleted.
    // Do not hammer reconnects with the same credential; fall back to polling.
    if (code === 4002) {
      const err = new Error(`Silo WebSocket closed (4002 ${reason || 'credential_invalid'})`);
      this.lastError = err;
      this.emit('connection:error', err);
      console.error(`[SiloWS] ${this.serverName}: ${err.message}`);
      this.enterFallback();
      return;
    }

    // 4001 access_changed & 4003 lifetime_ended (4h max connection lifetime):
    // mint a fresh ticket and reconnect immediately (guarding against tight loops if unstable).
    if (code === 4001 || code === 4003 || this.pendingAccessChange) {
      this.pendingAccessChange = false;
      if (wasStable) {
        console.log(
          `[SiloWS] ${this.serverName}: rotating connection (close ${code}${reason ? ` ${reason}` : ''})`
        );
        this.reconnectAttempts = 0;
        this.setState('reconnecting');
        this.reconnectTimer = setTimeout(() => {
          if (this.state === 'disconnected') return;
          void this.connect();
        }, IMMEDIATE_RECONNECT_DELAY_MS);
        return;
      }
    }

    // 4004 authority_unavailable, 1006 abnormal closure, etc.: reconnect with exponential backoff
    const err = new Error(`Silo WebSocket closed (${code}${reason ? `: ${reason}` : ''})`);
    this.lastError = err;
    this.emit('connection:error', err);
    this.scheduleReconnect();
  }

  private enterUnsupported(): void {
    this.clearTimers();
    this.setState('unsupported');
    this.reconnectTimer = setTimeout(() => {
      if (this.state !== 'disconnected') {
        void this.connect();
      }
    }, UNSUPPORTED_REPROBE_MS);
  }

  private enterFallback(): void {
    this.clearTimers();
    this.setState('fallback');
    this.reconnectTimer = setTimeout(() => {
      if (this.state !== 'disconnected') {
        this.reconnectAttempts = 0;
        void this.connect();
      }
    }, FALLBACK_RETRY_MS);
  }

  private scheduleReconnect(minDelayMs?: number): void {
    if (this.reconnectAttempts >= SSE_CONFIG.MAX_RETRIES) {
      console.error(
        `[SiloWS] Max retries reached for ${this.serverName}, falling back to polling, retrying in ${FALLBACK_RETRY_MS / 1000}s`
      );
      this.enterFallback();
      return;
    }

    this.setState('reconnecting');
    this.reconnectAttempts++;

    const baseDelay = Math.min(
      SSE_CONFIG.INITIAL_RETRY_DELAY_MS *
        Math.pow(SSE_CONFIG.RETRY_MULTIPLIER, this.reconnectAttempts - 1),
      SSE_CONFIG.MAX_RETRY_DELAY_MS
    );
    const delay = Math.max(baseDelay + Math.random() * 1000, minDelayMs ?? 0);

    console.log(
      `[SiloWS] Reconnecting to ${this.serverName} in ${Math.round(delay)}ms (attempt ${this.reconnectAttempts}/${SSE_CONFIG.MAX_RETRIES})`
    );

    this.reconnectTimer = setTimeout(() => {
      if (this.state === 'disconnected') return;
      void this.connect();
    }, delay);
  }

  private startHandshakeTimeout(generation: number): void {
    this.clearHandshakeTimeout();
    this.handshakeTimer = setTimeout(() => {
      if (generation !== this.connectGeneration) return;
      console.warn(`[SiloWS] Handshake timeout on ${this.serverName}, reconnecting`);
      this.lastError = new Error('Silo WebSocket handshake timeout');
      this.emit('connection:error', this.lastError);
      this.cleanupSocket();
      this.scheduleReconnect();
    }, HANDSHAKE_TIMEOUT_MS);
  }

  private clearHandshakeTimeout(): void {
    if (this.handshakeTimer) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  private clearTimers(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.stabilityTimer) {
      clearTimeout(this.stabilityTimer);
      this.stabilityTimer = null;
    }
    if (this.removalFlushTimer) {
      clearTimeout(this.removalFlushTimer);
      this.removalFlushTimer = null;
    }
    this.pendingRemovals.clear();
    this.clearHandshakeTimeout();
  }

  private cleanupSocket(): void {
    if (!this.ws) return;
    const ws = this.ws;
    this.ws = null;
    ws.onopen = null;
    ws.onmessage = null;
    ws.onerror = null;
    ws.onclose = null;
    try {
      ws.close(1000, 'client disconnect');
    } catch {
      // Ignore close errors on already-closed sockets
    }
  }

  private setState(state: SSEConnectionState): void {
    if (this.state !== state) {
      this.state = state;
      this.emit('connection:state', state);
    }
  }
}
