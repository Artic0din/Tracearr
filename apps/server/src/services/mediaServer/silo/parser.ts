/**
 * Silo native API (/api/v2) response parsers
 *
 * Silo's Jellyfin-compatible /Sessions only lists the caller's own plays, so Tracearr
 * reads Silo through its native admin API instead.
 */

import type { MediaLibrary, MediaLibraryItem, MediaSession, MediaUser } from '../types.js';
import { calculateProgress } from '../shared/parserUtils.js';

type Row = Record<string, unknown>;

function str(row: Row, key: string): string | undefined {
  const value = row[key];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function num(row: Row, key: string): number | undefined {
  const value = row[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function date(row: Row, key: string): Date | undefined {
  const raw = str(row, key);
  if (!raw) return undefined;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/** Items of a `{items, page}` envelope; anything else is an empty page. */
export function pageItems(data: unknown): Row[] {
  const items = (data as { items?: unknown } | null)?.items;
  return Array.isArray(items) ? items.filter((i): i is Row => !!i && typeof i === 'object') : [];
}

export function nextCursor(data: unknown): string | undefined {
  const page = (data as { page?: { has_more?: unknown; next_cursor?: unknown } } | null)?.page;
  return page?.has_more === true && typeof page.next_cursor === 'string' && page.next_cursor
    ? page.next_cursor
    : undefined;
}

/** Silo decision words onto Tracearr's directplay / copy / transcode. */
function decision(value: string | undefined): string {
  switch (value) {
    case 'transcode':
      return 'transcode';
    case 'remux':
    case 'copy':
    case 'direct_stream':
      return 'copy';
    default:
      return 'directplay';
  }
}

function mediaType(value: string | undefined): MediaSession['media']['type'] {
  switch (value) {
    case 'movie':
      return 'movie';
    case 'episode':
      return 'episode';
    case 'track':
    case 'audio':
      return 'track';
    default:
      return 'unknown';
  }
}

export function parseSession(row: Row): MediaSession | null {
  const sessionKey = str(row, 'session_id');
  const userId = str(row, 'user_id');
  if (!sessionKey || !userId) return null;

  const playMethod = str(row, 'effective_play_method') ?? str(row, 'play_method');
  const videoDecision = decision(str(row, 'video_decision') ?? playMethod);
  const audioDecision =
    row.transcode_audio === true ? 'transcode' : decision(str(row, 'audio_decision') ?? playMethod);
  const isTranscode = videoDecision === 'transcode' || audioDecision === 'transcode';

  const durationMs = Math.round((num(row, 'file_duration') ?? 0) * 1000);
  const positionMs = Math.round((num(row, 'position_seconds') ?? 0) * 1000);
  const type = mediaType(str(row, 'media_type'));
  const deviceId = str(row, 'device_id') ?? sessionKey;
  const clientName = str(row, 'client_name');
  const sourceHeight = num(row, 'source_video_height');

  const session: MediaSession = {
    sessionKey,
    mediaId: str(row, 'content_id') ?? str(row, 'media_file_id') ?? sessionKey,
    serverVersionKey: str(row, 'media_file_id'),
    user: { id: userId, username: str(row, 'username') ?? userId },
    media: {
      title: str(row, 'media_title') ?? 'Unknown',
      type,
      durationMs,
      thumbPath: str(row, 'poster_url'),
    },
    playback: {
      state: row.is_paused === true ? 'paused' : 'playing',
      positionMs,
      progressPercent: calculateProgress(positionMs, durationMs),
    },
    player: {
      name: str(row, 'client_label') ?? clientName ?? 'Silo',
      deviceId,
      product: clientName,
      platform: str(row, 'device_platform'),
    },
    network: {
      ipAddress: str(row, 'client_ip') ?? '',
      isLocal: str(row, 'stream_location') === 'local',
    },
    quality: {
      bitrate: num(row, 'stream_bitrate_kbps') ?? num(row, 'source_bitrate_kbps') ?? 0,
      isTranscode,
      videoDecision,
      audioDecision,
      videoResolution: isTranscode
        ? (str(row, 'target_resolution') ?? str(row, 'source_video_resolution'))
        : str(row, 'source_video_resolution'),
      videoHeight: isTranscode ? undefined : sourceHeight,
      sourceVideoCodec: str(row, 'source_video_codec'),
      sourceAudioCodec: str(row, 'source_audio_codec'),
      sourceAudioChannels: num(row, 'source_audio_channels'),
      streamVideoCodec: str(row, 'target_video_codec') ?? str(row, 'source_video_codec'),
      streamAudioCodec: str(row, 'target_audio_codec') ?? str(row, 'source_audio_codec'),
    },
  };

  if (type === 'episode') {
    session.episode = {
      showTitle: str(row, 'series_name') ?? session.media.title,
      seasonNumber: num(row, 'season_number') ?? null,
      episodeNumber: num(row, 'episode_number') ?? null,
    };
    // Silo puts the episode's own name in episode_name and the series in media_title.
    session.media.title = str(row, 'episode_name') ?? session.media.title;
  }

  return session;
}

export function parseUser(row: Row): MediaUser | null {
  const id = str(row, 'id');
  if (!id) return null;
  // The top-level list is only the account's own override; the effective one includes its group.
  const policy = row.effective_policy as Row | null | undefined;
  const libraryIds = policy?.library_ids;
  return {
    id,
    username: str(row, 'username') ?? id,
    email: str(row, 'email'),
    isAdmin: row.role === 'admin',
    isDisabled: row.enabled === false,
    sharedLibraries: Array.isArray(libraryIds)
      ? libraryIds.filter((l): l is string => typeof l === 'string')
      : undefined,
    lastActivityAt: date(row, 'last_active_at'),
    joinedAt: date(row, 'created_at'),
  };
}

/** Silo library types onto the Jellyfin collection words the library sync already knows. */
const LIBRARY_TYPES: Record<string, string> = { movies: 'movies', series: 'tvshows' };

export function parseLibrary(row: Row): MediaLibrary | null {
  const id = str(row, 'id');
  if (!id) return null;
  const type = str(row, 'type') ?? 'unknown';
  const paths = row.paths;
  return {
    id,
    name: str(row, 'name') ?? id,
    type: LIBRARY_TYPES[type] ?? type,
    locations: Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : [],
  };
}

const ITEM_TYPES: Record<string, MediaLibraryItem['mediaType']> = {
  movie: 'movie',
  series: 'show',
  episode: 'episode',
};

export function parseCatalogItem(row: Row): MediaLibraryItem | null {
  const ratingKey = str(row, 'content_id');
  const mediaType = ITEM_TYPES[str(row, 'type') ?? ''];
  if (!ratingKey || !mediaType) return null;

  const versions = (Array.isArray(row.versions) ? row.versions : []).filter(
    (v): v is Row => !!v && typeof v === 'object'
  );
  const first = versions[0];
  const tmdb = Number(str(row, 'tmdb_id'));
  const tvdb = Number(str(row, 'tvdb_id'));
  const genres = row.genres;

  return {
    ratingKey,
    title: str(row, 'title') ?? ratingKey,
    mediaType,
    year: num(row, 'year'),
    addedAt: date(row, 'added_at') ?? new Date(0),
    videoResolution: first ? str(first, 'resolution') : undefined,
    videoCodec: first ? str(first, 'codec_video') : undefined,
    videoDynamicRange: first ? str(first, 'dynamic_range') : undefined,
    audioCodec: first ? str(first, 'codec_audio') : undefined,
    audioChannels: first ? num(first, 'audio_channels') : undefined,
    fileSize: first ? num(first, 'file_size') : undefined,
    container: first ? str(first, 'container') : undefined,
    versions: versions.map((v) => ({
      serverVersionKey: str(v, 'file_id') ?? '',
      videoResolution: str(v, 'resolution'),
      videoCodec: str(v, 'codec_video'),
      videoDynamicRange: str(v, 'dynamic_range'),
      audioCodec: str(v, 'codec_audio'),
      audioChannels: num(v, 'audio_channels'),
      audioAtmos: v.atmos === true,
      container: str(v, 'container'),
      bitrate: num(v, 'bitrate_kbps'),
      fileSize: num(v, 'file_size'),
      partCount: 1,
    })),
    imdbId: str(row, 'imdb_id'),
    tmdbId: Number.isInteger(tmdb) && tmdb > 0 ? tmdb : undefined,
    tvdbId: Number.isInteger(tvdb) && tvdb > 0 ? tvdb : undefined,
    genres: Array.isArray(genres)
      ? genres.filter((g): g is string => typeof g === 'string')
      : undefined,
    grandparentTitle: str(row, 'series_title'),
    grandparentRatingKey: str(row, 'series_id'),
    parentIndex: num(row, 'season_number'),
    itemIndex: num(row, 'episode_number'),
  };
}
