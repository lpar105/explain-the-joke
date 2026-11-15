const BUNNY_STREAM_BASE_URL = "https://video.bunnycdn.com";

type BunnyStreamVideo = {
  encodeProgress?: number | null;
  guid?: string | null;
  status?: number | null;
};

type BunnyStreamPlayData = {
  fallbackUrl?: string | null;
  isPlayable?: boolean | null;
  isPlaylistPlayable?: boolean | null;
  video?: BunnyStreamVideo | null;
  videoPlaylistUrl?: string | null;
};

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} in the Convex environment.`);
  }

  return value;
}

export function getBunnyStreamLibraryId() {
  return requireEnv("BUNNY_STREAM_LIBRARY_ID");
}

export function getBunnyStreamApiKey() {
  return requireEnv("BUNNY_STREAM_API_KEY");
}

export function getBunnyStreamVideoApiUrl(videoId?: string) {
  const libraryId = getBunnyStreamLibraryId();
  if (!videoId) {
    return `${BUNNY_STREAM_BASE_URL}/library/${libraryId}/videos`;
  }

  return `${BUNNY_STREAM_BASE_URL}/library/${libraryId}/videos/${videoId}`;
}

export function getBunnyStreamPlayDataUrl(videoId: string) {
  const libraryId = getBunnyStreamLibraryId();
  return `${BUNNY_STREAM_BASE_URL}/library/${libraryId}/videos/${videoId}/play`;
}

export function getBunnyStreamRequestHeaders() {
  return {
    AccessKey: getBunnyStreamApiKey(),
  };
}

export function getBunnyStreamPlaybackUrl(
  playData: BunnyStreamPlayData,
): string | null {
  const playlistUrl = playData.videoPlaylistUrl?.trim();
  if (playData.isPlaylistPlayable && playlistUrl) {
    return playlistUrl;
  }

  const fallbackUrl = playData.fallbackUrl?.trim();
  if (playData.isPlayable && fallbackUrl) {
    return fallbackUrl;
  }

  return null;
}

export function isBunnyStreamReady(playData: BunnyStreamPlayData) {
  return getBunnyStreamPlaybackUrl(playData) !== null;
}
