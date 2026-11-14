"use client";

// Throwaway prototype for comparing three Set review layouts on /sets/[setId].
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, Pause, Play } from "lucide-react";
import "./set-review-layout-prototype.css";

const variants = ["a", "b", "c"] as const;
export type ReviewVariant = (typeof variants)[number];

const names = {
  a: "Right transcript",
  b: "Full-width timeline",
  c: "Left transcript",
};

const sampleText = [
  "My landlord calls the apartment cozy.",
  "That means I can turn the oven off from bed.",
  "I wish that was an exaggeration.",
  "The listing said it had great natural light. It does, but only when the neighbour opens their fridge, so now I have a complicated relationship with their meal prep schedule.",
  "I asked if I could paint the walls.",
  "He said the walls were load-bearing emotionally.",
  "Anyway, the rent went up again.",
  "He said it was to keep pace with the market. I asked which market. Apparently the one where you sell both your kidneys and still need a guarantor.",
];

const sampleLines = Array.from({ length: 80 }, (_, index) => {
  const text = sampleText[index % sampleText.length];
  const start = index * 4;
  const score = [0, 0.65, 0.86, 0.48, 0, 0.94, 0, 0.77][index % 8];
  const laughStart = start + 1.1;
  const laughDuration = 0.4 + score * 2;
  return {
    index, start, end: start + 4, text,
    laugh_count: Number(score > 0),
    laugh_intensity_score: score,
    laughs: score ? [{
      index, start_time: laughStart, end_time: laughStart + laughDuration,
      duration: laughDuration, intensity_score: score,
    }] : [],
  };
});
function stamp(seconds: number) {
  const wholeSeconds = Math.floor(seconds);
  return `${Math.floor(wholeSeconds / 60)}:${String(wholeSeconds % 60).padStart(2, "0")}`;
}

function intensity(score: number) {
  return `hsl(348 ${40 + score * 40}% ${66 - score * 26}%)`;
}

