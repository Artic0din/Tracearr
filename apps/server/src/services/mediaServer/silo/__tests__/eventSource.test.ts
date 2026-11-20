import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SiloEventSource, SILO_EVENTS_PROTOCOL, type SiloWebSocketLike } from '../eventSource.js';

class MockWebSocket implements SiloWebSocketLike {
  readyState = 1;
  sent: string[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  onopen: ((ev: unknown) => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onerror: ((ev: unknown) => void) | null = null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null = null;

  constructor(
    public readonly url: string,
    public readonly protocols: string[]
  ) {}

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.closedWith = { code, reason };
    this.readyState = 3;
  }

  receive(frame: unknown): void {
    this.onmessage?.({ data: JSON.stringify(frame) });
  }

  triggerClose(code: number, reason = ''): void {
    this.readyState = 3;
    this.onclose?.({ code, reason });
  }
}

function ticketResponse(ticket = 'tok-123', protocol = SILO_EVENTS_PROTOCOL): Response {
  return new Response(
    JSON.stringify({
      ticket,
      expires_in: 30,
      max_connection_seconds: 14400,
      protocol,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } }
  );
}

describe('SiloEventSource', () => {
  let sockets: MockWebSocket[];
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = [];
    fetchMock = vi.fn<typeof fetch>();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  function makeSource(url = 'https://silo.example.com') {
    return new SiloEventSource({
      serverId: 'silo-1',
      serverName: 'My Silo',
      url,
      token: 'sa_monitor_key',
      fetchFn: fetchMock,
      webSocketFactory: (wsUrl, protocols) => {
        const ws = new MockWebSocket(wsUrl, protocols);
        sockets.push(ws);
        return ws;
      },
    });
  }

  it('mints a ticket without X-Profile-Id, opens WebSocket with subprotocols, subscribes, and dispatches events', async () => {
    fetchMock.mockResolvedValueOnce(ticketResponse('ticket-abc'));
    const source = makeSource('https://silo.example.com/');

    const states: string[] = [];
    const sessionEvents: unknown[] = [];
    const libraryEvents: unknown[] = [];
    source.on('connection:state', (s: string) => states.push(s));
    source.on('session:event', (e: unknown) => sessionEvents.push(e));
    source.on('library:event', (e: unknown) => libraryEvents.push(e));

    await source.connect();

    // Verify ticket mint request
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [mintUrl, mintInit] = fetchMock.mock.calls[0]!;
    expect(mintUrl).toBe('https://silo.example.com/api/v2/events/ws-ticket');
    expect(mintInit?.method).toBe('POST');
    expect(mintInit?.headers).toEqual({
      Authorization: 'Bearer sa_monitor_key',
      Accept: 'application/json',
    });

    // Verify WebSocket URL + exact subprotocols (never token/ticket in URL)
    expect(sockets).toHaveLength(1);
    const ws = sockets[0]!;
    expect(ws.url).toBe('wss://silo.example.com/api/v2/events/ws?channels=sessions,catalog');
    expect(ws.protocols).toEqual(['silo.events.v2', 'silo.ticket.ticket-abc']);

    // Server hello -> client subscribes to intersection of desired & available channels
    ws.receive({
      type: 'hello',
      available_channels: ['sessions', 'catalog', 'downloads'],
      required_action: 'subscribe',
    });
    expect(ws.sent).toEqual([
      JSON.stringify({ type: 'subscribe', channels: ['sessions', 'catalog'] }),
    ]);

    // Server subscribed -> connected + initial reconciliation poll cue
    ws.receive({ type: 'subscribed', channels: ['sessions', 'catalog'] });
    expect(states).toEqual(['connecting', 'connected']);
    expect(sessionEvents).toEqual([{ event: 'subscribed', sessionId: null, state: null }]);

    // Sessions event
    ws.receive({
      type: 'event',
      channel: 'sessions',
      event: 'session.started',
      data: { session_id: 'sess-9', state: 'playing', seq: 1 },
    });
    expect(sessionEvents[1]).toEqual({
      event: 'session.started',
      sessionId: 'sess-9',
      state: 'playing',
    });

    // Catalog item added / removed (confirmed absent server-wide) / library changed
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ items: [], page: { has_more: false } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    );
    ws.receive({
      type: 'event',
      channel: 'catalog',
      event: 'catalog.item.changed',
      data: { library_id: '1', content_id: 'movie-tmdb-949', change: 'added' },
    });
    // Metadata/file edits reconcile on periodic full scan rather than incremental added_after sync
    ws.receive({
      type: 'event',
      channel: 'catalog',
      event: 'catalog.item.changed',
      data: { library_id: '1', content_id: 'movie-tmdb-949', change: 'metadata_updated' },
    });
    ws.receive({
      type: 'event',
      channel: 'catalog',
      event: 'catalog.item.changed',
      data: { library_id: '1', content_id: 'movie-tmdb-949', change: 'files_changed' },
    });
    ws.receive({
      type: 'event',
      channel: 'catalog',
      event: 'catalog.item.changed',
      data: { library_id: '1', content_id: 'movie-tmdb-949', change: 'removed' },
    });
    ws.receive({
      type: 'event',
      channel: 'catalog',
      event: 'catalog.library.changed',
      data: { library_id: '1', reason: 'library_enabled' },
    });
    await vi.waitFor(() => {
      expect(libraryEvents).toHaveLength(3);
    });

    expect(libraryEvents).toEqual([
      { type: 'added', itemId: 'movie-tmdb-949' },
      { type: 'added', itemId: null },
      { type: 'removed', itemId: 'movie-tmdb-949' },
    ]);
    expect(fetchMock).toHaveBeenLastCalledWith(
      'https://silo.example.com/api/v2/admin/catalog/items?content_ids=movie-tmdb-949&limit=1',
      expect.objectContaining({
        method: 'GET',
        headers: {
          Authorization: 'Bearer sa_monitor_key',
          Accept: 'application/json',
        },
      })
    );

    source.disconnect();
    expect(source.getState()).toBe('disconnected');
  });

  it('suppresses global tombstone id on catalog removal when another enabled library still holds the item', async () => {
    fetchMock.mockResolvedValueOnce(ticketResponse('ticket-abc')).mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          items: [{ content_id: 'movie-tmdb-949', library_ids: ['2'] }],
          page: { has_more: false },
        }),
        { status: 200, headers: { 'content-type': 'application/json' } }
      )
    );
    const source = makeSource();
    const libraryEvents: unknown[] = [];
    source.on('library:event', (e: unknown) => libraryEvents.push(e));

    await source.connect();
    const ws = sockets[0]!;
    ws.receive({ type: 'hello', available_channels: ['sessions', 'catalog'] });
    ws.receive({ type: 'subscribed', channels: ['sessions', 'catalog'] });

    ws.receive({
      type: 'event',
      channel: 'catalog',
      event: 'catalog.item.changed',
      data: { library_id: '1', content_id: 'movie-tmdb-949', change: 'removed' },
    });
    await vi.waitFor(() => {
      expect(libraryEvents).toHaveLength(1);
    });

    expect(libraryEvents).toEqual([{ type: 'removed', itemId: null }]);
    source.disconnect();
  });

  it('enters unsupported gracefully on 403 (e.g. unscoped admin key) without emitting connection:error', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ title: 'permission_denied' }), { status: 403 })
    );
    const source = makeSource('http://silo.local:8091');
    const errors: Error[] = [];
    source.on('connection:error', (e: Error) => errors.push(e));

    await source.connect();

    expect(source.getState()).toBe('unsupported');
    expect(errors).toHaveLength(0);
    expect(sockets).toHaveLength(0);

    source.disconnect();
  });

  it('handles close code 4002 (credential_invalid) by entering fallback without fast reconnect', async () => {
    fetchMock.mockResolvedValueOnce(ticketResponse('tok-1'));
    const source = makeSource();
    const errors: Error[] = [];
    source.on('connection:error', (e: Error) => errors.push(e));

    await source.connect();
    const ws = sockets[0]!;
    ws.receive({ type: 'hello', available_channels: ['sessions'] });
    ws.receive({ type: 'subscribed', channels: ['sessions'] });

    ws.triggerClose(4002, 'credential_invalid');

    expect(source.getState()).toBe('fallback');
    expect(errors).toHaveLength(1);
    // Advance 30s — should NOT reconnect immediately
    await vi.advanceTimersByTimeAsync(30_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    source.disconnect();
  });

  it('mints a fresh ticket and reconnects immediately on 4003 (lifetime_ended) after a stable connection', async () => {
    fetchMock
      .mockResolvedValueOnce(ticketResponse('tok-1'))
      .mockResolvedValueOnce(ticketResponse('tok-2'));
    const source = makeSource();

    await source.connect();
    const ws1 = sockets[0]!;
    ws1.receive({ type: 'hello', available_channels: ['sessions'] });
    ws1.receive({ type: 'subscribed', channels: ['sessions'] });

    // Advance past MIN_STABLE_CONNECTION_MS
    vi.advanceTimersByTime(10_000);

    ws1.triggerClose(4003, 'lifetime_ended');
    expect(source.getState()).toBe('reconnecting');

    await vi.advanceTimersByTimeAsync(300);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sockets).toHaveLength(2);
    expect(sockets[1]!.protocols).toEqual(['silo.events.v2', 'silo.ticket.tok-2']);

    source.disconnect();
  });

  it('uses backoff on 4004 (authority_unavailable)', async () => {
    fetchMock
      .mockResolvedValueOnce(ticketResponse('tok-1'))
      .mockResolvedValueOnce(ticketResponse('tok-2'));
    const source = makeSource();
    source.on('connection:error', () => undefined);

    await source.connect();
    sockets[0]!.receive({ type: 'hello', available_channels: ['sessions'] });
    sockets[0]!.receive({ type: 'subscribed', channels: ['sessions'] });

    sockets[0]!.triggerClose(4004, 'authority_unavailable');
    expect(source.getState()).toBe('reconnecting');
    expect(source.getStatus().reconnectAttempts).toBe(1);

    await vi.advanceTimersByTimeAsync(2_500);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    source.disconnect();
  });
});
