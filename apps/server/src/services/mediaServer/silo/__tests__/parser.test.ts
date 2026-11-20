import { describe, it, expect } from 'vitest';
import {
  parseCatalogItem,
  parseLibrary,
  parseSession,
  parseUser,
  parseWatchHistoryEntry,
} from '../parser.js';

// A row captured from a live Silo /api/v2/admin/sessions response (IP and signature replaced).
const LIVE_ROW = {
  session_id: 'session-1',
  user_id: '1',
  username: 'Ryan',
  profile_id: 'profile-1',
  profile_name: 'Ryan',
  media_file_id: '251',
  requested_media_file_id: '251',
  media_item_id: 'movie-tmdb-10030',
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
  source_audio_layout: '5.1',
  source_audio_language: 'eng',
  source_container: 'mkv',
  output_container: 'mkv',
  video_decision: 'direct',
  audio_decision: 'direct',
  effective_play_method: 'direct',
  poster_url: '/api/v2/artwork/tmdb/movies/10030/poster/w300.abc.webp?exp=1794196800&sig=x',
};

describe('Silo parseSession', () => {
  it('maps a live direct-play movie row without widescreen height downgrade', () => {
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
        videoHeight: undefined,
        sourceVideoCodec: 'h264',
        sourceAudioCodec: 'eac3',
        sourceAudioChannels: 6,
        sourceAudioDetails: { channelLayout: '5.1', language: 'eng' },
        transcodeInfo: {
          sourceContainer: 'MKV',
          streamContainer: 'MKV',
          containerDecision: 'direct',
        },
      },
    });
    expect(s?.playback.progressPercent).toBe(10);
    expect(s?.episode).toBeUndefined();
  });

  it('keeps 4K resolution on widescreen 3840x1600 direct play', () => {
    const s = parseSession({
      ...LIVE_ROW,
      source_video_resolution: '4K',
      source_video_height: 1600,
    });
    expect(s?.quality.videoResolution).toBe('4K');
    expect(s?.quality.videoHeight).toBeUndefined();
  });

  it('uses source_video_height when source_video_resolution is absent', () => {
    const s = parseSession({
      ...LIVE_ROW,
      source_video_resolution: undefined,
      source_video_height: 1080,
    });
    expect(s?.quality.videoResolution).toBeUndefined();
    expect(s?.quality.videoHeight).toBe(1080);
  });

  it('falls back to legacy content_id when media_item_id is absent', () => {
    const { media_item_id: _, ...withoutMediaItemId } = LIVE_ROW;
    const s = parseSession({
      ...withoutMediaItemId,
      content_id: 'movie-legacy-42',
    });
    expect(s?.mediaId).toBe('movie-legacy-42');
  });

  it('reports a paused transcode with hw acceleration, adaptation reasons, and subtitle burn-in', () => {
    const s = parseSession({
      ...LIVE_ROW,
      is_paused: true,
      video_decision: 'transcode',
      effective_play_method: 'transcode',
      target_resolution: '720p',
      target_video_codec: 'hevc',
      transcode_audio: true,
      target_audio_codec: 'aac',
      target_audio_channels: 2,
      output_container: 'hls',
      transcode_hw_accel: 'vaapi',
      adaptation_reasons: ['video_codec_unsupported', 'subtitle_burn_in'],
      subtitle: {
        codec: 'ass',
        language: 'eng',
        forced: true,
        delivery: 'burn_in',
      },
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
      streamAudioDetails: { channels: 2 },
      transcodeInfo: {
        sourceContainer: 'MKV',
        streamContainer: 'HLS',
        containerDecision: 'transcode',
        hwRequested: true,
        hwEncoding: 'vaapi',
        reasons: ['video_codec_unsupported', 'subtitle_burn_in'],
      },
      subtitleInfo: {
        codec: 'ASS',
        language: 'eng',
        forced: true,
        decision: 'burn',
      },
    });
  });

  it('treats remux as video copy and ignores the "copy" sentinel on target codecs', () => {
    const s = parseSession({
      ...LIVE_ROW,
      video_decision: 'remux',
      audio_decision: 'remux',
      target_video_codec: 'copy',
      target_audio_codec: 'copy',
      output_container: 'hls',
      subtitle: {
        codec: 'subrip',
        delivery: 'sidecar',
      },
    });
    expect(s?.quality.videoDecision).toBe('copy');
    expect(s?.quality.audioDecision).toBe('copy');
    expect(s?.quality.isTranscode).toBe(false);
    // Sentinel "copy" falls back to the source codec rather than emitting "copy"
    expect(s?.quality.streamVideoCodec).toBe('h264');
    expect(s?.quality.streamAudioCodec).toBe('eac3');
    expect(s?.quality.transcodeInfo?.containerDecision).toBe('transcode');
    expect(s?.quality.subtitleInfo).toEqual({
      codec: 'SUBRIP',
      decision: 'copy',
    });
  });

  it('maps upstream v2 episode fields (series_title + media_title) and keeps season 0', () => {
    const s = parseSession({
      ...LIVE_ROW,
      media_type: 'episode',
      media_item_id: 'episode-tvdb-99',
      series_title: 'The Show',
      media_title: 'Pilot',
      season_number: 0,
      episode_number: 1,
    });
    expect(s?.mediaId).toBe('episode-tvdb-99');
    expect(s?.media.title).toBe('Pilot');
    expect(s?.episode).toEqual({ showTitle: 'The Show', seasonNumber: 0, episodeNumber: 1 });
  });

  it('still supports legacy series_name + episode_name fallback', () => {
    const s = parseSession({
      ...LIVE_ROW,
      media_type: 'episode',
      media_title: 'The Show',
      series_name: 'The Show',
      episode_name: 'Pilot',
      season_number: 1,
      episode_number: 2,
    });
    expect(s?.media.title).toBe('Pilot');
    expect(s?.episode).toEqual({ showTitle: 'The Show', seasonNumber: 1, episodeNumber: 2 });
  });

  it('maps audiobook and podcast_episode media types to track', () => {
    expect(parseSession({ ...LIVE_ROW, media_type: 'audiobook' })?.media.type).toBe('track');
    expect(parseSession({ ...LIVE_ROW, media_type: 'podcast_episode' })?.media.type).toBe('track');
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
  it('maps Silo librarykind aliases and skips disabled libraries', () => {
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
    expect(parseLibrary({ id: '3', name: 'Films', type: 'movie', paths: [] })?.type).toBe('movies');
    expect(parseLibrary({ id: '4', name: 'Shows', type: 'show', paths: [] })?.type).toBe('tvshows');
    expect(parseLibrary({ id: '5', name: 'TV', type: 'tv', paths: [] })?.type).toBe('tvshows');
    expect(parseLibrary({ id: '6', name: 'Mixed', type: 'mixed', paths: [] })?.type).toBe('mixed');
    expect(parseLibrary({ id: '7', name: 'Books', type: 'ebooks', paths: [] })?.type).toBe(
      'ebooks'
    );
    expect(
      parseLibrary({ id: '8', name: 'Hidden', type: 'movies', enabled: false, paths: [] })
    ).toBeNull();
  });
});

