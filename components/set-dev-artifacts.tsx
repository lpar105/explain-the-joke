"use client";

import type { FunctionReturnType } from "convex/server";
import { useEffect, useMemo, useState } from "react";

import type { api } from "../convex/_generated/api";
import {
  type ManualInterval, type ScoreTrack, previewCalibratedRegions, validateCalibrationTrack, validateManualSample,
} from "../lib/calibration";
import { Button } from "./ui/button";
import styles from "./set-page-client.module.css";

export type SetArtifact = NonNullable<FunctionReturnType<typeof api.sets.listDevArtifacts>>[number];

export function artifactType(artifact: SetArtifact) {
  if (!artifact.url) return "unavailable";
  if (artifact.kind === "retainedMedia" || artifact.kind === "cleanedAudio") {
    return artifact.contentType?.startsWith("video/") || /\.(mp4|webm|mov)$/i.test(artifact.fileName) ? "video" : "audio";
  }
  if (artifact.kind === "playbackMedia") return "video";
  if (artifact.kind === "thumbnail") return "image";
  return "json";
}

function jsonUrl(setId: string, artifact: SetArtifact | undefined) {
  return artifact?.url ? `/sets/${encodeURIComponent(setId)}/dev/artifact?id=${encodeURIComponent(artifact.id)}` : null;
}

function useArtifactJson<T>(url: string | null) {
  const [response, setResponse] = useState<{ url: string; data?: T; failed?: true }>();
  useEffect(() => {
    if (!url) return;
    const controller = new AbortController();
    async function load() {
      if (!url) return;
      try {
        const result = await fetch(url, { signal: controller.signal });
        if (!result.ok) throw new Error("Artifact unavailable.");
        const data: T = await result.json();
        if (!controller.signal.aborted) setResponse({ url, data });
      } catch {
        if (!controller.signal.aborted) setResponse({ url, failed: true });
      }
    }
    void load();
    return () => controller.abort();
  }, [url]);
  return response?.url === url ? response : undefined;
}

export function SetArtifactPreview({ setId, artifact }: { setId: string; artifact: SetArtifact }) {
  const type = artifactType(artifact);
  const json = useArtifactJson<unknown>(type === "json" ? jsonUrl(setId, artifact) : null);
  const [imageFailed, setImageFailed] = useState(false);
  if (!artifact.url || imageFailed || json?.failed) {
    return <div className={styles.playerMessage}><p role="status" className={styles.artifactStatus}>Artifact unavailable.</p></div>;
  }
  if (type === "image") {
    // eslint-disable-next-line @next/next/no-img-element -- Artifacts use the deployment's storage hostname.
    return <img src={artifact.url} alt="Generated set thumbnail" onError={() => setImageFailed(true)} className="size-full object-contain" />;
  }
  if (!json) return <div className={styles.playerMessage}><p role="status" className={styles.artifactStatus}>Opening artifact…</p></div>;

  return <pre aria-label={artifact.fileName} tabIndex={0} className={styles.artifactJson}>{JSON.stringify(json.data, null, 2)}</pre>;
}

type CalibrationResult = {
  mode?: "manual-only" | "calibrated";
  threshold?: number;
  retainedMediaKey: string;
  retainedMediaSha256: string;
  input: { duration: number; sample: ManualInterval; intervals: ManualInterval[] };
};

export function useDevCutoff(setId: string, artifacts: SetArtifact[] | null | undefined) {
  const resultArtifact = artifacts?.find(artifact => artifact.kind === "calibrationResult" && artifact.isCurrentBreakdown);
  const resultUrl = jsonUrl(setId, resultArtifact);
  const result = useArtifactJson<CalibrationResult>(resultUrl);
  const threshold = result?.data?.threshold;
  const calibrated = typeof threshold === "number" && Number.isFinite(threshold) && threshold >= 0 ? threshold : null;
  const scoreArtifact = artifacts?.find(artifact => artifact.kind === "scoreTrack" && artifact.isCanonical &&
    artifact.isCurrentBreakdown && artifact.run === resultArtifact?.run);
  const scoreUrl = calibrated === null ? null : jsonUrl(setId, scoreArtifact);
  const score = useArtifactJson<ScoreTrack>(scoreUrl);
  const sourceKey = `${resultUrl ?? ""}/${scoreUrl ?? ""}`;
  const [override, setOverride] = useState<{ sourceKey: string; value: string } | null>(null);
  const input = override?.sourceKey === sourceKey ? override.value : null;
  const track = useMemo(() => {
    const data = result?.data;
    const track = score?.data;
    if (!data || !track || track.retainedMediaKey !== data.retainedMediaKey ||
      track.retainedMediaSha256 !== data.retainedMediaSha256) return null;
    try {
      validateCalibrationTrack(track, data.input.duration);
      const sample = validateManualSample(data.input.duration, data.input.intervals, data.input.sample.start);
      return { track, ...data.input, sample };
    } catch {
      return null;
    }
  }, [result, score]);
  const value = input === null || input.trim() === "" ? NaN : Number(input);
  const previewing = Boolean(track && Number.isFinite(value) && value >= 0 && value !== calibrated);
  const regions = useMemo(() => previewing && track ? previewCalibratedRegions({ ...track, threshold: value }) : null,
    [previewing, track, value]);
  const message = result?.data?.mode === "manual-only" ? "Manual marks only" :
    resultUrl && !result ? "Loading cutoff…" : "Unavailable";

  return {
    calibrated,
    input,
    message,
    canPreview: track !== null,
    previewMessage: scoreUrl && !score ? "Loading score track…" : "Score track unavailable",
    regions,
    setThreshold: (value: string) => setOverride({ sourceKey, value }),
    reset: () => setOverride(null),
  };
}

export function DevCutoffControls({ cutoff, onChange }: {
  cutoff: ReturnType<typeof useDevCutoff>;
  onChange: () => void;
}) {
  return (
    <div className={styles.cutoffControls}>
      <span>Calibrated cutoff <strong>{cutoff.calibrated ?? cutoff.message}</strong></span>
      {cutoff.calibrated !== null && (cutoff.canPreview ? (
        <>
          <label className="flex items-center gap-2">
            Preview cutoff
            <input type="number" min="0" step="any" className={styles.cutoffInput}
              value={cutoff.input ?? String(cutoff.calibrated)}
              onChange={(event) => {
                cutoff.setThreshold(event.currentTarget.value);
                onChange();
              }} />
          </label>
          <Button type="button" variant="outline" size="sm" className="h-7 px-2 tracking-normal"
            disabled={cutoff.input === null} onClick={() => { cutoff.reset(); onChange(); }}>Reset</Button>
          {cutoff.regions && <span role="status">Preview · {cutoff.regions.length} laugh regions</span>}
        </>
      ) : <span>{cutoff.previewMessage}</span>)}
    </div>
  );
}