export function SetReviewLayoutPrototype({
  variant: initialVariant,
}: {
  variant: ReviewVariant;
}) {
  const [variant, setVariant] = useState(initialVariant);
  const [follow, setFollow] = useState(true);
  const [strongest, setStrongest] = useState(false);
  const [sampleTime, setSampleTime] = useState(0);
  const [samplePlaying, setSamplePlaying] = useState(false);
  const transcript = useRef<HTMLDivElement>(null);
  const activeRow = useRef<HTMLButtonElement>(null);
  const lines = sampleLines;
  const segments = useMemo(() => lines.flatMap((line) => line.laughs)
    .sort((a, b) => a.start_time - b.start_time), [lines]);
  const duration = 320;
  const currentTime = sampleTime;
  const sampleEnded = sampleTime >= 320;
  const isPlaying = samplePlaying && !sampleEnded;
  const active = lines.findLast((line) => line.start <= currentTime)?.index;
  const currentLaugh = strongest
    ? lines.reduce<{ index: number; score: number } | undefined>((best, line) => {
        const laugh = line.laughs[0];
        if (laugh && laugh.start_time <= currentTime && currentTime < laugh.end_time
          && (!best || laugh.intensity_score > best.score)) {
          return { index: line.index, score: laugh.intensity_score };
        }
        return best;
      }, undefined)
    : undefined;
  const followed = currentLaugh?.index ?? active;
  const ordered = strongest
    ? [...lines].sort((a, b) =>
        Number(Boolean(b.laughs.length)) - Number(Boolean(a.laughs.length))
        || b.laugh_intensity_score - a.laugh_intensity_score
        || a.start - b.start)
    : lines;
  const previous = segments.findLast((laugh) => laugh.start_time < currentTime - 0.2);
  const next = segments.find((laugh) => laugh.start_time > currentTime + 0.2);

  useEffect(() => {
    if (!samplePlaying || sampleEnded) return;
    const timer = window.setInterval(() => {
      setSampleTime((time) => Math.min(time + 0.2, 320));
    }, 200);
    return () => window.clearInterval(timer);
  }, [samplePlaying, sampleEnded]);

  useEffect(() => {
    const list = transcript.current;
    const row = activeRow.current;
    if (!follow || !list || !row) return;
    list.scrollTop += row.getBoundingClientRect().top - list.getBoundingClientRect().top;
  }, [followed, follow, strongest, variant]);

  const cycle = useCallback((offset: number) => {
    const index = variants.indexOf(variant);
    const url = new URL(window.location.href);
    const nextVariant = variants[(index + offset + variants.length) % variants.length];
    url.searchParams.set("variant", nextVariant);
    window.history.replaceState(null, "", url);
    setVariant(nextVariant);
  }, [variant]);

  useEffect(() => {
    function onArrow(event: KeyboardEvent) {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
      if (event.target instanceof Element && event.target.closest("input, textarea, select, video, [contenteditable]")) return;
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        event.preventDefault();
        cycle(event.key === "ArrowLeft" ? -1 : 1);
      }
    }
    window.addEventListener("keydown", onArrow);
    return () => window.removeEventListener("keydown", onArrow);
  }, [cycle]);

  function playPause() {
    if (sampleEnded) setSampleTime(0);
    setSamplePlaying(!isPlaying);
  }

  const laughNav = (
    <div className="review-prototype-controls" aria-label="Laugh navigation">
      <button type="button" disabled={!previous} onClick={() => previous && setSampleTime(previous.start_time)}>Previous laugh</button>
      <button type="button" disabled={!next} onClick={() => next && setSampleTime(next.start_time)}>Next laugh</button>
    </div>
  );

  return (
    <main className="review-prototype-review" data-variant={variant}>
      <header className="review-prototype-heading">
        <h1>Late Show at the Corner Room</h1>
        <button type="button" disabled title="Reserved for the future transcript editor">Edit transcript/timings</button>
      </header>

      <div className="review-prototype-player">
        <div className="review-prototype-sample">Sample playback</div>
      </div>

      <section className="review-prototype-transport" aria-label="Playback and timeline">
        <div className="review-prototype-playback">
          <button type="button" aria-label={isPlaying ? "Pause" : "Play"} onClick={playPause}>
            {isPlaying ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <span className="review-prototype-time">{stamp(currentTime)} / {stamp(duration)}</span>
        </div>
        {variant !== "c" && laughNav}
        <div className="review-prototype-timeline">
          <div className="review-prototype-track" aria-hidden="true">
            {segments.map((laugh, index) => (
              <i key={index} style={{
                left: `${100 * laugh.start_time / duration}%`,
                width: `${100 * laugh.duration / duration}%`,
                background: intensity(laugh.intensity_score),
              }} />
            ))}
            <b style={{ left: `${100 * currentTime / duration}%` }} />
          </div>
          <input aria-label="Set timeline" type="range" min={0} max={duration} step={0.1}
            value={currentTime} onChange={(event) => setSampleTime(event.currentTarget.valueAsNumber)} />
        </div>
      </section>

      {variant === "c" && <div className="review-prototype-sideNav">{laughNav}</div>}

      <aside className="review-prototype-transcript" aria-label="Transcript">
        <header className="review-prototype-transcriptHeader">
          <h2>Transcript</h2>
          <div className="review-prototype-controls">
            <button type="button" aria-pressed={follow} onClick={() => setFollow(!follow)}>Follow playback</button>
            <button type="button" aria-pressed={strongest} onClick={() => setStrongest(!strongest)}>Strongest first</button>
          </div>
        </header>
        <div className="review-prototype-lines" data-follow={follow} ref={transcript}>
          {ordered.map((line, position) => {
            const laugh = line.laughs[0];
            return (
              <button className="review-prototype-line" type="button" key={line.index} aria-current={followed === line.index}
                ref={followed === line.index ? activeRow : undefined} onClick={() => setSampleTime(line.start)}>
                <span className="review-prototype-lineText">
                  {strongest && laugh && (
                    <span className="review-prototype-rank" aria-label={`Laugh rank ${position + 1}`}>#{position + 1}</span>
                  )}
                  {line.text}
                </span>
                <span className="review-prototype-bar" aria-hidden="true">
                  {laugh && <i style={{
                    width: `${Math.min(100, 100 * laugh.duration / Math.max(0.01, line.end - line.start))}%`,
                    background: intensity(laugh.intensity_score),
                  }} />}
                </span>
              </button>
            );
          })}
        </div>
      </aside>

      <nav className="review-prototype-switcher" aria-label="Prototype variants">
        <button type="button" aria-label="Previous layout" onClick={() => cycle(-1)}><ArrowLeft size={16} /></button>
        <span>{variant.toUpperCase()} · {names[variant]}</span>
        <button type="button" aria-label="Next layout" onClick={() => cycle(1)}><ArrowRight size={16} /></button>
      </nav>
    </main>
  );
}