describe('Silo parseCatalogItem', () => {
  it('maps a movie with best version, summed sizes across libraries, edition, poster, and dynamic range', () => {
    const item = parseCatalogItem({
      content_id: 'movie-tmdb-10030',
      type: 'movie',
      title: 'Good Luck Chuck',
      year: 2007,
      imdb_id: 'tt0452625',
      tmdb_id: '10030',
      added_at: '2026-10-07T11:50:12.052Z',
      genres: ['Comedy'],
      poster_url: '/api/v2/item-posters/movie-tmdb-10030?exp=1794196800&sig=abc',
      versions: [
        {
          file_id: '251',
          library_id: '1',
          file_path: '/media/movies/Good Luck Chuck (2007)/movie-1080p.mkv',
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
        {
          file_id: '252',
          library_id: '2',
          file_path: '/media/4k/Good Luck Chuck (2007)/movie-4k.mkv',
          edition: "Director's Cut",
          resolution: '4K',
          codec_video: 'hevc',
          dynamic_range: 'dolby_vision',
          codec_audio: 'truehd',
          audio_channels: 8,
          atmos: true,
          container: 'mkv',
          bitrate_kbps: 48000,
          file_size: 32000000000,
        },
      ],
    });
    expect(item).toMatchObject({
      ratingKey: 'movie-tmdb-10030',
      mediaType: 'movie',
      year: 2007,
      imdbId: 'tt0452625',
      tmdbId: 10030,
      thumbPath: '/api/v2/item-posters/movie-tmdb-10030?exp=1794196800&sig=abc',
      videoResolution: '4K',
      videoCodec: 'hevc',
      videoDynamicRange: 'dolby vision',
      audioCodec: 'truehd',
      audioChannels: 8,
      container: 'mkv',
      fileSize: 39794687416,
      genres: ['Comedy'],
    });
    expect(item?.versions).toHaveLength(2);
    expect(item?.versions?.[1]).toMatchObject({
      serverVersionKey: '252',
      editionTitle: "Director's Cut",
      videoDynamicRange: 'dolby vision',
      bitrate: 48000,
      filePath: '/media/4k/Good Luck Chuck (2007)/movie-4k.mkv',
      partCount: 1,
    });
    expect(item?.versionsFingerprint).toBeTruthy();
    expect(item?.addedAt).toEqual(new Date('2026-10-07T11:50:12.052Z'));
  });

  it('normalizes Silo dynamic_range enum tokens', () => {
    const mk = (dynamic_range: string) =>
      parseCatalogItem({
        content_id: 'm1',
        type: 'movie',
        title: 'M',
        added_at: '2026-10-07T00:00:00Z',
        versions: [{ file_id: '1', resolution: '4K', dynamic_range }],
      })?.videoDynamicRange;

    expect(mk('dolby_vision')).toBe('dolby vision');
    expect(mk('hdr10_plus')).toBe('hdr10+');
    expect(mk('hdr10')).toBe('hdr10');
    expect(mk('hlg')).toBe('hlg');
    expect(mk('hdr_unknown')).toBe('hdr');
    expect(mk('sdr')).toBe('sdr');
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

describe('Silo parseWatchHistoryEntry', () => {
  it('maps a /api/v2/admin/playback-history row', () => {
    const entry = parseWatchHistoryEntry({
      id: 'hist-1',
      user_id: '4',
      username: 'alice',
      media_item_id: 'episode-tvdb-55',
      media_type: 'episode',
      media_title: 'Ozymandias',
      series_title: 'Breaking Bad',
      season_number: 5,
      episode_number: 14,
      started_at: '2026-11-10T20:00:00Z',
      ended_at: '2026-11-10T20:48:00Z',
      duration_watched_seconds: 2820,
      file_duration: 2880,
      client_name: 'Silo Web',
      device_platform: 'web',
    });

    expect(entry).toEqual({
      mediaId: 'episode-tvdb-55',
      title: 'Ozymandias',
      type: 'episode',
      watchedAt: '2026-11-10T20:48:00Z',
      userId: '4',
      episode: {
        showTitle: 'Breaking Bad',
        seasonNumber: 5,
        episodeNumber: 14,
      },
    });
  });
});
