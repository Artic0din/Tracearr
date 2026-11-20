/**
 * Silo native API (/api/v2) response parsers
 *
 * Silo's Jellyfin-compatible /Sessions only lists the caller's own plays, so Tracearr
 * reads Silo through its native admin API instead.
 */

import {
  normalizeDynamicRange,
  type SourceAudioDetails,
  type StreamAudioDetails,
  type SubtitleInfo,
  type TranscodeInfo,
} from '@tracearr/shared';
import type {
  MediaItemVersion,
  MediaLibrary,
  MediaLibraryItem,
  MediaSession,
  MediaUser,
  MediaWatchHistoryItem,
} from '../types.js';
import { calculateProgress } from '../shared/parserUtils.js';
import {
  computeVersionsFingerprint,
  pickBestVersion,
  sumVersionSizes,
} from '../shared/versionUtils.js';

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

/** Codec string, ignoring FFmpeg/Silo's sentinel `"copy"` on remux streams. */
function targetCodec(row: Row, key: string): string | undefined {
  const value = str(row, key);
  return value && value.toLowerCase() !== 'copy' ? value : undefined;
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
    case 'audiobook':
    case 'podcast_episode':
      return 'track';
    default:
      return 'unknown';
  }
}

/** Map Silo's `AdminCatalogItemVersion.dynamic_range` enum onto Tracearr's tokens. */
const DYNAMIC_RANGE_MAP: Record<string, string> = {
  sdr: 'sdr',
  hdr10: 'hdr10',
  hdr10_plus: 'hdr10+',
  hlg: 'hlg',
  dolby_vision: 'dolby vision',
  hdr_unknown: 'hdr',
};

export function mapDynamicRange(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const mapped = DYNAMIC_RANGE_MAP[value.toLowerCase().trim()];
  if (mapped) return mapped;
  return normalizeDynamicRange(value) ?? undefined;
}

function parseSubtitleInfo(raw: unknown): SubtitleInfo | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const sub = raw as Row;
  const info: SubtitleInfo = {};
  const codec = str(sub, 'codec') ?? str(sub, 'format');
  if (codec) info.codec = codec.toUpperCase();
  const language = str(sub, 'language');
  if (language) info.language = language;
  if (sub.forced === true) info.forced = true;

  switch (str(sub, 'delivery')) {
    case 'burn_in':
      info.decision = 'burn';
      break;
    case 'embedded':
    case 'hls_rendition':
    case 'sidecar':
      info.decision = 'copy';
      break;
  }

  return Object.keys(info).length > 0 ? info : undefined;
}

function parseTranscodeInfo(row: Row): TranscodeInfo | undefined {
  const info: TranscodeInfo = {};
  const sourceContainer = str(row, 'source_container');
  const outputContainer = str(row, 'output_container');
  if (sourceContainer) info.sourceContainer = sourceContainer.toUpperCase();
  if (outputContainer) info.streamContainer = outputContainer.toUpperCase();
  if (sourceContainer && outputContainer) {
    info.containerDecision =
      sourceContainer.toLowerCase() === outputContainer.toLowerCase() ? 'direct' : 'transcode';
  }

  const hwAccel = str(row, 'transcode_hw_accel');
  if (hwAccel && hwAccel.toLowerCase() !== 'none' && hwAccel.toLowerCase() !== 'software') {
    info.hwRequested = true;
    info.hwEncoding = hwAccel;
  }

  if (Array.isArray(row.adaptation_reasons)) {
    const reasons = row.adaptation_reasons
      .filter((r): r is string => typeof r === 'string' && r.trim() !== '')
      .map((r) => r.trim());
    if (reasons.length > 0) {
      info.reasons = Array.from(new Set(reasons));
    }
  }

  return Object.keys(info).length > 0 ? info : undefined;
}

