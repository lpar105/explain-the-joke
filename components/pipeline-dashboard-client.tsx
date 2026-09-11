"use client";

import Link from "next/link";
import { useQuery } from "convex/react";

import { api } from "../convex/_generated/api";
import UploadSetDialog from "./library/upload-set-dialog";
import {
  formatDuration,
  getBreakdownBadgeLabel,
  getBreakdownSummary,
  getSetStatusLabel,
} from "../lib/set-status";

type PipelineDashboardData = (typeof api.sets.getDevPipelineDashboard)["_returnType"];
type PipelineDashboardPayload = Exclude<PipelineDashboardData, null>;
type PipelineSet = PipelineDashboardPayload["sets"][number];
type PipelineIngestJob = NonNullable<PipelineSet["ingestJob"]>;
type PipelineStepName = PipelineIngestJob["stepAttempts"][number]["stepName"];

const PIPELINE_STEPS: Array<{
  description: string;
  label: string;
  name: PipelineStepName;
}> = [
  {
    name: "prepareRetainedMedia",
    label: "Prepare retained media",
    description: "Trims the retained clip and emits the retained media artifact.",
  },
  {
    name: "startBunnyPlaybackMigration",
    label: "Start Bunny playback migration",
    description: "Begins the persistent playback migration.",
  },
  {
    name: "awaitBunnyPlaybackReady",
    label: "Await Bunny playback ready",
    description: "Waits for the migrated playback asset to become available.",
  },
  {
    name: "cleanupMuxPlayback",
    label: "Cleanup temporary Mux playback",
    description: "Removes temporary playback once migration has succeeded.",
  },
  {
    name: "transcribeWords",
    label: "Transcribe words",
    description: "Runs the transcript worker and captures raw transcript output.",
  },
  {
    name: "normalizeLines",
    label: "Normalize lines",
    description: "Converts transcript output into editable line records.",
  },
  {
    name: "preprocessLaughAudio",
    label: "Preprocess laugh audio",
    description: "Prepares audio features for laugh detection.",
  },
  {
    name: "detectLaughCandidates",
    label: "Detect laugh candidates",
    description: "Runs laugh detection and produces candidate regions.",
  },
  {
    name: "normalizeLaughRegions",
    label: "Normalize laugh regions",
    description: "Converts detected regions into normalized laugh records.",
  },
];

