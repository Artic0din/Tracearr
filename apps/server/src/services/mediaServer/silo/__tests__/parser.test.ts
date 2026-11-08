import { describe, it, expect } from 'vitest';
import { parseCatalogItem, parseLibrary, parseSession, parseUser } from '../parser.js';

// A row captured from a live Silo /api/v2/admin/sessions response (IP and signature replaced).
const LIVE_ROW = {
  session_id: 'session-1',
  user_id: '1',
  username: 'Ryan',
  profile_id: 'profile-1',
  profile_name: 'Ryan',
  media_file_id: '251',
  requested_media_file_id: '251',
  content_id: 'movie-tmdb-10030',
  media_title: 'Good Luck Chuck',
  media_type: 'movie',
  play_method: 'direct',
  reporting_node: 'node-1',
  file_duration: 6077,
  started_at: '2026-11-08T04:07:04.454Z',
  updated_at: '2026-11-08T04:07:15.438Z',
  position_seconds: 615,
  is_paused: false,
  has_playback_control: false,
  client_ip: '203.0.113.7',
  stream_location: 'local',
  client_name: 'Tracearr Test',
  client_version: '1.0.0',
  client_label: 'Tracearr Test 1.0.0',
  device_id: 'tracearr-silo-test-device',
  device_platform: 'macos',
  audio_track_index: 0,
  transcode_audio: false,
  stream_bitrate_kbps: 10261,
  target_bitrate_kbps: null,
  source_bitrate_kbps: 10261,
  source_video_codec: 'h264',
  source_video_resolution: '1080p',
  source_video_height: 1040,
  source_audio_codec: 'eac3',
  source_audio_channels: 6,
  video_decision: 'direct',
  audio_decision: 'direct',
  effective_play_method: 'direct',
  poster_url: '/api/v2/artwork/tmdb/movies/10030/poster/w300.abc.webp?exp=1794196800&sig=x',
};

describe('Silo parseSession', () => {
  it('maps a live direct-play movie row', () => {
    const s = parseSession(LIVE_ROW);
    expect(s).toMatchObject({
      sessionKey: 'session-1',
      mediaId: 'movie-tmdb-10030',
      serverVersionKey: '251',
      user: { id: '1', username: 'Ryan' },
      media: {
        title: 'Good Luck Chuck',
        type: 'movie',
        durationMs: 6_077_000,
        thumbPath: LIVE_ROW.poster_url,
      },
      playback: { state: 'playing', positionMs: 615_000 },
      player: {
        name: 'Tracearr Test 1.0.0',
        deviceId: 'tracearr-silo-test-device',
        product: 'Tracearr Test',
        platform: 'macos',
      },
      network: { ipAddress: '203.0.113.7', isLocal: true },
      quality: {
        bitrate: 10261,
        isTranscode: false,
        videoDecision: 'directplay',
        audioDecision: 'directplay',
        videoResolution: '1080p',
        videoHeight: 1040,
        sourceVideoCodec: 'h264',
        sourceAudioCodec: 'eac3',
        sourceAudioChannels: 6,
      },
    });
    expect(s?.playback.progressPercent).toBe(10);
    expect(s?.episode).toBeUndefined();
  });

  it('reports a paused transcode at the target resolution', () => {
    const s = parseSession({
      ...LIVE_ROW,
      is_paused: true,
      video_decision: 'transcode',
      effective_play_method: 'transcode',
      target_resolution: '720p',
      target_video_codec: 'hevc',
      transcode_audio: true,
      target_audio_codec: 'aac',
    });
    expect(s?.playback.state).toBe('paused');
    expect(s?.quality).toMatchObject({
      isTranscode: true,
      videoDecision: 'transcode',
      audioDecision: 'transcode',
      videoResolution: '720p',
      videoHeight: undefined,
      streamVideoCodec: 'hevc',
      streamAudioCodec: 'aac',
    });
  });

  it('treats remux as a copy of the video', () => {
    const s = parseSession({ ...LIVE_ROW, video_decision: 'remux', audio_decision: 'direct' });
    expect(s?.quality.videoDecision).toBe('copy');
    expect(s?.quality.isTranscode).toBe(false);
  });

  it('keeps season 0 and splits series from episode name', () => {
    const s = parseSession({
      ...LIVE_ROW,
      media_type: 'episode',
      media_title: 'The Show',
      series_name: 'The Show',
      episode_name: 'Pilot',
      season_number: 0,
      episode_number: 1,
    });
    expect(s?.media.title).toBe('Pilot');
    expect(s?.episode).toEqual({ showTitle: 'The Show', seasonNumber: 0, episodeNumber: 1 });
  });

  it('drops a row without a session or user id', () => {
    expect(parseSession({ ...LIVE_ROW, session_id: '' })).toBeNull();
    expect(parseSession({ ...LIVE_ROW, user_id: undefined })).toBeNull();
  });

  it('falls back to the session id for the device when none was declared', () => {
    const s = parseSession({ ...LIVE_ROW, device_id: undefined });
    expect(s?.player.deviceId).toBe(LIVE_ROW.session_id);
  });
});