export function parseSession(row: Row): MediaSession | null {
  const sessionKey = str(row, 'session_id');
  const userId = str(row, 'user_id');
  if (!sessionKey || !userId) return null;

  const playMethod = str(row, 'effective_play_method') ?? str(row, 'play_method');
  const videoDecision = decision(str(row, 'video_decision') ?? playMethod);
  const audioDecision =
    row.transcode_audio === true ? 'transcode' : decision(str(row, 'audio_decision') ?? playMethod);
  const isVideoTranscode = videoDecision === 'transcode';
  const isTranscode = isVideoTranscode || audioDecision === 'transcode';

  const durationMs = Math.round((num(row, 'file_duration') ?? 0) * 1000);
  const positionMs = Math.round((num(row, 'position_seconds') ?? 0) * 1000);
  const type = mediaType(str(row, 'media_type'));
  const deviceId = str(row, 'device_id') ?? sessionKey;
  const clientName = str(row, 'client_name');
  const sourceHeight = num(row, 'source_video_height');

  // Upstream AdminPlaybackSession reports source_video_resolution as the width-aware
  // size class (e.g. 3840x1600 -> "2160p") without source_video_width. Passing
  // videoHeight alone triggers pixels-first classification and downgrades widescreen
  // direct plays (4K -> 1440p, 1080p -> 720p), so only use sourceHeight when no
  // resolution label is present.
  const videoResolution = isVideoTranscode
    ? (str(row, 'target_resolution') ?? str(row, 'source_video_resolution'))
    : str(row, 'source_video_resolution');

  const sourceAudioDetails: SourceAudioDetails = {};
  const audioLayout = str(row, 'source_audio_layout');
  const audioLanguage = str(row, 'source_audio_language');
  if (audioLayout) sourceAudioDetails.channelLayout = audioLayout;
  if (audioLanguage) sourceAudioDetails.language = audioLanguage;

  const streamAudioDetails: StreamAudioDetails = {};
  const targetAudioChannels = num(row, 'target_audio_channels');
  if (targetAudioChannels !== undefined) streamAudioDetails.channels = targetAudioChannels;

  const transcodeInfo = parseTranscodeInfo(row);
  const subtitleInfo = parseSubtitleInfo(row.subtitle);

  // Upstream renamed content_id -> media_item_id on AdminPlaybackSession; keep
  // content_id as a fallback for older pre-1.0 builds.
  const mediaId =
    str(row, 'media_item_id') ?? str(row, 'content_id') ?? str(row, 'media_file_id') ?? sessionKey;

  const session: MediaSession = {
    sessionKey,
    mediaId,
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
      videoResolution,
      videoHeight: !videoResolution && !isVideoTranscode ? sourceHeight : undefined,
      sourceVideoCodec: str(row, 'source_video_codec'),
      sourceAudioCodec: str(row, 'source_audio_codec'),
      sourceAudioChannels: num(row, 'source_audio_channels'),
      sourceAudioDetails:
        Object.keys(sourceAudioDetails).length > 0 ? sourceAudioDetails : undefined,
      streamVideoCodec: targetCodec(row, 'target_video_codec') ?? str(row, 'source_video_codec'),
      streamAudioCodec: targetCodec(row, 'target_audio_codec') ?? str(row, 'source_audio_codec'),
      streamAudioDetails:
        Object.keys(streamAudioDetails).length > 0 ? streamAudioDetails : undefined,
      transcodeInfo,
      subtitleInfo,
    },
  };

  if (type === 'episode') {
    // Upstream puts the episode title in media_title and the show title in series_title;
    // older pre-1.0 builds used series_name + episode_name.
    session.episode = {
      showTitle: str(row, 'series_title') ?? str(row, 'series_name') ?? session.media.title,
      seasonNumber: num(row, 'season_number') ?? null,
      episodeNumber: num(row, 'episode_number') ?? null,
    };
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

/**
 * Silo library kinds (internal/librarykind) onto the collection words library sync knows.
 * Non-video kinds (audiobooks, ebooks, podcasts, manga) stay normalized so librarySync skips them.
 */
const LIBRARY_TYPES: Record<string, string> = {
  movie: 'movies',
  movies: 'movies',
  series: 'tvshows',
  tv: 'tvshows',
  show: 'tvshows',
  tvshows: 'tvshows',
  mixed: 'mixed',
};

export function parseLibrary(row: Row): MediaLibrary | null {
  const id = str(row, 'id');
  if (!id) return null;
  // Disabled libraries are omitted by /admin/catalog/items; syncing them would
  // return 0 items and tombstone their previously synced catalog.
  if (row.enabled === false) return null;
  const rawType = (str(row, 'type') ?? 'unknown').trim().toLowerCase();
  const paths = row.paths;
  return {
    id,
    name: str(row, 'name') ?? id,
    type: LIBRARY_TYPES[rawType] ?? rawType,
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
  const itemMediaType = ITEM_TYPES[str(row, 'type') ?? ''];
  if (!ratingKey || !itemMediaType) return null;

  // Preserve the complete version set across enabled libraries: library_items is keyed
  // uniquely on (server_id, rating_key), so dropping versions belonging to another library
  // would cause the last-synced library to overwrite the row and falsely tombstone valid files.
  const rawVersions = (Array.isArray(row.versions) ? row.versions : []).filter(
    (v): v is Row => !!v && typeof v === 'object'
  );

  const versions: MediaItemVersion[] = rawVersions.map((v) => ({
    serverVersionKey: str(v, 'file_id') ?? '',
    videoResolution: str(v, 'resolution'),
    videoCodec: str(v, 'codec_video'),
    videoDynamicRange: mapDynamicRange(str(v, 'dynamic_range')),
    audioCodec: str(v, 'codec_audio'),
    audioChannels: num(v, 'audio_channels'),
    audioAtmos: v.atmos === true,
    editionTitle: str(v, 'edition'),
    container: str(v, 'container'),
    bitrate: num(v, 'bitrate_kbps'),
    fileSize: num(v, 'file_size'),
    partCount: 1,
    filePath: str(v, 'file_path'),
  }));

  const best = pickBestVersion(versions);
  const tmdb = Number(str(row, 'tmdb_id'));
  const tvdb = Number(str(row, 'tvdb_id'));
  const genres = row.genres;

  return {
    ratingKey,
    title: str(row, 'title') ?? ratingKey,
    mediaType: itemMediaType,
    year: num(row, 'year'),
    addedAt: date(row, 'added_at') ?? new Date(0),
    videoResolution: best?.videoResolution,
    videoCodec: best?.videoCodec,
    videoDynamicRange: best?.videoDynamicRange,
    audioCodec: best?.audioCodec,
    audioChannels: best?.audioChannels,
    fileSize: sumVersionSizes(versions),
    container: best?.container,
    versions,
    versionsFingerprint: versions.length > 0 ? computeVersionsFingerprint(versions) : undefined,
    imdbId: str(row, 'imdb_id'),
    tmdbId: Number.isInteger(tmdb) && tmdb > 0 ? tmdb : undefined,
    tvdbId: Number.isInteger(tvdb) && tvdb > 0 ? tvdb : undefined,
    genres: Array.isArray(genres)
      ? genres.filter((g): g is string => typeof g === 'string')
      : undefined,
    thumbPath: str(row, 'poster_url'),
    grandparentTitle: str(row, 'series_title'),
    grandparentRatingKey: str(row, 'series_id'),
    parentIndex: num(row, 'season_number'),
    itemIndex: num(row, 'episode_number'),
  };
}

export function parseWatchHistoryEntry(row: Row): MediaWatchHistoryItem | null {
  const mediaId = str(row, 'media_item_id') ?? str(row, 'media_file_id');
  const watchedAt = str(row, 'ended_at') ?? str(row, 'started_at');
  if (!mediaId || !watchedAt) return null;

  const type = mediaType(str(row, 'media_type'));
  const title = str(row, 'media_title') ?? mediaId;
  const entry: MediaWatchHistoryItem = {
    mediaId,
    title,
    type,
    watchedAt,
    userId: str(row, 'user_id'),
  };

  if (type === 'episode') {
    entry.episode = {
      showTitle: str(row, 'series_title') ?? title,
      seasonNumber: num(row, 'season_number'),
      episodeNumber: num(row, 'episode_number'),
    };
  }

  return entry;
}
