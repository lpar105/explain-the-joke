"use client";

import { useMutation } from "convex/react";
import { ArrowLeft, ArrowRight, Pause, Play, Trash2 } from "lucide-react";
import { memo, useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, PointerEvent, RefObject } from "react";

import { api } from "../convex/_generated/api";
import type { Id } from "../convex/_generated/dataModel";
import { constrainLaughMark, retimeLaughMark } from "../lib/calibration";
import { getErrorMessageForCode, toAppError } from "../lib/errors";
import { activeReviewLine, formatReviewTime, laughIntensityColor, reviewLaughs, timingWindowAt, zoomTimingWindow } from "../lib/set-review";
import type { TranscriptSentence } from "../lib/setAnalysis";
import { clampTime } from "../lib/trim-range";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { type PlaybackSource, useSetPlayback } from "./use-set-playback";
import styles from "./set-edit-dialog.module.css";

const minWindowLength = 1;
const zoomSliderSteps = 1000;
const handleStep = 0.05;

type Laugh = { key: number; index: number | null; start: number; end: number; intensityScore: number };
type Edge = "start" | "end";
type Drag = {
  origin: number;
  windowStart: number;
  windowEnd: number;
  action:
    | { kind: "resize"; key: number; edge: Edge; boundary: number }
    | { kind: "intensity"; key: number; score: number; x: number; y: number; adjusting: boolean }
    | null;
};

type Props = {
  setId: Id<"sets">;
  title: string;
  breakdownId: Id<"breakdowns">;
  editRevision: number;
  lines: TranscriptSentence[];
  source: PlaybackSource | null;
  trimStart: number;
  trimEnd: number;
  initialTime: number;
  trigger: RefObject<HTMLButtonElement | null>;
  onClose: (savedTime?: number) => void;
};

function preciseTime(seconds: number) {
  const hundredths = Math.round(seconds * 100);
  return `${formatReviewTime(hundredths / 100)}.${String(hundredths % 100).padStart(2, "0")}`;
}

function intensityPercent(score: number) {
  return Math.round(clampTime(score, 0, 1) * 100);
}

