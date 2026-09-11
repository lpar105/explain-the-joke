"use node";

import { ModalClient } from "modal";
import { v } from "convex/values";

import { internalAction } from "./_generated/server";

const DEFAULT_MODAL_APP_NAME = "tight-five-ingest";

const ingestStepNameValidator = v.union(
  v.literal("prepareRetainedMedia"),
  v.literal("transcribeWords"),
  v.literal("preprocessLaughAudio"),
  v.literal("detectLaughCandidates"),
);

const inputArtifactValidator = v.object({
  contentType: v.optional(v.string()),
  fileName: v.string(),
  isCanonical: v.boolean(),
  key: v.string(),
  kind: v.union(
    v.literal("retainedMedia"),
    v.literal("playbackMedia"),
    v.literal("transcriptRaw"),
    v.literal("cleanedAudio"),
    v.literal("laughCandidatesRaw"),
  ),
  size: v.optional(v.number()),
});

const outputArtifactValidator = v.object({
  contentType: v.optional(v.string()),
  fileName: v.string(),
  isCanonical: v.boolean(),
  key: v.string(),
  kind: v.union(
    v.literal("retainedMedia"),
    v.literal("playbackMedia"),
    v.literal("cleanedAudio"),
    v.literal("transcriptRaw"),
    v.literal("laughCandidatesRaw"),
  ),
});

const trimSourceValidator = v.object({
  muxAssetId: v.string(),
  muxPlaybackId: v.string(),
  sourceHlsUrl: v.string(),
  trimRangeEndSeconds: v.number(),
  trimRangeStartSeconds: v.number(),
});

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing ${name} in the Convex environment.`);
  }
  return value;
}

export function createModalClientFromEnv() {
  return new ModalClient({
    tokenId: requireEnv("MODAL_TOKEN_ID"),
    tokenSecret: requireEnv("MODAL_TOKEN_SECRET"),
  });
}

function getModalFunctionEnvValue(
  stepName:
    | "prepareRetainedMedia"
    | "transcribeWords"
    | "preprocessLaughAudio"
    | "detectLaughCandidates",
) {
  switch (stepName) {
    case "prepareRetainedMedia":
      return (
        process.env.MODAL_PREPARE_RETAINED_MEDIA_FUNCTION_NAME ??
        "prepare_retained_media"
      );
    case "transcribeWords":
      return process.env.MODAL_TRANSCRIBE_FUNCTION_NAME ?? "transcribe_words";
    case "preprocessLaughAudio":
      return process.env.MODAL_PREPROCESS_LAUGH_AUDIO_FUNCTION_NAME ?? "preprocess_laugh_audio";
    case "detectLaughCandidates":
      return process.env.MODAL_DETECT_LAUGH_CANDIDATES_FUNCTION_NAME ?? "detect_laugh_candidates";
  }
}

type ModalFunctionTarget = {
  appName: string;
  functionName: string;
};

export function resolveModalFunctionTarget(
  stepName:
    | "prepareRetainedMedia"
    | "transcribeWords"
    | "preprocessLaughAudio"
    | "detectLaughCandidates",
): ModalFunctionTarget {
  const configuredTarget = getModalFunctionEnvValue(stepName).trim();
  const [configuredAppName, configuredFunctionName, ...rest] =
    configuredTarget.split("/");

  if (rest.length > 0 || !configuredAppName || !configuredFunctionName) {
    return {
      appName: process.env.MODAL_APP_NAME?.trim() || DEFAULT_MODAL_APP_NAME,
      functionName: configuredTarget,
    };
  }

  return {
    appName: configuredAppName,
    functionName: configuredFunctionName,
  };
}

function buildModalLookupTargets(target: ModalFunctionTarget): ModalFunctionTarget[] {
  if (target.appName === DEFAULT_MODAL_APP_NAME) {
    return [target];
  }

  return [target, { appName: DEFAULT_MODAL_APP_NAME, functionName: target.functionName }];
}

export const spawnModalFunction = internalAction({
  args: {
    attemptNumber: v.number(),
    breakdownId: v.id("breakdowns"),
    ingestJobId: v.id("ingestJobs"),
    inputArtifacts: v.array(inputArtifactValidator),
    outputArtifacts: v.array(outputArtifactValidator),
    setId: v.id("sets"),
    stepName: ingestStepNameValidator,
    trimSource: v.optional(trimSourceValidator),
  },
  returns: v.object({
    modalFunctionCallId: v.string(),
  }),
  handler: async (_ctx, args) => {
    const callbackBaseUrl = requireEnv("SET_INGEST_CALLBACK_BASE_URL");
    const callbackSecret = requireEnv("SET_INGEST_CALLBACK_SECRET");
    const modal = createModalClientFromEnv();
    const lookupTargets = buildModalLookupTargets(
      resolveModalFunctionTarget(args.stepName),
    );

    let modalFunction: Awaited<ReturnType<typeof modal.functions.fromName>> | null =
      null;
    let lastError: unknown = null;
    for (const target of lookupTargets) {
      try {
        modalFunction = await modal.functions.fromName(
          target.appName,
          target.functionName,
        );
        break;
      } catch (error) {
        lastError = error;
      }
    }

    if (modalFunction === null) {
      const attemptedTargets = lookupTargets
        .map((target) => `${target.appName}/${target.functionName}`)
        .join(", ");
      const suffix =
        lastError instanceof Error ? ` Original error: ${lastError.message}` : "";
      throw new Error(
        `Modal function not found. Tried ${attemptedTargets}. Run 'modal deploy modal/ingest.py' or update MODAL_APP_NAME / MODAL_*_FUNCTION_NAME.${suffix}`,
      );
    }

    const functionCall = await modalFunction.spawn([], {
      attemptNumber: args.attemptNumber,
      breakdownId: args.breakdownId,
      callbackSecret,
      callbackUrl: `${callbackBaseUrl.replace(/\/$/, "")}/modal/workflow-callback`,
      ingestJobId: args.ingestJobId,
      inputArtifacts: args.inputArtifacts,
      outputArtifacts: args.outputArtifacts,
      setId: args.setId,
      stepName: args.stepName,
      trimSource: args.trimSource,
    });

    return { modalFunctionCallId: functionCall.functionCallId };
  },
});