describe('Silo parseUser', () => {
  it('maps role, enabled and the library scope inherited from the group', () => {
    expect(
      parseUser({
        id: '2',
        username: 'kid',
        email: '',
        role: 'user',
        enabled: false,
        library_ids: null,
        effective_policy: { library_ids: ['1'] },
        created_at: '2026-10-01T00:00:00Z',
        last_active_at: null,
      })
    ).toEqual({
      id: '2',
      username: 'kid',
      email: undefined,
      isAdmin: false,
      isDisabled: true,
      sharedLibraries: ['1'],
      lastActivityAt: undefined,
      joinedAt: new Date('2026-10-01T00:00:00Z'),
    });
  });

  it('reads a null effective library list as access to every library', () => {
    expect(
      parseUser({
        id: '1',
        role: 'admin',
        library_ids: ['2'],
        effective_policy: { library_ids: null },
      })?.sharedLibraries
    ).toBeUndefined();
  });
});

describe('Silo parseLibrary', () => {
  it('maps series libraries onto the tvshows type the sync knows', () => {
    expect(parseLibrary({ id: '2', name: 'TV Shows', type: 'series', paths: ['/mnt/tv'] })).toEqual(
      {
        id: '2',
        name: 'TV Shows',
        type: 'tvshows',
        locations: ['/mnt/tv'],
      }
    );
    expect(parseLibrary({ id: '1', name: 'Movies', type: 'movies', paths: [] })?.type).toBe(
      'movies'
    );
  });
});

describe('Silo parseCatalogItem', () => {
  it('maps a movie with its file version and external ids', () => {
    const item = parseCatalogItem({
      content_id: 'movie-tmdb-10030',
      type: 'movie',
      title: 'Good Luck Chuck',
      year: 2007,
      imdb_id: 'tt0452625',
      tmdb_id: '10030',
      added_at: '2026-10-07T11:50:12.052Z',
      genres: ['Comedy'],
      versions: [
        {
          file_id: '251',
          resolution: '1080p',
          codec_video: 'h264',
          dynamic_range: 'sdr',
          codec_audio: 'eac3',
          audio_channels: 6,
          atmos: false,
          container: 'mkv',
          bitrate_kbps: 10261,
          file_size: 7794687416,
        },
      ],
    });
    expect(item).toMatchObject({
      ratingKey: 'movie-tmdb-10030',
      mediaType: 'movie',
      year: 2007,
      imdbId: 'tt0452625',
      tmdbId: 10030,
      videoResolution: '1080p',
      fileSize: 7794687416,
      genres: ['Comedy'],
    });
    expect(item?.versions?.[0]).toMatchObject({ serverVersionKey: '251', partCount: 1 });
    expect(item?.addedAt).toEqual(new Date('2026-10-07T11:50:12.052Z'));
  });

  it('links an episode to its series', () => {
    expect(
      parseCatalogItem({
        content_id: 'ep-1',
        type: 'episode',
        title: 'Pilot',
        series_id: 'series-1',
        series_title: 'The Show',
        season_number: 1,
        episode_number: 1,
        added_at: '2026-10-07T00:00:00Z',
        versions: [],
      })
    ).toMatchObject({
      mediaType: 'episode',
      grandparentRatingKey: 'series-1',
      grandparentTitle: 'The Show',
      parentIndex: 1,
      itemIndex: 1,
    });
  });

  it('skips types the library sync does not store', () => {
    expect(parseCatalogItem({ content_id: 'x', type: 'book', versions: [] })).toBeNull();
  });
});