export function SetEditDialog(props: Props) {
  const {
    attachMedia, currentTime, duration, canSeek, playing, seek, status, pausePlayback, togglePlayback, retryPlayback,
  } = useSetPlayback(props.source, props.trimStart, props.trimEnd, props.initialTime, { frameUpdates: true });
  const saveBreakdown = useMutation(api.sets.saveBreakdownEdits);
  const [originals] = useState<Laugh[]>(() => reviewLaughs(props.lines).map(({ laugh }, key) => ({
    key, index: laugh.index, start: laugh.start_time, end: laugh.end_time, intensityScore: laugh.intensity_score,
  })));
  const [laughs, setLaughs] = useState(originals);
  const [words, setWords] = useState<Record<number, string>>({});
  const [selected, setSelected] = useState<number | null>(null);
  const [mark, setMark] = useState<number | null>(null);
  const [preview, setPreview] = useState<{ start: number; end: number } | null>(null);
  const [dragWindow, setDragWindow] = useState<number | null>(null);
  const [zoom, setZoom] = useState({ length: 20, origin: 0 });
  const [feedback, setFeedback] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [stale, setStale] = useState(false);
  const nextKey = useRef(originals.length);
  const drag = useRef<Drag | null>(null);
  const startButton = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const maxWindowLength = Math.max(duration, minWindowLength);
  const windowLength = clampTime(zoom.length, minWindowLength, maxWindowLength);
  const zoomFactor = maxWindowLength / minWindowLength;
  // Equal slider movements change the time scale by the same ratio.
  const zoomPosition = zoomFactor > 1
    ? Math.round(zoomSliderSteps * Math.log(maxWindowLength / windowLength) / Math.log(zoomFactor))
    : 0;
  const timeline = timingWindowAt(currentTime, duration, windowLength, zoom.origin);
  const windowStart = dragWindow ?? timeline.start;
  const windowEnd = dragWindow === null ? timeline.end : windowStart + windowLength;
  const playableStart = Math.max(0, windowStart);
  const playableEnd = Math.min(duration, windowEnd);
  const percent = (time: number) => clampTime((time - windowStart) / windowLength * 100, 0, 100);
  const activeLine = activeReviewLine(props.lines, currentTime);
  const selectedLaugh = laughs.find(laugh => laugh.key === selected);
  const jumpTo = selectedLaugh ??
    laughs.find(laugh => laugh.end > currentTime) ?? laughs.at(-1);
  const canMark = !saving && canSeek && props.lines.length > 0;
  const bounds = { start: 0, end: duration };
  const laughsChanged = laughs.length !== originals.length || laughs.some((laugh, index) =>
    laugh.key !== originals[index]?.key || laugh.start !== originals[index].start ||
    laugh.end !== originals[index].end || laugh.intensityScore !== originals[index].intensityScore);
  const textEdits = useMemo(() => props.lines.flatMap(line => {
    const text = words[line.index]?.trim();
    return text !== undefined && text !== line.text ? [{ index: line.index, text }] : [];
  }), [props.lines, words]);
  const mergesLaughs = useMemo(() => {
    if (!laughsChanged) return false;
    let previous: number | undefined;
    for (const laugh of laughs) {
      const owner = activeReviewLine(props.lines, laugh.start)?.index;
      if (owner === previous) return true;
      previous = owner;
    }
    return false;
  }, [laughs, laughsChanged, props.lines]);
  const changeWords = useCallback((index: number, text: string) => {
    setWords(current => ({ ...current, [index]: text }));
    setError("");
  }, []);
  const seekToLine = useCallback((time: number) => {
    seek(time);
    setSelected(null);
  }, [seek]);

  function changeIntensity(key: number, intensityScore: number) {
    setLaughs(current => current.map(laugh =>
      laugh.key === key ? { ...laugh, intensityScore } : laugh));
    setError("");
  }

  function intensityKey(event: KeyboardEvent, laugh: Laugh) {
    if (saving) return;
    const step = event.shiftKey ? 10 : 1;
    const score = intensityPercent(laugh.intensityScore);
    let next: number;
    switch (event.key) {
      case "ArrowUp":
      case "ArrowRight":
        next = score + step;
        break;
      case "ArrowDown":
      case "ArrowLeft":
        next = score - step;
        break;
      case "Home":
        next = 0;
        break;
      case "End":
        next = 100;
        break;
      default:
        return;
    }
    event.preventDefault();
    changeIntensity(laugh.key, clampTime(next, 0, 100) / 100);
  }

  function addLaugh(region: { start: number; end: number } | null) {
    if (!region) {
      setFeedback("Choose a range outside the existing laughs.");
      return;
    }
    const key = nextKey.current++;
    setLaughs(current => [...current, { ...region, key, index: null, intensityScore: 0.5 }].sort((a, b) => a.start - b.start));
    setSelected(key);
    setFeedback("Laugh added.");
    setError("");
  }

  function resizeLaugh(key: number, edge: Edge, time: number) {
    setLaughs(current => {
      const index = current.findIndex(laugh => laugh.key === key);
      if (index === -1) return current;
      const updated = retimeLaughMark(current, index, edge, time, bounds)[index];
      if (updated.start >= updated.end) return current;
      return current.map((laugh, other) => other === index ? { ...laugh, ...updated } : laugh);
    });
    setError("");
  }

  function pointerTime(event: PointerEvent<HTMLDivElement>, range: { windowStart: number; windowEnd: number }) {
    const rect = event.currentTarget.getBoundingClientRect();
    const fraction = clampTime((event.clientX - rect.left) / rect.width, 0, 1);
    const raw = range.windowStart + fraction * (range.windowEnd - range.windowStart);
    return clampTime(Math.round(raw * 1000) / 1000, Math.max(0, range.windowStart), Math.min(duration, range.windowEnd));
  }

  function beginDrag(event: PointerEvent<HTMLDivElement>) {
    if (saving || !event.isPrimary || event.button !== 0 ||
        (event.target as HTMLElement).closest("[data-delete], [data-padding]")) return;
    const target = (event.target as HTMLElement).closest<HTMLElement>("[data-laugh]");
    const key = target ? Number(target.dataset.laugh) : null;
    const region = laughs.find(laugh => laugh.key === key);
    const edge = (event.target as HTMLElement).closest<HTMLElement>("[data-edge]")?.dataset.edge as Edge | undefined;
    if ((!region || edge) && !canMark) return;
    const range = { windowStart, windowEnd };
    const action: Drag["action"] = !region ? null : edge
      ? { kind: "resize", key: region.key, edge, boundary: region[edge] }
      : { kind: "intensity", key: region.key, score: region.intensityScore, x: event.clientX, y: event.clientY, adjusting: false };
    drag.current = { origin: pointerTime(event, range), ...range, action };
    setDragWindow(windowStart);
    if (region) setSelected(region.key);
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function moveDrag(event: PointerEvent<HTMLDivElement>, finish = false) {
    const moving = drag.current;
    if (!moving || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    const time = pointerTime(event, moving);
    const action = moving.action;
    if (action?.kind === "resize") {
      resizeLaugh(action.key, action.edge, action.boundary + (time - moving.origin));
    } else if (!action) {
      const creating = Math.abs(time - moving.origin) >= handleStep;
      const candidate = creating ? constrainLaughMark(moving.origin, time, bounds, laughs) : null;
      if (!finish) setPreview(candidate);
      else if (creating) addLaugh(candidate);
      else seekToLine(time);
    } else {
      const delta = action.y - event.clientY;
      if (Math.abs(delta) >= 4 && Math.abs(delta) >= Math.abs(event.clientX - action.x)) action.adjusting = true;
      if (action.adjusting) {
        const height = event.currentTarget.clientHeight;
        changeIntensity(action.key, delta === 0 ? action.score : intensityPercent(action.score + delta / height) / 100);
      } else if (finish && canSeek) {
        seek(time);
      }
    }
    if (finish) clearDrag();
  }

  function clearDrag() {
    drag.current = null;
    setPreview(null);
    setDragWindow(null);
  }

  function cancelDrag() {
    const action = drag.current?.action;
    if (action?.kind === "resize") resizeLaugh(action.key, action.edge, action.boundary);
    if (action?.kind === "intensity" && action.adjusting) changeIntensity(action.key, action.score);
    if (drag.current) clearDrag();
  }

  function markStart() {
    if (!canMark) return;
    setMark(currentTime);
    setFeedback(`Start marked at ${preciseTime(currentTime)}.`);
  }

  function markEnd() {
    if (!canMark || mark === null) return;
    addLaugh(constrainLaughMark(mark, currentTime, bounds, laughs));
    setMark(null);
    startButton.current?.focus();
  }

  function keyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (event.repeat || event.altKey || event.ctrlKey || event.metaKey ||
        (event.target as HTMLElement).closest("input,textarea,[contenteditable],[role=slider]")) return;
    if (event.key.toLowerCase() === "i") markStart();
    else if (event.key.toLowerCase() === "o") markEnd();
    else if (event.key === " " && !(event.target as HTMLElement).closest("button")) togglePlayback();
    else return;
    event.preventDefault();
  }

  async function save() {
    if (saving || mark !== null || drag.current) return;
    if (textEdits.some(edit => !edit.text)) {
      setError("Each Line needs at least one word.");
      return;
    }
    pausePlayback();
    setSaving(true);
    setError("");
    try {
      const result = await saveBreakdown({
        setId: props.setId,
        breakdownId: props.breakdownId,
        editRevision: props.editRevision,
        textEdits,
        ...(laughsChanged && { laughs: laughs.map(({ index, start, end, intensityScore }) => ({ index, start, end, intensityScore })) }),
      });
      if (result === "saved") props.onClose(currentTime);
      else {
        setStale(true);
        setError("This Breakdown changed while you were editing. Reopen the editor to load the latest version.");
      }
    } catch (failure) {
      setError(getErrorMessageForCode(toAppError(failure).code));
    } finally {
      setSaving(false);
    }
  }

  const mediaMessage = status === "error" ? "Playback couldn’t load." :
    status === "buffering" ? "Buffering…" : !props.source ? "Playback unavailable." :
    !canSeek ? "Preparing playback…" : "";

  return (
    <Dialog open onOpenChange={open => { if (!open && !saving) props.onClose(); }}>
      <DialogContent
        className={styles.dialog}
        onKeyDown={keyboard}
        onOpenAutoFocus={event => { event.preventDefault(); titleRef.current?.focus(); }}
        onCloseAutoFocus={event => { event.preventDefault(); props.trigger.current?.focus(); }}
        onInteractOutside={event => event.preventDefault()}
        onEscapeKeyDown={event => { if (saving) event.preventDefault(); }}
      >
        <DialogHeader className="shrink-0 bg-tf-paper py-3 pr-14">
          <DialogTitle ref={titleRef} tabIndex={-1} className="text-lg sm:text-2xl">Edit transcript/timings</DialogTitle>
          <DialogDescription className="normal-case tracking-normal">{props.title}</DialogDescription>
        </DialogHeader>
        <div className={styles.workspace}>
          <section className="grid min-w-0 content-start gap-2" aria-label="Playback and laugh timings">
            <div className={styles.player}>
              <video ref={attachMedia} playsInline preload="auto" onClick={togglePlayback}
                className="size-full object-contain" />
              {mediaMessage && <div className={styles.mediaMessage}>
                <p role="status">{mediaMessage}</p>
                {status === "error" && <Button size="sm" onClick={retryPlayback}>Retry playback</Button>}
              </div>}
            </div>
            <div className="grid grid-cols-[auto_auto_minmax(0,1fr)] items-center gap-2">
              <Button size="sm" variant="outline" disabled={!canSeek} onClick={togglePlayback}>
                {playing ? <Pause /> : <Play />} {playing ? "Pause" : "Play"}
              </Button>
              <output aria-hidden="true" className="font-mono text-xs">{preciseTime(currentTime)}</output>
              <input type="range" aria-label="Set playback position" aria-valuetext={preciseTime(currentTime)}
                min={0} max={duration} step="any" value={currentTime} disabled={!canSeek}
                className="w-full accent-tf-blue" onChange={event => seekToLine(event.currentTarget.valueAsNumber)} />
            </div>
            <section className="min-w-0 border-tf bg-white p-2" aria-labelledby="edit-laugh-timings">
              <div className="mb-2 grid grid-cols-[minmax(0,auto)_minmax(2.75rem,1fr)_auto] items-center gap-1 sm:gap-2">
                <h3 id="edit-laugh-timings" className={styles.heading}>
                  Laugh timings
                  {selectedLaugh && <> <span aria-hidden="true" className="font-mono font-normal tracking-normal" title="Selected laugh intensity">
                    {intensityPercent(selectedLaugh.intensityScore)}%
                  </span></>}
                </h3>
                <label className={styles.zoom}>
                  <span>Zoom</span>
                  <input type="range" min={0} max={zoomSliderSteps} step={1}
                    value={zoomPosition} disabled={saving || dragWindow !== null || zoomFactor === 1}
                    aria-valuetext={`${Number(windowLength.toFixed(2))} seconds per window`}
                    onChange={event => {
                      const position = event.currentTarget.valueAsNumber / zoomSliderSteps;
                      const nextLength = maxWindowLength / zoomFactor ** position;
                      setZoom(zoomTimingWindow(currentTime, windowStart, windowLength, nextLength));
                    }} />
                </label>
                <div className="flex items-center gap-1">
                  <Button variant="outline" size="sm" className="px-1.5 sm:px-2" aria-label="Previous timeline window"
                    disabled={!canSeek || dragWindow !== null || !timeline.hasPrevious}
                    onClick={() => seekToLine(windowStart - windowLength)}>
                    <ArrowLeft />
                  </Button>
                  <output className="font-mono text-xs">{formatReviewTime(playableStart)}–{formatReviewTime(playableEnd)}</output>
                  <Button variant="outline" size="sm" className="px-1.5 sm:px-2" aria-label="Next timeline window"
                    disabled={!canSeek || dragWindow !== null || !timeline.hasNext}
                    onClick={() => seekToLine(windowEnd)}>
                    <ArrowRight />
                  </Button>
                </div>
              </div>
              <div className={styles.strip} role="group" aria-label="Laugh timeline"
                onPointerDown={beginDrag} onPointerMove={event => moveDrag(event)}
                onPointerUp={event => moveDrag(event, true)} onLostPointerCapture={cancelDrag}>
                {windowStart < 0 && <span aria-hidden="true" data-padding className={styles.padding}
                  style={{ left: 0, width: `${percent(0)}%` }} />}
                {windowEnd > duration && <span aria-hidden="true" data-padding className={styles.padding}
                  style={{ left: `${percent(duration)}%`, right: 0 }} />}
                {laughs.map((laugh, index) => {
                  if (laugh.end <= playableStart || laugh.start >= playableEnd) return null;
                  const intensity = intensityPercent(laugh.intensityScore);
                  const left = percent(Math.max(playableStart, laugh.start));
                  const right = percent(Math.min(playableEnd, laugh.end));
                  const leftGap = left - percent(laughs[index - 1]?.end ?? playableStart);
                  const rightGap = percent(laughs[index + 1]?.start ?? playableEnd) - right;
                  return <div key={laugh.key} data-laugh={laugh.key} data-selected={laugh.key === selected}
                    className={styles.laugh} style={{ left: `${left}%`, width: `${right - left}%` }}>
                    <div role="slider" tabIndex={saving ? -1 : 0} className={styles.intensity}
                      aria-label={`Laugh intensity at ${preciseTime(laugh.start)}`} aria-orientation="vertical"
                      aria-valuemin={0} aria-valuemax={100} aria-valuenow={intensity} aria-valuetext={`${intensity}%`}
                      aria-disabled={saving} onFocus={() => setSelected(laugh.key)}
                      onKeyDown={event => intensityKey(event, laugh)}>
                      <span className={styles.intensityFill}
                        style={{ height: `${intensity}%`, color: laughIntensityColor(laugh.intensityScore) }} />
                    </div>
                    <button type="button" data-delete disabled={saving} className={styles.trash}
                      data-side={leftGap > rightGap ? "left" : "right"}
                      aria-label={`Remove laugh ${index + 1} at ${preciseTime(laugh.start)}`}
                      onClick={() => {
                        setLaughs(current => current.filter(item => item.key !== laugh.key));
                        if (selected === laugh.key) setSelected(null);
                        setFeedback("Laugh removed.");
                        setError("");
                        startButton.current?.focus();
                      }}><Trash2 size={14} aria-hidden="true" /></button>
                    {(["start", "end"] as const).map(edge => laugh[edge] >= playableStart && laugh[edge] <= playableEnd &&
                      <button key={edge} type="button" data-edge={edge} className={styles.handle} disabled={!canMark}
                        aria-label={`Resize laugh ${index + 1} ${edge}`} aria-keyshortcuts="ArrowLeft ArrowRight"
                        onFocus={() => setSelected(laugh.key)}
                        onKeyDown={event => {
                          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                          event.preventDefault();
                          const change = (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 0.25 : handleStep);
                          resizeLaugh(laugh.key, edge, laugh[edge] + change);
                        }} />)}
                  </div>;
                })}
                {preview && <div className={styles.preview}
                  style={{ left: `${percent(preview.start)}%`, width: `${percent(preview.end) - percent(preview.start)}%` }} />}
                {(dragWindow === null || (currentTime >= windowStart && currentTime <= windowEnd)) &&
                  <span className={styles.playhead} style={{ left: `${percent(currentTime)}%` }} />}
              </div>
              {props.lines.length > 0 && <p className="my-2 text-xs text-tf-ink-soft">Drag to add or resize. Drag laughs up/down for intensity.</p>}
              <div className="flex items-center gap-1 sm:gap-2">
                <Button ref={startButton} size="sm" variant="outline" className={styles.markButton}
                  disabled={!canMark} aria-keyshortcuts="I" onClick={markStart}>Start laugh (I)</Button>
                <Button size="sm" variant="outline" className={styles.markButton}
                  disabled={!canMark || mark === null} aria-keyshortcuts="O" onClick={markEnd}>End laugh (O)</Button>
                <Button size="sm" variant="outline" className={`ml-auto ${styles.markButton}`}
                  disabled={!canSeek || !jumpTo}
                  onClick={() => { if (jumpTo) { seek(jumpTo.start); setSelected(jumpTo.key); } }}>Jump to laugh</Button>
              </div>
              <div className="mt-1 flex items-center gap-2 empty:hidden">
                {feedback && <p className="text-xs text-tf-ink-soft" role="status">{feedback}</p>}
                {mark !== null && <Button size="sm" variant="outline" className={styles.markButton}
                  onClick={() => { setMark(null); setFeedback("Start cleared."); }}>Clear start</Button>}
              </div>
            </section>
          </section>
          <section className={styles.transcript} aria-labelledby="edit-transcript">
            <h3 id="edit-transcript" className={`${styles.heading} border-b border-tf-ink bg-tf-paper-alt p-2`}>Transcript</h3>
            <TranscriptFields lines={props.lines} words={words} active={activeLine?.index} canSeek={canSeek}
              playing={playing} saving={saving} seek={seekToLine} changeWords={changeWords} />
          </section>
        </div>
        <DialogFooter className="shrink-0 border-t-2 border-tf-ink px-3 py-2">
          {(error || mergesLaughs) && <p className="mr-auto text-sm" role={error ? "alert" : "status"}>
            {error || "Laughs that start on the same Line will be combined when you save."}
          </p>}
          <Button type="button" size="sm" variant="outline" disabled={saving} onClick={() => props.onClose()}>Cancel</Button>
          <Button type="button" size="sm" disabled={saving || stale || mark !== null || (!textEdits.length && !laughsChanged)}
            onClick={() => void save()}>{saving ? "Saving…" : "Apply changes"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

const TranscriptFields = memo(function TranscriptFields({ lines, words, active, canSeek, playing, saving, seek, changeWords }: {
  lines: TranscriptSentence[];
  words: Record<number, string>;
  active: number | undefined;
  canSeek: boolean;
  playing: boolean;
  saving: boolean;
  seek: (time: number) => void;
  changeWords: (index: number, text: string) => void;
}) {
  const paneRef = useRef<HTMLDivElement>(null);
  const activeRowRef = useRef<HTMLDivElement>(null);
  const [editing, setEditing] = useState(false);

  useLayoutEffect(() => {
    const pane = paneRef.current;
    const row = activeRowRef.current;
    if (!pane || !row || editing) return;
    const editingTranscript = () => {
      const focused = pane.ownerDocument.activeElement;
      return focused?.tagName === "TEXTAREA" && pane.contains(focused);
    };
    if (editingTranscript()) return;

    const start = pane.scrollTop;
    const top = start + row.getBoundingClientRect().top - pane.getBoundingClientRect().top;
    const distance = clampTime(top, 0, pane.scrollHeight - pane.clientHeight) - start;
    if (Math.abs(distance) < 1) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      pane.scrollTop = start + distance;
      return;
    }

    const startedAt = performance.now();
    const animate = (now: number) => {
      if (editingTranscript()) return;
      const progress = Math.min(1, (now - startedAt) / 220);
      pane.scrollTop = start + distance * (1 - (1 - progress) ** 3);
      if (progress < 1) frame = requestAnimationFrame(animate);
    };
    let frame = requestAnimationFrame(animate);
    return () => cancelAnimationFrame(frame);
  }, [active, editing, playing]);

  return <div ref={paneRef} className={styles.lines}>
    {!lines.length && <p className="p-2 text-sm">No spoken words found.</p>}
    {lines.map((line, index) => (
      <div key={line.index} ref={line.index === active ? activeRowRef : undefined}
        data-active={line.index === active} className={styles.line}>
        <Button variant="outline" size="sm" className="px-2 font-mono tracking-normal transition-none hover:translate-x-0 hover:translate-y-0 hover:shadow-none" disabled={!canSeek}
          aria-label={`Jump to Line ${index + 1} at ${formatReviewTime(line.start)}`} onClick={() => seek(line.start)}>
          {formatReviewTime(line.start)}
        </Button>
        <textarea
          aria-label={`Line ${index + 1} at ${formatReviewTime(line.start)}`}
          rows={line.text.length > 115 ? 4 : 2}
          value={words[line.index] ?? line.text}
          disabled={saving}
          onFocus={() => setEditing(true)}
          onBlur={() => setEditing(false)}
          onChange={event => changeWords(line.index, event.currentTarget.value)}
        />
      </div>
    ))}
  </div>;
});
