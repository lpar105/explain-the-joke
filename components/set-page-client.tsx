"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Pause, Play } from "lucide-react";
import { useConvexAuth, useQuery } from "convex/react";
import Link from "next/link";

import { api } from "../convex/_generated/api";
import { getEffectivePathState } from "../lib/breakdown-progress";
import { activeReviewLine, formatReviewTime as formatTime, laughIntensityColor, laughNeighbors, reviewLaughs, strongestLines } from "../lib/set-review";
import type { TranscriptSentence } from "../lib/setAnalysis";
import { artifactType, DevAudioComparison, DevCutoffControls, type SetArtifact, SetArtifactPreview, useDevCutoff } from "./set-dev-artifacts";
import { SetEditDialog } from "./set-edit-dialog";
import { Button } from "./ui/button";
import { useSetPlayback } from "./use-set-playback";
import { useVerifiedSetArtifacts } from "./use-verified-dev-query";

const emptyLines: TranscriptSentence[] = [];

export default function SetPageClient({ setId, devArtifacts }: { setId: string; devArtifacts?: SetArtifact[] }) {
  const dev = devArtifacts !== undefined;
  const { isLoading, isAuthenticated } = useConvexAuth();
  const set = useQuery(api.sets.getSetPageForViewer, !dev || isAuthenticated ? { setId } : "skip");
  const nativeArtifacts = useQuery(api.sets.listDevArtifacts, dev && isAuthenticated ? { setId } : "skip");
  const verifiedArtifacts = useVerifiedSetArtifacts(setId, dev && isAuthenticated && nativeArtifacts === null);
  const liveArtifacts = nativeArtifacts === null ? verifiedArtifacts : nativeArtifacts;
  const artifacts = liveArtifacts === undefined ? devArtifacts : liveArtifacts ?? undefined;
  const cutoff = useDevCutoff(setId, artifacts);
  const [selection, setSelection] = useState("");
  const artifact = artifacts?.find((item) => item.id === selection);
  const selectedType = artifact ? artifactType(artifact) : null;
  const showPreview = artifact && selectedType !== "audio" && selectedType !== "video";
  const source = !artifact ? set?.activePlaybackSource : artifact.url && !showPreview ? {
    _id: artifact.id,
    provider: "bunny" as const,
    playbackUrl: artifact.url,
    playbackMode: "direct" as const,
  } : null;
  const { attachMedia, status, togglePlayback, pausePlayback, retryPlayback, seek: seekPlayback, playing, currentTime, duration, canSeek, hasPlayedSource } = useSetPlayback(source, set?.trimRangeStartSeconds ?? 0, set?.trimRangeEndSeconds ?? 0);
  const [editSnapshot, setEditSnapshot] = useState<{
    breakdown: NonNullable<NonNullable<typeof set>["breakdown"]>;
    lines: TranscriptSentence[];
    initialTime: number;
  } | null>(null);
  const editTrigger = useRef<HTMLButtonElement>(null);

  const savedLines: TranscriptSentence[] = set?.analysisData?.sentences ?? emptyLines;
  const previewLaughs = useMemo(() => cutoff.regions?.map((region, index) => ({
    index,
    start_time: region.start,
    end_time: region.end,
    duration: region.end - region.start,
    intensity_score: region.intensityScore,
  })), [cutoff.regions]);
  const lines = useMemo(() => {
    if (!previewLaughs || !savedLines.length) return savedLines;

    const projected = savedLines.map((line): TranscriptSentence => ({
      ...line, laughs: [], laugh_count: 0, laugh_intensity_score: 0,
    }));
    let index = 0;
    for (const laugh of previewLaughs) {
      while (index + 1 < projected.length && projected[index + 1].start <= laugh.start_time) index++;
      const line = projected[index];
      line.laughs.push(laugh);
      line.laugh_count++;
      line.laugh_intensity_score = Math.max(line.laugh_intensity_score, laugh.intensity_score);
    }
    return projected;
  }, [savedLines, previewLaughs]);
  const laughs = useMemo(() => reviewLaughs(lines), [lines]);
  const longestLaughDuration = useMemo(() => laughs.reduce(
    (longest, { laugh }) => Math.max(longest, laugh.duration), 0,
  ), [laughs]);
  const timelineLaughs = previewLaughs ?? laughs.map(({ laugh }) => laugh);
  const isLaughing = hasPlayedSource && timelineLaughs.some((laugh) =>
    laugh.start_time <= currentTime && currentTime < laugh.end_time,
  );
  const ranked = useMemo(() => strongestLines(lines), [lines]);
  const [strongest, setStrongest] = useState(false);
  const [follow, setFollow] = useState(true);
  const [navigationTarget, setNavigationTarget] = useState<(typeof laughs)[number] | null>(null);
  const activeLine = activeReviewLine(lines, currentTime);
  const scrollPane = useRef<HTMLDivElement>(null);
  const activeRow = useRef<HTMLButtonElement>(null);
  const expectedScroll = useRef(0);
  const rankedView = strongest && laughs.length > 0;
  const target = navigationTarget && currentTime < navigationTarget.laugh.end_time &&
    currentTime >= navigationTarget.line.start ? laughs.find(({ laugh }) => laugh.index === navigationTarget.laugh.index) ?? null : null;
  const { previous, next } = laughNeighbors(laughs, currentTime, target);

  useEffect(() => {
    const pane = scrollPane.current;
    const row = activeRow.current;
    if (!pane || !row || !follow || !hasPlayedSource) return;

    const start = pane.scrollTop;
    const target = start + row.getBoundingClientRect().top - pane.getBoundingClientRect().top;
    const distance = Math.min(Math.max(0, target), pane.scrollHeight - pane.clientHeight) - start;
    if (Math.abs(distance) < 1) return;

    function scrollTo(top: number) {
      if (!pane) return;
      pane.scrollTop = top;
      expectedScroll.current = pane.scrollTop;
    }

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      scrollTo(start + distance);
      return;
    }

    const startedAt = performance.now();
    let frame: number;
    function animate(now: number) {
      const progress = Math.min(1, (now - startedAt) / 220);
      scrollTo(start + distance * (1 - (1 - progress) ** 3));
      if (progress < 1) frame = requestAnimationFrame(animate);
    }
    frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [activeLine, hasPlayedSource, follow, rankedView]);

  const transcriptState = getEffectivePathState(set?.breakdown?.lineSeedingState ?? "pending", set?.ingestJobStatus ?? null);
  const laughState = getEffectivePathState(set?.breakdown?.laughSeedingState ?? "pending", set?.ingestJobStatus ?? null);
  const transcriptMessage = set === undefined ? "Opening transcript…" :
    transcriptState === "failed" ? "The transcript couldn’t be prepared." :
    transcriptState === "ready" ? "No spoken words found." :
    transcriptState === "retrying" ? "Trying the transcript again…" : "Building transcript…";
  const laughMessage = previewLaughs ? (previewLaughs.length ? "Previewing cutoff changes." : "No laughs at this cutoff.") :
    lines.length === 0 ? "" :
    set?.breakdown?.laughsEdited ? (laughs.length ? "" : "No laughs marked.") :
    laughState === "failed" ? (set?.isOwner ? "Laugh analysis failed. You can add laughs manually." : "Laugh analysis unavailable.") :
    laughState === "ready" ? (laughs.length ? "" : "No laughs detected.") :
    laughState === "retrying" ? "Trying laugh analysis again…" : "Finding laughs…";
  const playerMessage = set === undefined ? "Opening Set…" :
    !source ? (set?.setStatus === "unavailable" ? "Playback unavailable." : "Preparing playback…") :
    status === "loading" ? "Preparing playback…" :
    status === "error" ? "Playback couldn’t load." :
    status === "buffering" ? "Buffering…" : "";

  function seek(time: number) {
    setNavigationTarget(null);
    seekPlayback(time);
  }

  function jump(destination: (typeof laughs)[number] | undefined) {
    if (!destination) return;
    setNavigationTarget(destination);
    seekPlayback(destination.line.start);
  }

  if (set === null || (dev && !isLoading && !isAuthenticated)) {
    return (
      <main className="mx-auto my-6 max-w-3xl border-tf bg-white p-6 text-center shadow-tf-card">
        <h1 className="text-2xl font-black uppercase">Set not found</h1>
        <p className="my-4 text-sm">This Set is unavailable or you don’t have access to it.</p>
        <Button asChild><Link href="/library">Back to Library</Link></Button>
      </main>
    );
  }

  return (
    <main className="grid h-[calc(100dvh-3.875rem)] min-h-80 grid-cols-[minmax(17rem,28%)_minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)] gap-3 bg-tf-paper px-4 pt-3 pb-4 text-tf-ink [grid-template-areas:'heading_heading'_'left_right']
      [@media(max-width:700px)]:min-h-[27rem] [@media(max-width:700px)]:grid-cols-1 [@media(max-width:700px)]:grid-rows-[auto_clamp(4rem,30dvh,20rem)_auto_auto_minmax(0,1fr)] [@media(max-width:700px)]:gap-2 [@media(max-width:700px)]:px-3 [@media(max-width:700px)]:[grid-template-areas:'heading'_'player'_'transport'_'laughs'_'transcript']
      [@media(max-width:700px)_and_(max-height:520px)]:grid-rows-[auto_clamp(4rem,23dvh,8rem)_auto_auto_minmax(0,1fr)]" aria-label={dev ? "Set review DEV mode" : "Set review"}>
      <header className={`flex min-h-9 items-center gap-3 [grid-area:heading]
        [@media(max-width:700px)]:[&_h1]:[font-size:1rem] [@media(max-width:700px)]:[&_button]:max-w-[55%] [@media(max-width:700px)]:[&_button]:px-2 [@media(max-width:700px)]:[&_button]:tracking-[0.07em]
        ${dev ? "flex-wrap" : ""}`}>
        <h1 className="min-w-0 break-words text-xl leading-tight font-black uppercase tracking-tf-tight sm:text-3xl">{set?.title}</h1>
        {set?.isOwner && (
          <Button ref={editTrigger} type="button" size="sm" variant="outline" className="ml-auto whitespace-normal text-center"
            aria-haspopup="dialog" disabled={transcriptState !== "ready" || set.breakdown?.editability !== "editable"}
            onClick={() => {
              if (!set.breakdown) return;
              pausePlayback();
              setEditSnapshot({ breakdown: set.breakdown, lines: savedLines, initialTime: currentTime });
            }}>
            Edit transcript/timings
          </Button>
        )}
        {dev && (
          <div className="flex min-w-0 flex-[1_0_100%] flex-wrap items-center gap-2 border-tf bg-tf-paper-alt px-2 py-1.5 text-[0.75rem]">
            <label className="flex min-w-0 max-w-full items-center gap-2">
              <strong className="whitespace-nowrap">DEV artifact</strong>
              <select className="min-w-0 border-tf-subtle bg-white px-1.5 py-1 [font-family:var(--font-mono),monospace]" value={artifact?.id ?? ""} onChange={(event) => {
                const id = event.currentTarget.value;
                const next = artifacts?.find((item) => item.id === id);
                if (next && !["audio", "video"].includes(artifactType(next))) pausePlayback();
                setSelection(id);
              }}>
                <option value="">Set video</option>
                {artifacts?.map((item) => <option key={item.id} value={item.id}>
                  {item.fileName}{item.run !== null ? ` · Run ${item.run}` : ""}{item.isCanonical ? "" : " · Superseded"}
                </option>)}
              </select>
            </label>
            {artifact?.url && <a className="underline" href={artifact.url} target="_blank" rel="noreferrer">Open file</a>}
            {artifacts?.length === 0 && <span>No artifacts yet.</span>}
            {artifacts && <DevAudioComparison artifacts={artifacts} selection={selection} onSelect={setSelection} />}
            <DevCutoffControls cutoff={cutoff} onChange={() => setNavigationTarget(null)} />
          </div>
        )}
      </header>
      {set?.isOwner && editSnapshot && <SetEditDialog
        title={set.title} setId={set._id} breakdownId={editSnapshot.breakdown._id} editRevision={editSnapshot.breakdown.editRevision}
        lines={editSnapshot.lines} source={set.activePlaybackSource} trimStart={set.trimRangeStartSeconds}
        trimEnd={set.trimRangeEndSeconds} initialTime={editSnapshot.initialTime} trigger={editTrigger}
        onClose={savedTime => {
          setEditSnapshot(null);
          if (savedTime !== undefined) seek(savedTime);
        }}
      />}

      <div className="grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] gap-3 [grid-area:right] [@media(max-width:700px)]:contents">
        <section className="relative min-h-0 overflow-hidden border-tf bg-tf-ink shadow-tf-card [@media(max-width:700px)]:[grid-area:player]" aria-label="Set player">
          {showPreview ? <SetArtifactPreview key={artifact.id} setId={setId} artifact={artifact} /> :
            selectedType === "audio" ? (
              <div className="grid size-full place-items-center p-3 text-white">
                <audio ref={attachMedia} preload="auto" />
                <p className="break-all font-mono text-sm">{artifact?.fileName}</p>
              </div>
            ) : <video ref={attachMedia} playsInline preload="auto" onClick={togglePlayback} className="size-full object-contain" />}
          {!showPreview && isLaughing && status !== "error" && (
            <span className="pointer-events-none absolute top-3 right-3 border-2 border-white/30 bg-tf-red px-2 py-1 text-[10px] font-black uppercase tracking-widest text-white">
              Laughing
            </span>
          )}
          {!showPreview && playerMessage && (
            <div className={`absolute grid justify-items-center gap-2 ${status === "buffering" ? "pointer-events-none bottom-2 left-2" : "inset-0 place-content-center"}`}>
              <p role="status" className="bg-tf-paper px-3 py-2 font-mono text-xs text-tf-ink">{playerMessage}</p>
              {status === "error" && (
                <Button size="sm" type="button" onClick={retryPlayback}>Retry playback</Button>
              )}
            </div>
          )}
        </section>

        <section className="flex items-center gap-1.5 border-tf bg-white px-1 py-0.5 shadow-tf-card [@media(max-width:700px)]:[grid-area:transport]" aria-label="Playback controls">
          <Button size="icon" type="button" disabled={!canSeek} onClick={togglePlayback}
            aria-label={playing ? "Pause" : "Play"}>
            {playing ? <Pause aria-hidden="true" /> : <Play aria-hidden="true" />}
          </Button>
          <span className="whitespace-nowrap font-mono text-[10px]">{formatTime(currentTime)} / {formatTime(duration)}</span>
          <div className="relative min-w-0 flex-1 px-[calc(var(--playhead-width)/2)] [--playhead-width:12px] focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-tf-red">
            <div className="relative h-[1.375rem] overflow-hidden border-tf-subtle bg-tf-paper-alt" aria-hidden="true">
              {duration > 0 && timelineLaughs.map((laugh) => (
                <span key={laugh.index} className="absolute inset-y-0 min-w-px" style={{
                  left: `${100 * laugh.start_time / duration}%`,
                  width: `${100 * laugh.duration / duration}%`,
                  background: laughIntensityColor(laugh.intensity_score),
                }} />
              ))}
            </div>
            <div className="pointer-events-none absolute inset-y-0 inset-x-[calc(var(--playhead-width)/2)]" aria-hidden="true">
              <span className="absolute -inset-y-[3px] w-(--playhead-width) -translate-x-1/2 bg-tf-ink [clip-path:polygon(0_0,100%_0,64%_7px,64%_100%,36%_100%,36%_7px)] drop-shadow-[0_0_1px_var(--tf-white)]"
                style={{ left: `${duration ? 100 * currentTime / duration : 0}%` }} />
            </div>
            <input className="absolute inset-0 m-0 size-full cursor-ew-resize appearance-none opacity-0 disabled:cursor-default
                [&::-webkit-slider-thumb]:h-full [&::-webkit-slider-thumb]:w-(--playhead-width) [&::-webkit-slider-thumb]:appearance-none
                [&::-moz-range-thumb]:w-(--playhead-width) [&::-moz-range-thumb]:border-0"
              aria-label="Set timeline" aria-valuetext={formatTime(currentTime)} type="range"
              min={0} max={duration} step="any" value={currentTime} disabled={!canSeek}
              onChange={(event) => seek(event.currentTarget.valueAsNumber)} />
          </div>
        </section>
      </div>

      <div className="grid min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] gap-3 [grid-area:left] [@media(max-width:700px)]:contents">
        <section className="flex min-h-0 min-w-0 flex-col border-tf bg-white shadow-tf-card [@media(max-width:700px)]:[grid-area:transcript]" aria-labelledby="transcript-heading">
          <header className="border-b-2 border-tf-ink bg-tf-paper-alt p-2">
            <h2 id="transcript-heading" className="mb-1 text-xs font-black uppercase tracking-tf-ui">Transcript</h2>
            <div className="flex flex-wrap gap-1.5">
              <Button size="sm" className="h-7 px-2 tracking-normal" type="button" aria-pressed={follow}
                variant={follow ? "default" : "outline"} onClick={() => setFollow(!follow)}>Follow playback</Button>
              <Button size="sm" className="h-7 px-2 tracking-normal" type="button" aria-pressed={rankedView}
                variant={rankedView ? "default" : "outline"} disabled={!laughs.length} onClick={() => setStrongest(!rankedView)}>
                Strongest first
              </Button>
            </div>
          </header>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain [container-type:size] [overflow-anchor:none] data-[follow=true]:has-[button]:after:block data-[follow=true]:has-[button]:after:h-[100cqh]" ref={scrollPane} data-follow={follow}
            onWheel={() => setFollow(false)} onTouchMove={() => setFollow(false)}
            onScroll={(event) => {
              if (Math.abs(event.currentTarget.scrollTop - expectedScroll.current) > 1) setFollow(false);
            }}>
            {(!lines.length || transcriptState !== "ready") && <p role="status" className="p-3 font-mono text-xs text-tf-ink-soft">{transcriptMessage}</p>}
            {(rankedView ? ranked : lines).map((line, index) => {
              const hasLaugh = line.laughs.length > 0;
              const active = hasPlayedSource && line.index === activeLine?.index;
              return (
                <button key={line.index} className="block w-full border-b border-b-tf-paper-alt px-2 py-1.5 text-left text-[0.8125rem]/[1.35] wrap-anywhere
                  [&:hover:not(:disabled)]:bg-tf-paper-alt aria-[current]:bg-tf-paper-alt aria-[current]:shadow-[inset_3px_0_var(--tf-accent-red)] focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-tf-red" type="button" disabled={!canSeek}
                  ref={line.index === activeLine?.index ? activeRow : undefined} aria-current={active ? "true" : undefined}
                  onClick={() => seek(line.start)}>
                  <span className="flex gap-2">
                    {rankedView && hasLaugh && <span className="shrink-0 font-mono text-[10px] font-bold text-tf-red">#{index + 1}</span>}
                    <span>{line.text}</span>
                  </span>
                  {line.laughs.map((laugh) => (
                    <span key={laugh.index} className="mt-1 block h-[7px] bg-tf-paper-alt" role="img"
                      aria-label={`Laugh duration ${Number(laugh.duration.toFixed(2))} seconds, intensity ${Math.round(laugh.intensity_score * 100)}%`}>
                      <span className="block h-full min-w-px" style={{
                        width: `${longestLaughDuration > 0 ? 100 * laugh.duration / longestLaughDuration : 0}%`,
                        background: laughIntensityColor(laugh.intensity_score),
                      }} />
                    </span>
                  ))}
                </button>
              );
            })}
          </div>
        </section>

        <section className="border-tf bg-white px-2 pt-1 pb-2 shadow-tf-card [@media(max-width:700px)]:[grid-area:laughs]" aria-label="Laugh navigation">
          <p role="status" className="flex min-h-7 items-center font-mono text-[10px] leading-tight text-tf-ink-soft">{laughMessage}</p>
          <div className="grid grid-cols-2 gap-2">
            <Button size="sm" type="button" variant="outline" className="min-w-0 gap-1 px-1 tracking-normal"
              disabled={!canSeek || !previous} onClick={() => jump(previous)}>
              <ArrowLeft aria-hidden="true" /> Previous laugh
            </Button>
            <Button size="sm" type="button" variant="outline" className="min-w-0 gap-1 px-1 tracking-normal"
              disabled={!canSeek || !next} onClick={() => jump(next)}>
              Next laugh <ArrowRight aria-hidden="true" />
            </Button>
          </div>
        </section>
      </div>
    </main>
  );
}
