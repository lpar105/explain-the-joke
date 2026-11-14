"use client";

import Hls from "hls.js";
import { useCallback, useEffect, useRef, useState } from "react";
import { clampTime, getPlaybackWindowForSource } from "../lib/trim-range";

export type PlaybackSource = {
  _id: string;
  provider: "mux" | "bunny";
  playbackUrl: string;
  playbackMode: "direct" | "hls";
};

type MediaStatus = "loading" | "ready" | "buffering" | "error";

export function useSetPlayback(
  source: PlaybackSource | null | undefined,
  trimStart: number,
  trimEnd: number,
  initialTime = 0,
) {
  const mediaElement = useRef<HTMLMediaElement | null>(null);
  const [attachedNode, setAttachedNode] = useState<HTMLMediaElement | null>(null);
  const attachMedia = useCallback((node: HTMLMediaElement | null) => {
    mediaElement.current = node;
    setAttachedNode(node);
  }, []);
  const position = useRef(initialTime);
  const wantsPlay = useRef(false);
  const [hasPlayedSource, setHasPlayedSource] = useState(false);
  const [currentTime, setCurrentTime] = useState(initialTime);
  const [playing, setPlaying] = useState(false);
  const [retry, setRetry] = useState(0);
  const [media, setMedia] = useState<{ key: string; status: MediaStatus; canSeek: boolean }>();
  const window = getPlaybackWindowForSource(source?.provider ?? null, trimStart, trimEnd);
  const duration = Math.max(0, trimEnd - trimStart);
  const url = source?.playbackUrl;
  const mode = source?.playbackMode;
  const key = `${source?._id ?? ""}/${url ?? ""}/${retry}`;
  const active = media?.key === key ? media : undefined;
  const canSeek = Boolean(url && active?.canSeek && active.status !== "error");
  const start = window.startSeconds;
  const end = window.endSeconds;

  useEffect(() => {
    const element = mediaElement.current;
    if (!element || element !== attachedNode || !url) return;

    let hls: Hls | undefined;
    let restored = false;
    let playable = false;
    let failed = false;
    let disposed = false;
    const update = (status: MediaStatus) => setMedia({ key, status, canSeek: playable });
    const fail = () => {
      failed = true;
      element.pause();
      update("error");
    };
    const resume = () => {
      void element.play().catch((error: DOMException) => {
        if (disposed || failed || !wantsPlay.current || error.name === "AbortError") return;
        wantsPlay.current = false;
        setPlaying(false);
      });
    };

    const onMetadata = () => {
      if (failed || restored) return;
      const target = clampTime(start + position.current, start, end);
      element.currentTime = target;
      restored = true;
    };
    const onCanPlay = () => {
      if (failed) return;
      onMetadata();
      const first = !playable;
      playable = true;
      setHasPlayedSource(true);
      update("ready");
      if (first && wantsPlay.current) resume();
    };
    const onWaiting = () => {
      if (playable && !failed && (wantsPlay.current || element.seeking)) update("buffering");
    };
    const onTimeUpdate = () => {
      if (!restored || !playable || failed || element.seeking) return;
      if (element.currentTime >= end && wantsPlay.current) {
        element.currentTime = start;
        if (element.paused) resume();
      }
      position.current = clampTime(element.currentTime - start, 0, duration);
      setCurrentTime(position.current);
    };
    const onPlaying = () => { if (!failed) update("ready"); };
    const onEnded = () => {
      if (!playable || failed || !wantsPlay.current) return;
      element.currentTime = start;
      resume();
    };

    element.addEventListener("loadedmetadata", onMetadata);
    element.addEventListener("canplay", onCanPlay);
    element.addEventListener("waiting", onWaiting);
    element.addEventListener("playing", onPlaying);
    element.addEventListener("timeupdate", onTimeUpdate);
    element.addEventListener("ended", onEnded);
    element.addEventListener("error", fail);
    if (mode === "hls" && !element.canPlayType("application/vnd.apple.mpegurl") && Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, lowLatencyMode: true });
      hls.on(Hls.Events.ERROR, (_, error) => { if (error.fatal) fail(); });
      hls.attachMedia(element);
      hls.loadSource(url);
    } else {
      element.src = url;
      element.load();
    }

    return () => {
      disposed = true;
      element.removeEventListener("loadedmetadata", onMetadata);
      element.removeEventListener("canplay", onCanPlay);
      element.removeEventListener("waiting", onWaiting);
      element.removeEventListener("playing", onPlaying);
      element.removeEventListener("timeupdate", onTimeUpdate);
      element.removeEventListener("ended", onEnded);
      element.removeEventListener("error", fail);
      hls?.destroy();
      element.removeAttribute("src");
      element.load();
    };
  }, [attachedNode, key, url, mode, start, end, duration]);

  const seek = useCallback((time: number) => {
    if (!mediaElement.current || !canSeek) return;
    const next = clampTime(time, 0, duration);
    position.current = next;
    mediaElement.current.currentTime = start + next;
    setCurrentTime(next);
  }, [canSeek, duration, start]);

  function pausePlayback() {
    wantsPlay.current = false;
    mediaElement.current?.pause();
    setPlaying(false);
  }

  function togglePlayback() {
    const element = mediaElement.current;
    if (!element || !canSeek) return;
    if (wantsPlay.current) {
      pausePlayback();
      return;
    }
    wantsPlay.current = true;
    setPlaying(true);
    if (element.currentTime >= end) seek(0);
    void element.play().catch((error: DOMException) => {
      if (error.name === "AbortError" || element.error) return;
      wantsPlay.current = false;
      setPlaying(false);
    });
  }

  return {
    attachMedia, currentTime, playing, duration, canSeek, hasPlayedSource, seek, togglePlayback, pausePlayback,
    status: active?.status ?? (hasPlayedSource ? "buffering" : "loading"),
    retryPlayback: () => setRetry((attempt) => attempt + 1),
  };
}