function formatDateTime(timestamp: number | null | undefined) {
  if (!timestamp) {
    return "Not yet";
  }

  return new Intl.DateTimeFormat("en-NZ", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(timestamp);
}

function formatTrimRange(startSeconds: number, endSeconds: number) {
  return `${Math.floor(startSeconds / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(startSeconds % 60)
    .toString()
    .padStart(2, "0")} -> ${Math.floor(endSeconds / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(endSeconds % 60)
    .toString()
    .padStart(2, "0")}`;
}

function getPillClassName(tone: "neutral" | "good" | "warn" | "bad") {
  switch (tone) {
    case "good":
      return "border-[#1a1a1a] bg-[#e8f5ea] text-[#245b31]";
    case "warn":
      return "border-[#1a1a1a] bg-[#fff2db] text-[#8a5410]";
    case "bad":
      return "border-[#1a1a1a] bg-[#fff0f0] text-[#a61b32]";
    default:
      return "border-[#1a1a1a] bg-[#f0ede8] text-[#5a554f]";
  }
}

function getSetTone(status: "playbackPending" | "playable" | "unavailable") {
  switch (status) {
    case "playable":
      return "good";
    case "unavailable":
      return "bad";
    default:
      return "warn";
  }
}

function getAttemptTone(status: "pending" | "running" | "succeeded" | "failed") {
  switch (status) {
    case "succeeded":
      return "good";
    case "failed":
      return "bad";
    case "running":
      return "warn";
    default:
      return "neutral";
  }
}

function getAttemptStatusLabel(status: "pending" | "running" | "succeeded" | "failed") {
  switch (status) {
    case "succeeded":
      return "Complete";
    case "failed":
      return "Failed";
    case "running":
      return "Running";
    default:
      return "Pending";
  }
}

function getModalExecutionSignal(attempt: PipelineIngestJob["stepAttempts"][number]) {
  if (attempt.runner !== "modal") {
    return null;
  }

  if (attempt.status === "running" && attempt.modalFunctionCallId === null) {
    return {
      detail:
        "Convex has started this step, but Modal has not acknowledged the spawn yet.",
      label: "Waiting for Modal handoff",
      tone: "warn" as const,
    };
  }

  if (attempt.status === "running" && attempt.modalFunctionCallId !== null) {
    return {
      detail:
        "Modal returned a function call ID, so the worker was spawned and we are waiting for its callback.",
      label: "Running on Modal",
      tone: "good" as const,
    };
  }

  if (attempt.status === "succeeded") {
    return {
      detail:
        "The Modal worker called back successfully and this attempt completed.",
      label: "Modal callback received",
      tone: "good" as const,
    };
  }

  if (attempt.status === "failed") {
    return {
      detail:
        attempt.modalFunctionCallId === null
          ? "This attempt failed before Convex confirmed the Modal spawn."
          : "The Modal worker was spawned, but the attempt later failed or returned a failed callback.",
      label:
        attempt.modalFunctionCallId === null
          ? "Failed before Modal handoff"
          : "Failed after Modal handoff",
      tone: "bad" as const,
    };
  }

  return {
    detail: "This attempt has not started a Modal worker yet.",
    label: "Pending",
    tone: "neutral" as const,
  };
}

function getBreakdownTone(
  breakdown:
    | PipelineDashboardPayload["sets"][number]["breakdown"]
    | null,
): "neutral" | "good" | "warn" | "bad" {
  if (!breakdown) {
    return "neutral";
  }

  if (breakdown.lineSeedingState === "failed") {
    return "bad";
  }

  if (breakdown.editability === "editable") {
    return "good";
  }

  if (breakdown.laughSeedingState === "failed") {
    return "warn";
  }

  return "warn";
}

function SummaryCard({
  label,
  value,
  hint,
}: {
  hint: string;
  label: string;
  value: number;
}) {
  return (
    <div className="border-2 border-[#1a1a1a] bg-white p-4 shadow-[4px_4px_0px_0px_#1a1a1a]">
      <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-[#6d675f]">
        {label}
      </p>
      <p className="mt-3 text-3xl font-black tracking-tight text-[#1a1a1a]">
        {value}
      </p>
      <p className="mt-2 text-sm text-[#5a554f]">{hint}</p>
    </div>
  );
}

function ValueRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 border-b border-dashed border-[#c9c1b7] py-2 last:border-b-0">
      <dt className="font-mono text-[10px] uppercase tracking-[0.24em] text-[#6d675f]">
        {label}
      </dt>
      <dd className="break-all text-sm font-medium text-[#1a1a1a]">{value}</dd>
    </div>
  );
}

function formatStepName(stepName: PipelineStepName) {
  const step = PIPELINE_STEPS.find((candidate) => candidate.name === stepName);
  return step?.label ?? stepName;
}

function StepArtifactCard({
  artifact,
}: {
  artifact: PipelineIngestJob["artifacts"][number];
}) {
  return (
    <div className="border border-[#1a1a1a] bg-white p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={`inline-flex items-center border px-2 py-1 text-[10px] font-black uppercase tracking-[0.18em] ${getPillClassName(
            artifact.isCanonical ? "good" : "neutral",
          )}`}
        >
          {artifact.isCanonical ? "Canonical" : "Non-Canonical"}
        </span>
        <span className="text-sm font-black uppercase tracking-tight text-[#1a1a1a]">
          {artifact.kind}
        </span>
      </div>
      <dl className="mt-2 grid gap-1">
        <ValueRow label="Artifact ID" value={artifact._id} />
        <ValueRow label="File Name" value={artifact.fileName} />
        <ValueRow label="Path" value={artifact.path} />
        <ValueRow
          label="Content Type"
          value={artifact.contentType ?? "Unknown"}
        />
        <ValueRow
          label="Size"
          value={artifact.size === null ? "Unknown" : `${artifact.size} bytes`}
        />
        <ValueRow label="Expires" value={formatDateTime(artifact.expiresAt)} />
        <ValueRow
          label="Created By Attempt"
          value={artifact.createdByAttemptId ?? "Unknown"}
        />
      </dl>
    </div>
  );
}

function PipelineProgressSection({
  ingestJob,
}: {
  ingestJob: PipelineSet["ingestJob"];
}) {
  if (!ingestJob) {
    return (
      <div className="border-2 border-[#1a1a1a] bg-[#fcfbf9] p-4">
        <h3 className="text-lg font-black uppercase tracking-tight text-[#1a1a1a]">
          Pipeline Progress
        </h3>
        <p className="mt-3 text-sm text-[#5a554f]">
          No ingest job is attached to this Set yet.
        </p>
      </div>
    );
  }

  const completedStepCount = PIPELINE_STEPS.filter((step) => {
    const matchingAttempts = ingestJob.stepAttempts
      .filter((attempt) => attempt.stepName === step.name)
      .sort((left, right) => right.attemptNumber - left.attemptNumber);
    return matchingAttempts[0]?.status === "succeeded";
  }).length;
  const progressPercent = Math.round(
    (completedStepCount / Math.max(PIPELINE_STEPS.length, 1)) * 100,
  );

  return (
    <div className="border-2 border-[#1a1a1a] bg-[#fcfbf9] p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-black uppercase tracking-tight text-[#1a1a1a]">
            Pipeline Progress
          </h3>
          <p className="mt-1 text-sm text-[#5a554f]">
            {completedStepCount} of {PIPELINE_STEPS.length} ingest steps complete.
          </p>
        </div>
        <div className="border border-[#1a1a1a] bg-white px-3 py-2">
          <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-[#6d675f]">
            Job Status
          </p>
          <p className="mt-1 text-sm font-black uppercase tracking-tight text-[#1a1a1a]">
            {ingestJob.status}
          </p>
        </div>
      </div>

      <div className="mt-4 h-3 overflow-hidden border-2 border-[#1a1a1a] bg-[#e3ddd6]">
        <div
          className="h-full bg-[#1a3a52] transition-[width]"
          style={{ width: `${progressPercent}%` }}
        />
      </div>

      <div className="mt-4 grid gap-3">
        {PIPELINE_STEPS.map((step) => {
          const attempts = ingestJob.stepAttempts
            .filter((attempt) => attempt.stepName === step.name)
            .sort((left, right) => right.attemptNumber - left.attemptNumber);
          const latestAttempt = attempts[0] ?? null;
          const artifacts = ingestJob.artifacts.filter(
            (artifact) => artifact.stepName === step.name,
          );
          const stepStatus = latestAttempt?.status ?? "pending";

          return (
            <details
              key={step.name}
              className="border border-[#1a1a1a] bg-white"
              open={stepStatus === "running" || stepStatus === "failed"}
            >
              <summary className="cursor-pointer list-none p-0">
                <div className="grid gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_auto_auto_auto] lg:items-center">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <span
                        className={`inline-flex items-center border px-2 py-1 text-[10px] font-black uppercase tracking-[0.18em] ${getPillClassName(
                          getAttemptTone(stepStatus),
                        )}`}
                      >
                        {getAttemptStatusLabel(stepStatus)}
                      </span>
                      <span className="text-sm font-black uppercase tracking-tight text-[#1a1a1a]">
                        {step.label}
                      </span>
                    </div>
                    <p className="mt-2 text-sm text-[#5a554f]">{step.description}</p>
                  </div>

                  <div className="text-sm text-[#1a1a1a]">
                    <span className="font-black">Attempts:</span> {attempts.length}
                  </div>
                  <div className="text-sm text-[#1a1a1a]">
                    <span className="font-black">Artifacts:</span> {artifacts.length}
                  </div>
                  <div className="text-sm text-[#1a1a1a]">
                    <span className="font-black">Last update:</span>{" "}
                    {formatDateTime(
                      latestAttempt?.finishedAt ?? latestAttempt?.startedAt ?? null,
                    )}
                  </div>
                </div>
              </summary>

              <div className="grid gap-4 border-t border-[#1a1a1a] p-3 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <div>
                  <h4 className="font-mono text-[10px] uppercase tracking-[0.24em] text-[#6d675f]">
                    Attempts
                  </h4>
                  <div className="mt-2 grid gap-3">
                    {attempts.length > 0 ? (
                      attempts.map((attempt) => (
                        <div
                          key={attempt._id}
                          className="border border-[#1a1a1a] bg-[#fcfbf9] p-3"
                        >
                          <div className="flex flex-wrap items-center gap-2">
                            <span
                              className={`inline-flex items-center border px-2 py-1 text-[10px] font-black uppercase tracking-[0.18em] ${getPillClassName(
                                getAttemptTone(attempt.status),
                              )}`}
                            >
                              {attempt.status}
                            </span>
                            <span className="text-sm font-black uppercase tracking-tight text-[#1a1a1a]">
                              Attempt {attempt.attemptNumber}
                            </span>
                          </div>
                          {(() => {
                            const modalSignal = getModalExecutionSignal(attempt);

                            return modalSignal ? (
                              <div
                                className={`mt-3 border px-3 py-2 text-sm ${getPillClassName(
                                  modalSignal.tone,
                                )}`}
                              >
                                <p className="font-black uppercase tracking-tight">
                                  {modalSignal.label}
                                </p>
                                <p className="mt-1 text-[#1a1a1a]">
                                  {modalSignal.detail}
                                </p>
                              </div>
                            ) : null;
                          })()}
                          <dl className="mt-2 grid gap-1">
                            <ValueRow label="Runner" value={attempt.runner} />
                            <ValueRow
                              label="Started"
                              value={formatDateTime(attempt.startedAt)}
                            />
                            <ValueRow
                              label="Finished"
                              value={formatDateTime(attempt.finishedAt)}
                            />
                            <ValueRow
                              label="Workflow Event"
                              value={attempt.workflowEventName ?? "None"}
                            />
                            <ValueRow
                              label="Modal Call ID"
                              value={attempt.modalFunctionCallId ?? "None yet"}
                            />
                            <ValueRow
                              label="Failure Code"
                              value={attempt.failureCode ?? "None"}
                            />
                            <ValueRow
                              label="Failure Detail"
                              value={attempt.failureDetail ?? "None"}
                            />
                          </dl>
                        </div>
                      ))
                    ) : (
                      <p className="text-sm text-[#5a554f]">
                        This step has not started yet.
                      </p>
                    )}
                  </div>
                </div>

                <div>
                  <h4 className="font-mono text-[10px] uppercase tracking-[0.24em] text-[#6d675f]">
                    Artifacts
                  </h4>
                  <div className="mt-2 grid gap-3">
                    {artifacts.length > 0 ? (
                      artifacts.map((artifact) => (
                        <StepArtifactCard key={artifact._id} artifact={artifact} />
                      ))
                    ) : (
                      <p className="text-sm text-[#5a554f]">
                        No artifacts have been recorded for this step yet.
                      </p>
                    )}
                  </div>
                </div>
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
}

function PipelineSetCard({
  pipelineSet,
}: {
  pipelineSet: PipelineSet;
}) {
  const retainedDurationSeconds = Math.max(
    0,
    pipelineSet.trimRangeEndSeconds - pipelineSet.trimRangeStartSeconds,
  );
  const breakdownTone = getBreakdownTone(pipelineSet.breakdown);
  const shouldOpen =
    pipelineSet.setStatus !== "playable" ||
    pipelineSet.breakdown?.lineSeedingState === "failed" ||
    pipelineSet.ingestJob?.status === "running" ||
    pipelineSet.ingestJob?.status === "failed";

  return (
    <details
      className="border-2 border-[#1a1a1a] bg-white shadow-[6px_6px_0px_0px_#1a1a1a]"
      open={shouldOpen}
    >
      <summary className="cursor-pointer list-none p-0">
        <div className="grid gap-4 border-b-2 border-[#1a1a1a] bg-[#f7f3ee] p-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-start">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-[#6d675f]">
                Set Pipeline
              </p>
              <span
                className={`inline-flex items-center border px-2 py-1 text-[10px] font-black uppercase tracking-[0.18em] ${getPillClassName(
                  getSetTone(pipelineSet.setStatus),
                )}`}
              >
                {getSetStatusLabel(pipelineSet.setStatus)}
              </span>
              {pipelineSet.breakdown ? (
                <span
                  className={`inline-flex items-center border px-2 py-1 text-[10px] font-black uppercase tracking-[0.18em] ${getPillClassName(
                    breakdownTone,
                  )}`}
                >
                  {getBreakdownBadgeLabel(
                    pipelineSet.breakdown.editability,
                    pipelineSet.breakdown.lineSeedingState,
                    pipelineSet.breakdown.laughSeedingState,
                  )}
                </span>
              ) : null}
            </div>

            <div className="mt-3 flex flex-wrap items-center gap-3">
              <h2 className="text-2xl font-black uppercase tracking-tight text-[#1a1a1a] md:text-3xl">
                {pipelineSet.title}
              </h2>
              <Link
                href={`/sets/${pipelineSet._id}`}
                className="inline-flex items-center border-2 border-[#1a1a1a] bg-white px-3 py-2 text-[10px] font-black uppercase tracking-[0.18em] text-[#1a1a1a] hover:-translate-x-1 hover:-translate-y-1 hover:bg-[#f0ede8] hover:shadow-[4px_4px_0px_0px_#1a1a1a]"
              >
                Open Set
              </Link>
            </div>

            <p className="mt-2 text-sm text-[#5a554f]">
              {pipelineSet.breakdown
                ? getBreakdownSummary(
                    pipelineSet.breakdown.editability,
                    pipelineSet.breakdown.lineSeedingState,
                    pipelineSet.breakdown.laughSeedingState,
                  )
                : "This Set has no current Breakdown shell yet."}
            </p>
          </div>

          <div className="grid min-w-[240px] gap-2 border-2 border-[#1a1a1a] bg-white p-3">
            <ValueRow label="Retained Duration" value={formatDuration(retainedDurationSeconds)} />
            <ValueRow
              label="Trim Range"
              value={formatTrimRange(
                pipelineSet.trimRangeStartSeconds,
                pipelineSet.trimRangeEndSeconds,
              )}
            />
            <ValueRow label="Lines" value={pipelineSet.lineCount} />
            <ValueRow label="Laugh Regions" value={pipelineSet.laughRegionCount} />
          </div>
        </div>
      </summary>

      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <section className="grid gap-4">
          <div className="border-2 border-[#1a1a1a] bg-[#fcfbf9] p-4">
            <h3 className="text-lg font-black uppercase tracking-tight text-[#1a1a1a]">
              Set and Breakdown
            </h3>
            <dl className="mt-3 grid gap-1">
              <ValueRow label="Set ID" value={pipelineSet._id} />
              <ValueRow
                label="Created"
                value={formatDateTime(pipelineSet._creationTime)}
              />
              <ValueRow label="Set Status" value={pipelineSet.setStatus} />
              <ValueRow
                label="Active Playback Provider"
                value={pipelineSet.activePlaybackSource?.provider ?? "None"}
              />
              <ValueRow
                label="Active Playback Kind"
                value={pipelineSet.activePlaybackSource?.kind ?? "None"}
              />
              {pipelineSet.breakdown ? (
                <>
                  <ValueRow label="Breakdown ID" value={pipelineSet.breakdown._id} />
                  <ValueRow
                    label="Editability"
                    value={pipelineSet.breakdown.editability}
                  />
                  <ValueRow
                    label="Line Path"
                    value={pipelineSet.breakdown.lineSeedingState}
                  />
                  <ValueRow
                    label="Laugh Path"
                    value={pipelineSet.breakdown.laughSeedingState}
                  />
                  <ValueRow
                    label="Line Failure"
                    value={pipelineSet.breakdown.lineFailureCode ?? "None"}
                  />
                  <ValueRow
                    label="Line Failure Detail"
                    value={pipelineSet.breakdown.lineFailureDetail ?? "None"}
                  />
                  <ValueRow
                    label="Laugh Failure"
                    value={pipelineSet.breakdown.laughFailureCode ?? "None"}
                  />
                  <ValueRow
                    label="Laugh Failure Detail"
                    value={pipelineSet.breakdown.laughFailureDetail ?? "None"}
                  />
                </>
              ) : null}
            </dl>
          </div>

          <div className="border-2 border-[#1a1a1a] bg-[#fcfbf9] p-4">
            <h3 className="text-lg font-black uppercase tracking-tight text-[#1a1a1a]">
              Upload Session
            </h3>
            {pipelineSet.uploadSession ? (
              <dl className="mt-3 grid gap-1">
                <ValueRow label="Upload Session ID" value={pipelineSet.uploadSession._id} />
                <ValueRow label="Status" value={pipelineSet.uploadSession.status} />
                <ValueRow
                  label="Original File"
                  value={pipelineSet.uploadSession.originalFileName}
                />
                <ValueRow
                  label="Mux Upload ID"
                  value={pipelineSet.uploadSession.muxUploadId}
                />
                <ValueRow
                  label="Mux Asset ID"
                  value={pipelineSet.uploadSession.muxAssetId ?? "Not yet"}
                />
                <ValueRow
                  label="Mux Playback ID"
                  value={pipelineSet.uploadSession.muxPlaybackId ?? "Not yet"}
                />
                <ValueRow
                  label="Duration"
                  value={
                    pipelineSet.uploadSession.durationSeconds === null
                      ? "Not yet"
                      : formatDuration(pipelineSet.uploadSession.durationSeconds)
                  }
                />
                <ValueRow
                  label="Failure Code"
                  value={pipelineSet.uploadSession.failureCode ?? "None"}
                />
              </dl>
            ) : (
              <p className="mt-3 text-sm text-[#5a554f]">
                No matching confirmed upload session was found for this Set.
              </p>
            )}
          </div>

          <div className="border-2 border-[#1a1a1a] bg-[#fcfbf9] p-4">
            <h3 className="text-lg font-black uppercase tracking-tight text-[#1a1a1a]">
              Playback Sources
            </h3>
            <div className="mt-3 grid gap-3">
              {pipelineSet.playbackSources.map((playbackSource) => (
                <div
                  key={playbackSource._id}
                  className="border border-[#1a1a1a] bg-white p-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`inline-flex items-center border px-2 py-1 text-[10px] font-black uppercase tracking-[0.18em] ${getPillClassName(
                        playbackSource.isActive ? "good" : "neutral",
                      )}`}
                    >
                      {playbackSource.isActive ? "Active" : "Inactive"}
                    </span>
                    <span className="text-sm font-black uppercase tracking-tight text-[#1a1a1a]">
                      {playbackSource.provider} / {playbackSource.kind}
                    </span>
                  </div>
                  <dl className="mt-2 grid gap-1">
                    <ValueRow label="Playback Source ID" value={playbackSource._id} />
                    <ValueRow
                      label="Provider Asset ID"
                      value={playbackSource.providerAssetId}
                    />
                    <ValueRow label="Playback ID" value={playbackSource.playbackId} />
                    <ValueRow
                      label="Provider Upload ID"
                      value={playbackSource.providerUploadId ?? "None"}
                    />
                  </dl>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="grid gap-4">
          <div className="border-2 border-[#1a1a1a] bg-[#fcfbf9] p-4">
            <h3 className="text-lg font-black uppercase tracking-tight text-[#1a1a1a]">
              Ingest Job
            </h3>
            {pipelineSet.ingestJob ? (
              <>
                <dl className="mt-3 grid gap-1">
                  <ValueRow label="Ingest Job ID" value={pipelineSet.ingestJob._id} />
                  <ValueRow label="Status" value={pipelineSet.ingestJob.status} />
                  <ValueRow
                    label="Workflow ID"
                    value={pipelineSet.ingestJob.workflowId ?? "Not attached"}
                  />
                  <ValueRow
                    label="Active Migration Step"
                    value={
                      pipelineSet.ingestJob.activePlaybackMigrationStep
                        ? formatStepName(
                            pipelineSet.ingestJob.activePlaybackMigrationStep,
                          )
                        : "None"
                    }
                  />
                  <ValueRow
                    label="Completed"
                    value={formatDateTime(pipelineSet.ingestJob.completedAt)}
                  />
                  <ValueRow
                    label="Failed"
                    value={formatDateTime(pipelineSet.ingestJob.failedAt)}
                  />
                </dl>

                <div className="mt-4">
                  <PipelineProgressSection ingestJob={pipelineSet.ingestJob} />
                </div>
              </>
            ) : (
              <p className="mt-3 text-sm text-[#5a554f]">
                No ingest job is attached to this Set yet.
              </p>
            )}
          </div>
        </section>
      </div>
    </details>
  );
}

export default function PipelineDashboardClient() {
  const dashboard = useQuery(api.sets.getDevPipelineDashboard, {});

  if (dashboard === undefined) {
    return (
      <main className="min-h-[calc(100vh-4.5rem)] bg-[#faf8f5] px-4 py-5 text-[#1a1a1a] md:px-6">
        <div className="mx-auto grid max-w-7xl gap-4">
          <div className="border-2 border-[#1a1a1a] bg-white p-6 shadow-[6px_6px_0px_0px_#1a1a1a]">
            <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-[#6d675f]">
              Pipeline Dashboard
            </p>
            <div className="mt-4 h-8 w-56 animate-pulse bg-[#ece7e1]" />
            <div className="mt-3 h-4 w-80 animate-pulse bg-[#f2efeb]" />
          </div>
        </div>
      </main>
    );
  }

  if (dashboard === null) {
    return (
      <main className="min-h-[calc(100vh-4.5rem)] bg-[#faf8f5] px-4 py-5 text-[#1a1a1a] md:px-6">
        <div className="mx-auto max-w-3xl border-2 border-[#1a1a1a] bg-white p-6 shadow-[6px_6px_0px_0px_#1a1a1a]">
          <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-[#6d675f]">
            Restricted
          </p>
          <h1 className="mt-3 text-3xl font-black uppercase tracking-tight">
            This pipeline dashboard is not available for this account.
          </h1>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-[calc(100vh-4.5rem)] bg-[#faf8f5] px-4 py-5 text-[#1a1a1a] md:px-6">
      <div className="mx-auto grid max-w-7xl gap-6">
        <section className="border-2 border-[#1a1a1a] bg-white shadow-[6px_6px_0px_0px_#1a1a1a]">
          <div className="grid gap-4 border-b-2 border-[#1a1a1a] bg-[#f0ede8] p-4 md:grid-cols-[1fr_auto] md:items-end">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-[#6d675f]">
                Dev-Only Route
              </p>
              <h1 className="mt-2 text-3xl font-black uppercase tracking-tight md:text-5xl">
                Pipeline Dashboard
              </h1>
              <p className="mt-3 max-w-3xl text-sm text-[#5a554f]">
                Trace upload sessions, playback migration, Breakdown seeding, step attempts,
                and generated artifacts for the current Clerk viewer. Signed in as{" "}
                <span className="font-black text-[#1a1a1a]">
                  {dashboard.viewerEmail ?? "No email on identity"}
                </span>
                .
              </p>
            </div>
            <UploadSetDialog />
          </div>

          <div className="grid gap-4 p-4 md:grid-cols-2 xl:grid-cols-4">
            <SummaryCard
              label="Sets"
              value={dashboard.summary.setCount}
              hint={`${dashboard.summary.playableSetCount} playable, ${dashboard.summary.unavailableSetCount} unavailable`}
            />
            <SummaryCard
              label="Breakdowns"
              value={dashboard.summary.editableBreakdownCount}
              hint={`${dashboard.summary.failedBreakdownCount} with at least one failed path`}
            />
            <SummaryCard
              label="Playback"
              value={dashboard.summary.activePlaybackSourceCount}
              hint={`${dashboard.summary.activeMuxSourceCount} active Mux, ${dashboard.summary.activeBunnySourceCount} active Bunny`}
            />
            <SummaryCard
              label="Upload Sessions"
              value={dashboard.summary.uploadSessionCount}
              hint={`${dashboard.summary.pendingUploadSessionCount} still unconfirmed`}
            />
          </div>
        </section>

        <section className="border-2 border-[#1a1a1a] bg-white p-4 shadow-[6px_6px_0px_0px_#1a1a1a]">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-[#6d675f]">
                Recent Upload Sessions
              </p>
              <h2 className="mt-2 text-2xl font-black uppercase tracking-tight">
                Session Feed
              </h2>
            </div>
            <p className="text-sm text-[#5a554f]">
              Includes confirmed and still-unconfirmed sessions for this viewer.
            </p>
          </div>

          <div className="mt-4 grid gap-3">
            {dashboard.recentUploadSessions.map((session) => (
              <div
                key={session._id}
                className="grid gap-3 border border-[#1a1a1a] bg-[#fcfbf9] p-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]"
              >
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <span
                      className={`inline-flex items-center border px-2 py-1 text-[10px] font-black uppercase tracking-[0.18em] ${getPillClassName(
                        session.status === "confirmed"
                          ? "good"
                          : session.status === "failed"
                            ? "bad"
                            : session.status === "readyForTrim"
                              ? "warn"
                              : "neutral",
                      )}`}
                    >
                      {session.status}
                    </span>
                    <span className="text-sm font-black uppercase tracking-tight text-[#1a1a1a]">
                      {session.originalFileName}
                    </span>
                  </div>
                  <p className="mt-2 break-all text-sm text-[#5a554f]">
                    {session.muxUploadId}
                  </p>
                </div>

                <div className="grid gap-1 text-sm text-[#1a1a1a]">
                  <p>
                    <span className="font-black">Mux asset:</span>{" "}
                    <span className="break-all">
                      {session.muxAssetId ?? "Not yet"}
                    </span>
                  </p>
                  <p>
                    <span className="font-black">Mux playback:</span>{" "}
                    <span className="break-all">
                      {session.muxPlaybackId ?? "Not yet"}
                    </span>
                  </p>
                  <p>
                    <span className="font-black">Duration:</span>{" "}
                    {session.durationSeconds === null
                      ? "Not yet"
                      : formatDuration(session.durationSeconds)}
                  </p>
                  <p>
                    <span className="font-black">Failure:</span>{" "}
                    {session.failureCode ?? "None"}
                  </p>
                </div>

                <div className="text-sm text-[#1a1a1a]">
                  {session.confirmedSetId ? (
                    <Link
                      href={`/sets/${session.confirmedSetId}`}
                      className="inline-flex items-center border-2 border-[#1a1a1a] bg-white px-3 py-2 text-[10px] font-black uppercase tracking-[0.18em] hover:-translate-x-1 hover:-translate-y-1 hover:bg-[#f0ede8] hover:shadow-[4px_4px_0px_0px_#1a1a1a]"
                    >
                      Open Confirmed Set
                    </Link>
                  ) : (
                    <p className="font-mono text-[10px] uppercase tracking-[0.24em] text-[#6d675f]">
                      No confirmed Set yet
                    </p>
                  )}
                </div>
              </div>
            ))}
          </div>
        </section>

        <section className="grid gap-4">
          {dashboard.sets.map((pipelineSet) => (
            <PipelineSetCard key={pipelineSet._id} pipelineSet={pipelineSet} />
          ))}
        </section>
      </div>
    </main>
  );
}
