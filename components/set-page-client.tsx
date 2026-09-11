"use client";

import Hls from "hls.js";
import { useMemo, useRef, useState, useEffect } from "react";
import { LoaderCircle, Pause, Play } from "lucide-react";
import { useQuery } from "convex/react";
import Link from "next/link";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import type { SetAnalysisData, TranscriptSentence } from "../lib/setAnalysis";
import {
  clampTime,
  getClipDurationSeconds,
  getClipTimeFromSourceTime,
  getPlaybackWindowForSource,
  getSourceTimeFromClipTime,
} from "../lib/trim-range";
import { Button } from "./ui/button";

function formatTime(seconds: number) {
  const safeSeconds = Math.max(0, seconds);
  const minutes = Math.floor(safeSeconds / 60);
  const remainder = Math.floor(safeSeconds % 60);
  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

function formatPreciseTime(seconds: number) {
  return `${Math.max(0, seconds).toFixed(2)}s`;
}

function getIntensityColor(score: number) {
  const clamped = Math.min(1, Math.max(0, score));
  const r = Math.round(180 + clamped * 75);
  const g = Math.round(80 - clamped * 60);
  const b = Math.round(80 - clamped * 60);
  return `rgb(${r},${g},${b})`;
}

function getSelectedLine(
  sentences: TranscriptSentence[],
  currentTime: number,
) {
  if (sentences.length === 0) {
    return null;
  }

  const startedSentences = sentences.filter(
    (sentence) => sentence.start <= currentTime,
  );
  return startedSentences[startedSentences.length - 1] ?? sentences[0];
}

function useHlsPlayback(
  mediaElement: HTMLMediaElement | null,
  src: string | null,
  playbackMode: "direct" | "hls",
) {
  useEffect(() => {
    if (!mediaElement || !src) {
      return;
    }

    if (playbackMode === "direct") {
      mediaElement.src = src;
      mediaElement.load();
      return () => {
        mediaElement.removeAttribute("src");
        mediaElement.load();
      };
    }

    if (mediaElement.canPlayType("application/vnd.apple.mpegurl")) {
      mediaElement.src = src;
      return;
    }

    if (!Hls.isSupported()) {
      mediaElement.src = src;
      return;
    }

    const hls = new Hls({
      enableWorker: true,
      lowLatencyMode: true,
    });

    hls.loadSource(src);
    hls.attachMedia(mediaElement);

    return () => {
      hls.destroy();
      mediaElement.removeAttribute("src");
    };
  }, [mediaElement, playbackMode, src]);
}

function useTrimmedPlaybackWindow(
  mediaElement: HTMLMediaElement | null,
  provider: "mux" | "bunny" | null,
  trimRangeStartSeconds: number,
  trimRangeEndSeconds: number,
  onCurrentTimeChange: (seconds: number) => void,
  onDurationChange: (seconds: number) => void,
) {
  useEffect(() => {
    if (!mediaElement) {
      return;
    }

    const clipDurationSeconds = getClipDurationSeconds(
      trimRangeStartSeconds,
      trimRangeEndSeconds,
    );
    const playbackWindow = getPlaybackWindowForSource(
      provider,
      trimRangeStartSeconds,
      trimRangeEndSeconds,
    );

    const syncCurrentTime = () => {
      const clampedSourceTime = clampTime(
        mediaElement.currentTime,
        playbackWindow.startSeconds,
        playbackWindow.endSeconds,
      );

      if (clampedSourceTime !== mediaElement.currentTime) {
        mediaElement.currentTime = clampedSourceTime;
      }

      onCurrentTimeChange(
        getClipTimeFromSourceTime(
          clampedSourceTime,
          provider,
          trimRangeStartSeconds,
          trimRangeEndSeconds,
        ),
      );
    };

    const syncDuration = () => {
      onDurationChange(clipDurationSeconds);
    };

    const handleLoadedMetadata = () => {
      mediaElement.currentTime = playbackWindow.startSeconds;
      syncDuration();
      syncCurrentTime();
    };

    const handleTimeUpdate = () => {
      if (mediaElement.currentTime >= playbackWindow.endSeconds) {
        mediaElement.currentTime = playbackWindow.startSeconds;
        void mediaElement.play().catch(() => {
          mediaElement.pause();
        });
      }

      syncCurrentTime();
    };

    mediaElement.addEventListener("loadedmetadata", handleLoadedMetadata);
    mediaElement.addEventListener("durationchange", syncDuration);
    mediaElement.addEventListener("timeupdate", handleTimeUpdate);

    syncDuration();
    syncCurrentTime();

    return () => {
      mediaElement.removeEventListener("loadedmetadata", handleLoadedMetadata);
      mediaElement.removeEventListener("durationchange", syncDuration);
      mediaElement.removeEventListener("timeupdate", handleTimeUpdate);
    };
  }, [
    mediaElement,
    onCurrentTimeChange,
    onDurationChange,
    provider,
    trimRangeEndSeconds,
    trimRangeStartSeconds,
  ]);
}

function ReadOnlyTimeline({
  data,
  currentTime,
  onSeek,
}: {
  data: SetAnalysisData;
  currentTime: number;
  onSeek: (time: number) => void;
}) {
  const safeDuration = Math.max(
    data.totalDuration,
    data.sentences[data.sentences.length - 1]?.end ?? 0,
    data.segments[data.segments.length - 1]?.end_time ?? 0,
    1,
  );
  const position = (time: number) =>
    `${Math.min(100, (time / safeDuration) * 100).toFixed(3)}%`;
  const width = (startTime: number, endTime: number) =>
    `${Math.max(((endTime - startTime) / safeDuration) * 100, 0.15).toFixed(3)}%`;

  return (
    <div className="border-tf bg-white p-2 shadow-tf-card">
      <div className="mb-1 flex items-center justify-between gap-2 px-0.5 font-mono text-[9px] text-tf-ink-muted">
        <span>{formatTime(currentTime)}</span>
        <span className="text-center text-[10px] font-black tracking-tf-ui text-tf-ink">
          TIMELINE
        </span>
        <span>{formatTime(safeDuration)}</span>
      </div>

      <div
        className="relative h-8 cursor-crosshair border-tf-subtle bg-tf-paper-alt"
        onClick={(event) => {
          const rect = event.currentTarget.getBoundingClientRect();
          onSeek(((event.clientX - rect.left) / rect.width) * safeDuration);
        }}
      >
        {data.segments.map((segment) => (
          <div
            key={segment.index}
            className="pointer-events-none absolute bottom-0 top-0"
            style={{
              left: position(segment.start_time),
              width: width(segment.start_time, segment.end_time),
              background: getIntensityColor(segment.intensity_score),
            }}
          />
        ))}
        <div
          className="pointer-events-none absolute bottom-0 top-0 z-20 w-[2px] bg-tf-red"
          style={{
            left: position(currentTime),
            transform: "translateX(-50%)",
          }}
        >
          <div className="absolute -top-1 left-1/2 h-2 w-2 -translate-x-1/2 rotate-45 bg-tf-red" />
        </div>
      </div>
    </div>
  );
}

function LinePanel({
  data,
  currentTime,
  onSeek,
}: {
  data: SetAnalysisData;
  currentTime: number;
  onSeek: (time: number) => void;
}) {
  const [filter, setFilter] = useState<"all" | "laughs">("all");
  const [sortMode, setSortMode] = useState<"timeline" | "intensity">(
    "timeline",
  );
  const activeSentence = getSelectedLine(data.sentences, currentTime);
  const visibleSentences = data.sentences.filter((sentence) =>
    filter === "laughs" ? sentence.laugh_count > 0 : true,
  );
  const displaySentences = [...visibleSentences].sort((left, right) => {
    if (sortMode === "intensity") {
      if (right.laugh_intensity_score !== left.laugh_intensity_score) {
        return right.laugh_intensity_score - left.laugh_intensity_score;
      }
      if (right.laugh_count !== left.laugh_count) {
        return right.laugh_count - left.laugh_count;
      }
    }

    return left.start - right.start;
  });

  return (
    <aside className="flex min-h-0 max-h-[60vh] w-full flex-col border-tf bg-white shadow-tf-card lg:h-full lg:max-h-none">
      <div className="flex items-center justify-between gap-2 border-b-2 border-tf-ink bg-tf-paper-alt px-2 py-1.5">
        <div>
          <div className="text-[11px] font-black uppercase tracking-[0.18em] text-tf-ink">
            Line Feed
          </div>
          <div className="font-mono text-[8px] uppercase tracking-[0.16em] text-tf-ink-muted">
            {filter === "all" ? "All lines" : "Laugh lines"} /{" "}
            {sortMode === "timeline" ? "Timeline" : "Intensity"}
          </div>
        </div>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={`flex h-8 items-center border border-tf-ink px-2 text-[8px] font-black uppercase tracking-[0.16em] ${
              filter === "laughs" ? "bg-tf-ink text-white" : "bg-white text-tf-ink"
            }`}
            onClick={() =>
              setFilter((current) => (current === "all" ? "laughs" : "all"))
            }
          >
            {filter === "all" ? "Show Laughs" : "Show All"}
          </button>
          <button
            type="button"
            className={`flex h-8 items-center border border-tf-ink px-2 text-[8px] font-black uppercase tracking-[0.16em] ${
              sortMode === "intensity"
                ? "bg-tf-ink text-white"
                : "bg-white text-tf-ink"
            }`}
            onClick={() =>
              setSortMode((current) =>
                current === "timeline" ? "intensity" : "timeline",
              )
            }
          >
            {sortMode === "timeline" ? "Most Intense" : "Timeline"}
          </button>
        </div>
      </div>

      <div className="flex-1 space-y-0.5 overflow-y-auto bg-neutral-50 p-1.5">
        {displaySentences.length === 0 ? (
          <div className="border border-dashed border-tf-ink bg-white px-3 py-4 text-center text-[11px] font-mono uppercase tracking-[0.2em] text-tf-ink-muted">
            No lines available yet.
          </div>
        ) : null}
        {displaySentences.map((sentence, index) => {
          const color = getIntensityColor(sentence.laugh_intensity_score);
          const intensityWidth = `${Math.max(
            sentence.laugh_intensity_score * 100,
            sentence.laugh_count > 0 ? 4 : 0,
          )}%`;
          const isActive = activeSentence?.index === sentence.index;
          const isPast = currentTime > sentence.end;

          return (
            <button
              key={sentence.index}
              type="button"
              className={`w-full cursor-pointer border bg-white text-left transition-all duration-100 ${
                isActive
                  ? "border-tf-red shadow-tf-active"
                  : "border-tf-ink hover:bg-tf-paper-alt"
              } ${isPast && !isActive ? "opacity-65" : ""}`}
              onClick={() => onSeek(sentence.start)}
            >
              <div className="px-2 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span
                      className={`h-1.5 w-1.5 flex-shrink-0 ${
                        isActive ? "animate-pulse" : ""
                      }`}
                      style={{
                        background:
                          sentence.laugh_count > 0 ? color : "#c7c2bb",
                      }}
                    />
                    <div className="line-clamp-2 min-w-0 text-[11px] leading-4 text-tf-ink">
                      {sentence.text}
                    </div>
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-1.5 font-mono text-[8px] uppercase tracking-[0.16em] text-tf-ink-muted">
                    {sortMode === "intensity" ? (
                      <span className="border border-tf-ink bg-tf-paper px-1 py-0.5 text-tf-ink">
                        #{index + 1}
                      </span>
                    ) : null}
                    <span>
                      {sentence.laugh_count} laugh
                      {sentence.laugh_count === 1 ? "" : "s"}
                    </span>
                  </div>
                </div>
                <div className="relative mt-1.5 h-3.5 w-full overflow-hidden border border-tf-ink bg-tf-paper-alt">
                  <div
                    className="absolute inset-y-0 left-0"
                    style={{ width: intensityWidth, background: color }}
                  />
                  {sentence.laughs.map((laugh) => {
                    const laughCenter =
                      ((laugh.start_time + laugh.end_time) / 2 - sentence.start) /
                      Math.max(sentence.end - sentence.start, 0.01);

                    return (
                      <span
                        key={`${sentence.index}-${laugh.index}`}
                        className="absolute top-0 h-full w-px bg-white/90 mix-blend-screen"
                        style={{
                          left: `${Math.min(
                            100,
                            Math.max(0, laughCenter * 100),
                          )}%`,
                        }}
                      />
                    );
                  })}
                </div>
                <div className="mt-1 flex items-center justify-between font-mono text-[8px] uppercase tracking-[0.16em] text-tf-ink-muted">
                  <span>{formatPreciseTime(sentence.start)}</span>
                  <span>{formatPreciseTime(sentence.end)}</span>
                </div>
              </div>
            </button>
          );
        })}
      </div>
    </aside>
  );
}

function TrimmedMediaControls({
  currentTime,
  duration,
  isPlaying,
  onPlayPause,
  onSeek,
}: {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  onPlayPause: () => void;
  onSeek: (time: number) => void;
}) {
  const safeDuration = Math.max(duration, 0);

  return (
    <div className="border-tf border-t bg-white px-3 py-2">
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={onPlayPause}
          className="inline-flex h-10 w-10 items-center justify-center border-2 border-tf-ink bg-tf-paper text-tf-ink transition hover:bg-tf-paper-alt"
          aria-label={isPlaying ? "Pause playback" : "Play playback"}
        >
          {isPlaying ? <Pause className="size-4" /> : <Play className="size-4" />}
        </button>
        <div className="min-w-0 flex-1">
          <input
            type="range"
            min={0}
            max={safeDuration || 0}
            step={0.01}
            value={Math.min(currentTime, safeDuration)}
            onChange={(event) => onSeek(Number(event.currentTarget.value))}
            className="w-full accent-tf-red"
            aria-label="Trimmed playback position"
          />
          <div className="mt-1 flex items-center justify-between font-mono text-[9px] uppercase tracking-[0.16em] text-tf-ink-muted">
            <span>{formatTime(currentTime)}</span>
            <span>{formatTime(safeDuration)}</span>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function SetPageClient({ setId }: { setId: string }) {
  const set = useQuery(api.sets.getSetPageForViewer, {
    setId: setId as Id<"sets">,
  });
  const mediaRef = useRef<HTMLVideoElement | null>(null);
  const [mediaElement, setMediaElement] = useState<HTMLVideoElement | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const playbackProvider = set?.activePlaybackSource?.provider ?? null;
  const trimRangeStartSeconds = set?.trimRangeStartSeconds ?? 0;
  const trimRangeEndSeconds = set?.trimRangeEndSeconds ?? 0;

  const analysisData = useMemo<SetAnalysisData | null>(
    () => set?.analysisData ?? null,
    [set],
  );
  const laughLines = useMemo(
    () =>
      analysisData?.sentences.filter((sentence) => sentence.laugh_count > 0) ?? [],
    [analysisData],
  );
  const activeLine = useMemo(
    () =>
      analysisData ? getSelectedLine(analysisData.sentences, currentTime) : null,
    [analysisData, currentTime],
  );
  const activeLaugh = useMemo(() => {
    if (!analysisData) {
      return null;
    }

    return analysisData.segments.reduce<
      SetAnalysisData["segments"][number] | null
    >((active, segment) => {
      if (currentTime < segment.start_time || currentTime > segment.end_time) {
        return active;
      }

      if (!active || segment.intensity_score > active.intensity_score) {
        return segment;
      }

      return active;
    }, null);
  }, [analysisData, currentTime]);

  useHlsPlayback(
    mediaElement,
    set?.activePlaybackSource?.playbackUrl ?? null,
    (set?.activePlaybackSource?.playbackMode ?? "hls") as "direct" | "hls",
  );
  useTrimmedPlaybackWindow(
    mediaElement,
    playbackProvider,
    trimRangeStartSeconds,
    trimRangeEndSeconds,
    setCurrentTime,
    setDuration,
  );

  useEffect(() => {
    if (!mediaElement) {
      return;
    }

    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleEnded = () => setIsPlaying(false);

    mediaElement.addEventListener("play", handlePlay);
    mediaElement.addEventListener("pause", handlePause);
    mediaElement.addEventListener("ended", handleEnded);
    setIsPlaying(!mediaElement.paused);

    return () => {
      mediaElement.removeEventListener("play", handlePlay);
      mediaElement.removeEventListener("pause", handlePause);
      mediaElement.removeEventListener("ended", handleEnded);
    };
  }, [mediaElement]);

  function seekToClipTime(time: number) {
    if (!mediaRef.current) {
      return;
    }

    mediaRef.current.currentTime = getSourceTimeFromClipTime(
      time,
      playbackProvider,
      trimRangeStartSeconds,
      trimRangeEndSeconds,
    );
  }

  function togglePlayback() {
    if (!mediaRef.current) {
      return;
    }

    if (mediaRef.current.paused) {
      void mediaRef.current.play().catch(() => null);
      return;
    }

    mediaRef.current.pause();
  }

  if (set === undefined) {
    return (
      <main className="min-h-[calc(100vh-4.5rem)] bg-tf-paper px-4 py-5 text-tf-ink md:px-6">
        <div className="mx-auto flex min-h-[50vh] max-w-7xl items-center justify-center">
          <LoaderCircle className="size-8 animate-spin text-tf-ink" />
        </div>
      </main>
    );
  }

  if (set === null) {
    return (
      <main className="min-h-[calc(100vh-4.5rem)] bg-tf-paper px-4 py-5 text-tf-ink md:px-6">
        <div className="mx-auto max-w-4xl border-tf bg-white p-8 text-center shadow-tf-card">
          <h1 className="text-3xl font-black uppercase tracking-tight">
            Set Not Found
          </h1>
          <p className="mt-3 text-sm text-tf-ink-soft">
            This Set is unavailable or you do not have access to it.
          </p>
          <div className="mt-6">
            <Button asChild>
              <Link href="/library">Back To Library</Link>
            </Button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-[calc(100vh-4.5rem)] bg-tf-paper px-4 py-5 text-tf-ink md:px-6">
      <div className="mx-auto flex max-w-7xl flex-col gap-4">
        <section className="border-tf bg-white shadow-tf-card">
          <div className="border-b-2 border-tf-ink bg-tf-paper-alt p-4">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-tf-ink-muted">
                Set Review
              </p>
              <h1 className="mt-2 text-3xl font-black uppercase tracking-tight md:text-5xl">
                {set.title}
              </h1>
            </div>
          </div>

          <div className="p-4">
            <div className="grid min-h-0 grid-cols-1 gap-3 lg:grid-cols-3 lg:gap-4">
              <div className="flex min-h-0 flex-col gap-3 lg:col-span-2">
                <div className="relative overflow-hidden border-tf bg-black shadow-tf-card">
                  {set.activePlaybackSource ? (
                    <>
                        <video
                          ref={(node) => {
                            mediaRef.current = node;
                            setMediaElement(node);
                          }}
                          playsInline
                          preload="metadata"
                          className="aspect-video w-full bg-black"
                          onClick={togglePlayback}
                        />
                        {activeLine ? (
                          <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/85 via-black/55 to-transparent px-5 pb-6 pt-10">
                            <div className="mx-auto max-w-4xl text-center">
                              <div className="text-[9px] font-mono uppercase tracking-[0.2em] text-white/60">
                                {formatPreciseTime(activeLine.start)} -{" "}
                                {formatPreciseTime(activeLine.end)}
                              </div>
                              <div className="mt-2 text-lg font-black uppercase leading-tight tracking-[0.04em] text-white sm:text-2xl">
                                {activeLine.text}
                              </div>
                            </div>
                          </div>
                        ) : null}
                        {activeLaugh ? (
                          <div
                            className="pointer-events-none absolute right-3 top-3 z-10 border-2 border-white/20 px-3 py-1.5"
                            style={{
                              background: getIntensityColor(
                                activeLaugh.intensity_score,
                              ),
                            }}
                          >
                            <span className="text-[10px] font-black uppercase tracking-widest text-white">
                              Laughing
                            </span>
                          </div>
                        ) : null}
                        <div className="absolute inset-x-0 bottom-0 z-20">
                          <TrimmedMediaControls
                            currentTime={currentTime}
                            duration={duration}
                            isPlaying={isPlaying}
                            onPlayPause={togglePlayback}
                            onSeek={seekToClipTime}
                          />
                        </div>
                    </>
                  ) : (
                    <div className="flex aspect-video items-center justify-center bg-tf-paper-alt px-6 text-center">
                      <div>
                        <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-tf-ink-muted">
                          Playback Pending
                        </p>
                        <p className="mt-2 text-sm text-tf-ink-soft">
                          The Set stays visible while playback is being prepared.
                        </p>
                      </div>
                    </div>
                  )}
                </div>

                {analysisData ? (
                  <>
                    <ReadOnlyTimeline
                      data={analysisData}
                      currentTime={currentTime}
                      onSeek={(time) => {
                        if (!mediaRef.current) {
                          return;
                        }
                        seekToClipTime(time);
                        void mediaRef.current.play().catch(() => null);
                      }}
                    />

                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Button
                        variant="outline"
                        disabled={laughLines.length === 0}
                        onClick={() => {
                          const target =
                            laughLines
                              .filter((sentence) => sentence.start < currentTime - 1)
                              .at(-1) ?? laughLines[0];
                          if (!target || !mediaRef.current) {
                            return;
                          }
                          seekToClipTime(target.start);
                          void mediaRef.current.play().catch(() => null);
                        }}
                        className="w-full"
                      >
                        Prev Laugh Line
                      </Button>
                      <Button
                        variant="outline"
                        disabled={laughLines.length === 0}
                        onClick={() => {
                          const target =
                            laughLines.find(
                              (sentence) => sentence.start > currentTime + 0.001,
                            ) ?? laughLines[laughLines.length - 1];
                          if (!target || !mediaRef.current) {
                            return;
                          }
                          seekToClipTime(target.start);
                          void mediaRef.current.play().catch(() => null);
                        }}
                        className="w-full"
                      >
                        Next Laugh Line
                      </Button>
                    </div>
                  </>
                ) : (
                  <div className="border-tf bg-white p-4 text-sm text-tf-ink-soft shadow-tf-card">
                    Breakdown coming soon.
                  </div>
                )}
              </div>

              {analysisData ? (
                <LinePanel
                  data={{
                    ...analysisData,
                    totalDuration: Math.max(
                      analysisData.totalDuration,
                      duration,
                    ),
                  }}
                  currentTime={currentTime}
                  onSeek={(time) => {
                    if (!mediaRef.current) {
                      return;
                    }
                    seekToClipTime(time);
                    void mediaRef.current.play().catch(() => null);
                  }}
                />
              ) : (
                <aside className="border-tf bg-white p-4 shadow-tf-card">
                  <p className="font-mono text-[10px] uppercase tracking-[0.2em] text-tf-ink-muted">
                    Breakdown Status
                  </p>
                  <p className="mt-3 text-sm text-tf-ink-soft">
                    Breakdown coming soon.
                  </p>
                </aside>
              )}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
