"use client";

import type { RefObject } from "react";
import type { Id } from "../../convex/_generated/dataModel";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Hls from "hls.js";
import { useRouter } from "next/navigation";
import {
  Check,
  LoaderCircle,
  Upload,
} from "lucide-react";
import { useMutation, useQuery } from "convex/react";

import { api } from "../../convex/_generated/api";
import {
  type ApiErrorResponse,
  getAppErrorCodeFromApiPayload,
  getAppErrorCodeFromConvexError,
  getErrorMessageForCode,
  getUploadSessionFailureMessage,
} from "../../lib/errors";
import { getClipDurationSeconds, getClipRelativeTime } from "../../lib/trim-range";
import { formatTimestamp } from "../../lib/set-status";
import DirectUploadField from "./direct-upload-field";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../ui/dialog";
import { Input } from "../ui/input";

type UploadStep = "details" | "uploading" | "processing" | "trimming";

type DirectUploadResponse = {
  uploadId: string;
  uploadUrl: string | null;
};

function isDirectUploadResponse(payload: unknown): payload is DirectUploadResponse {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "uploadId" in payload &&
    "uploadUrl" in payload
  );
}

function isVideoFile(file: File) {
  return file.type.startsWith("video/");
}

function getDefaultSetTitleFromFileName(fileName: string) {
  const extensionIndex = fileName.lastIndexOf(".");

  if (extensionIndex <= 0) {
    return fileName;
  }

  return fileName.slice(0, extensionIndex);
}

export default function UploadSetDialog() {
  const router = useRouter();
  const startUploadSession = useMutation(api.sets.startUploadSession);
  const confirmUploadSession = useMutation(api.sets.confirmUploadSession);

  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<UploadStep>("details");
  const [title, setTitle] = useState("");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadSessionId, setUploadSessionId] =
    useState<Id<"uploadSessions"> | null>(null);
  const [uploadId, setUploadId] = useState<string | null>(null);
  const [assetId, setAssetId] = useState<string | null>(null);
  const [playbackId, setPlaybackId] = useState<string | null>(null);
  const [hlsUrl, setHlsUrl] = useState<string | null>(null);
  const [durationSeconds, setDurationSeconds] = useState<number | null>(null);
  const [trimRangeStartSeconds, setTrimRangeStartSeconds] = useState(0);
  const [trimRangeEndSeconds, setTrimRangeEndSeconds] = useState(0);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isCleaningUp, setIsCleaningUp] = useState(false);
  const [isConfirming, setIsConfirming] = useState(false);
  const [startUploadNonce, setStartUploadNonce] = useState(0);
  const [uploaderKey, setUploaderKey] = useState(0);
  const uploadSession = useQuery(
    api.sets.getUploadSessionForViewer,
    uploadSessionId ? { uploadSessionId } : "skip",
  );

  const clipDurationSeconds = useMemo(
    () => getClipDurationSeconds(trimRangeStartSeconds, trimRangeEndSeconds),
    [trimRangeEndSeconds, trimRangeStartSeconds],
  );

  function getMessageFromApiErrorPayload(
    payload: unknown,
    fallbackCode: "processing_unavailable" | "internal" = "internal",
  ) {
    const code = getAppErrorCodeFromApiPayload(payload) ?? fallbackCode;
    return getErrorMessageForCode(code);
  }

  function getMessageFromConvexError(error: unknown, fallbackCode: "internal" | "validation" = "internal") {
    const code = getAppErrorCodeFromConvexError(error) ?? fallbackCode;
    return getErrorMessageForCode(code);
  }

  function getSafeErrorMessage(error: unknown, fallbackCode: "internal" | "validation" = "internal") {
    const convexErrorCode = getAppErrorCodeFromConvexError(error);
    if (convexErrorCode) {
      return getErrorMessageForCode(convexErrorCode);
    }

    if (error instanceof Error) {
      return error.message;
    }

    return getErrorMessageForCode(fallbackCode);
  }

  useEffect(() => {
    if (!uploadSession) {
      return;
    }

    if (
      uploadSession.status === "readyForTrim" &&
      uploadSession.muxAssetId &&
      uploadSession.muxPlaybackId &&
      uploadSession.durationSeconds
    ) {
      setAssetId(uploadSession.muxAssetId);
      setPlaybackId(uploadSession.muxPlaybackId);
      setHlsUrl(`https://stream.mux.com/${uploadSession.muxPlaybackId}.m3u8`);
      setDurationSeconds(uploadSession.durationSeconds);
      setTrimRangeStartSeconds((currentStartSeconds) =>
        currentStartSeconds === 0 ? 0 : currentStartSeconds,
      );
      setTrimRangeEndSeconds((currentEndSeconds) =>
        currentEndSeconds === 0 ? uploadSession.durationSeconds! : currentEndSeconds,
      );
      setStep("trimming");
      return;
    }

    if (uploadSession.status === "failed" && uploadSession.failureCode) {
      setErrorMessage(getUploadSessionFailureMessage(uploadSession.failureCode));
    }

    if (
      uploadSession.status === "processing" ||
      uploadSession.status === "waitingForUpload"
    ) {
      setStep("processing");
    }
  }, [uploadSession]);

  function resetFlow() {
    setStep("details");
    setTitle("");
    setSelectedFile(null);
    setUploadSessionId(null);
    setUploadId(null);
    setAssetId(null);
    setPlaybackId(null);
    setHlsUrl(null);
    setDurationSeconds(null);
    setTrimRangeStartSeconds(0);
    setTrimRangeEndSeconds(0);
    setErrorMessage(null);
    setIsCleaningUp(false);
    setIsConfirming(false);
    setStartUploadNonce(0);
    setUploaderKey((currentKey) => currentKey + 1);
  }

  async function cleanupTemporaryUploadAndClose() {
    if (uploadSessionId === null && uploadId === null) {
      resetFlow();
      setOpen(false);
      return;
    }

    setIsCleaningUp(true);
    setErrorMessage(null);

    try {
      if (uploadId !== null) {
        const response = await fetch(`/api/mux/direct-uploads/${uploadId}`, {
          method: "DELETE",
        });
        const payload = (await response.json()) as ApiErrorResponse;

        if (!response.ok) {
          throw new Error(getMessageFromApiErrorPayload(payload));
        }
      }

      resetFlow();
      setOpen(false);
    } catch (error) {
      setErrorMessage(getSafeErrorMessage(error));
      setIsCleaningUp(false);
    }
  }

  async function getDirectUploadEndpoint(file: File) {
    if (!file) {
      throw new Error("Choose a video file before uploading.");
    }

    const nextTitle = title.trim();
    if (!nextTitle) {
      throw new Error("Give the Set a title before uploading.");
    }

    if (!isVideoFile(file)) {
      throw new Error("Only video files can enter the Trim Range flow.");
    }

    setErrorMessage(null);
    setStep("uploading");
    setSelectedFile(file);

    let nextUploadId: string | null = null;
    try {
      const response = await fetch("/api/mux/direct-uploads", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contentType: file.type,
        }),
      });

      const payload = (await response.json()) as DirectUploadResponse | ApiErrorResponse;

      if (!response.ok) {
        throw new Error(getMessageFromApiErrorPayload(payload, "processing_unavailable"));
      }

      if (!isDirectUploadResponse(payload) || !payload.uploadUrl) {
        throw new Error(getErrorMessageForCode("processing_unavailable"));
      }

      const startedSession = await startUploadSession({
        muxUploadId: payload.uploadId,
        originalFileName: file.name,
      });

      nextUploadId = payload.uploadId;
      setUploadSessionId(startedSession.uploadSessionId);
      setUploadId(payload.uploadId);
      return payload.uploadUrl;
    } catch (error) {
      if (nextUploadId !== null) {
        try {
          await fetch(`/api/mux/direct-uploads/${nextUploadId}`, {
            method: "DELETE",
          });
        } catch {
          // Leave cleanup to explicit modal close if the best-effort delete fails.
        }
      }

      setUploadSessionId(null);
      setUploadId(null);
      setAssetId(null);
      setPlaybackId(null);
      setHlsUrl(null);
      setDurationSeconds(null);
      setErrorMessage(getSafeErrorMessage(error));
      setStep("details");
      throw error;
    }
  }

  async function handleConfirmTrimRange() {
    if (
      uploadSessionId === null ||
      assetId === null ||
      playbackId === null ||
      durationSeconds === null
    ) {
      setErrorMessage(getUploadSessionFailureMessage("processing_unavailable"));
      return;
    }

    setIsConfirming(true);
    setErrorMessage(null);

    try {
      const created = await confirmUploadSession({
        uploadSessionId,
        title,
        trimRangeEndSeconds,
        trimRangeStartSeconds,
        durationSeconds,
        muxAssetId: assetId,
        muxPlaybackId: playbackId,
      });

      resetFlow();
      setOpen(false);
      router.push(`/sets/${created.setId}`);
    } catch (error) {
      setErrorMessage(getMessageFromConvexError(error));
      setIsConfirming(false);
    }
  }

  function handleSubmitUpload() {
    if (selectedFile === null) {
      setErrorMessage("Choose a video file before submitting.");
      return;
    }

    if (title.trim().length === 0) {
      setErrorMessage("Give the Set a title before submitting.");
      return;
    }

    if (!isVideoFile(selectedFile)) {
      setErrorMessage("Only video files can enter the Trim Range flow.");
      return;
    }

    setErrorMessage(null);
    setStartUploadNonce((currentNonce) => currentNonce + 1);
  }

  function handleDialogOpenChange(nextOpen: boolean) {
    if (nextOpen) {
      setOpen(true);
      return;
    }

    if (isCleaningUp) {
      return;
    }

    void cleanupTemporaryUploadAndClose();
  }

  return (
    <Dialog open={open} onOpenChange={handleDialogOpenChange}>
      <DialogTrigger asChild>
        <Button size="lg" variant="destructive">
          <Upload className="size-4" />
          Add New Set
        </Button>
      </DialogTrigger>

      <DialogContent className="flex h-[calc(100dvh-1rem)] max-h-[60rem] max-w-6xl flex-col overflow-hidden p-0 sm:h-auto sm:max-h-[calc(100dvh-2rem)]">
        <DialogHeader>
          <DialogTitle>
            {step === "trimming" ? "Confirm Trim Range" : "Upload New Set"}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Upload one video Set, then choose the Trim Range to keep.
          </DialogDescription>
        </DialogHeader>

        <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto p-3 sm:p-4">
          {step !== "trimming" ? (
            <label className="grid gap-2">
              <span className="text-[10px] font-black uppercase tracking-[0.2em] text-[#1a1a1a]">
                Set Title
              </span>
              <Input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Late Show Crowd Work"
                disabled={step !== "details"}
              />
            </label>
          ) : null}

          {step !== "trimming" ? (
            <div className="grid gap-3">
              <span className="text-[10px] font-black uppercase tracking-[0.2em] text-[#1a1a1a]">
                Video Upload
              </span>
              <DirectUploadField
                key={uploaderKey}
                autoUpload={false}
                disabled={step !== "details"}
                getUploadEndpoint={getDirectUploadEndpoint}
                startUploadNonce={startUploadNonce}
                onFileSelected={(file) => {
                  const nextDefaultTitle = getDefaultSetTitleFromFileName(file.name);
                  const previousDefaultTitle = selectedFile
                    ? getDefaultSetTitleFromFileName(selectedFile.name)
                    : null;
                  const trimmedTitle = title.trim();

                  setSelectedFile(file);
                  setErrorMessage(null);

                  if (
                    trimmedTitle.length === 0 ||
                    (previousDefaultTitle !== null &&
                      trimmedTitle === previousDefaultTitle)
                  ) {
                    setTitle(nextDefaultTitle);
                  }
                }}
                onUploadError={(message) => {
                  setErrorMessage(message || null);
                  if (message) {
                    setStep("details");
                  }
                }}
                onUploadStart={() => {
                  setErrorMessage(null);
                  setStep("uploading");
                }}
                onUploadSuccess={() => {
                  setStep("processing");
                }}
              />
            </div>
          ) : null}

          {step === "trimming" && hlsUrl && durationSeconds !== null ? (
            <TrimRangeEditor
              durationSeconds={durationSeconds}
              hlsUrl={hlsUrl}
              playbackId={playbackId}
              trimRangeEndSeconds={trimRangeEndSeconds}
              trimRangeStartSeconds={trimRangeStartSeconds}
              onTrimRangeEndSecondsChange={setTrimRangeEndSeconds}
              onTrimRangeStartSecondsChange={setTrimRangeStartSeconds}
            />
          ) : null}

          {errorMessage ? (
            <p className="border-2 border-[#1a1a1a] bg-[#fff0f0] px-3 py-3 text-sm text-[#a61b32]">
              {errorMessage}
            </p>
          ) : null}

        </div>

        <DialogFooter className="shrink-0 border-t-2 border-[#1a1a1a] bg-[#faf8f5] p-3 sm:p-4">
          <Button
            type="button"
            variant="outline"
            onClick={() => void cleanupTemporaryUploadAndClose()}
            disabled={isCleaningUp || isConfirming}
          >
            {isCleaningUp ? <LoaderCircle className="size-4 animate-spin" /> : null}
            Cancel
          </Button>

          {step === "trimming" ? (
            <Button
              type="button"
              onClick={() => void handleConfirmTrimRange()}
              disabled={isConfirming || clipDurationSeconds <= 0 || title.trim().length === 0}
            >
              {isConfirming ? (
                <LoaderCircle className="size-4 animate-spin" />
              ) : (
                <Check className="size-4" />
              )}
              Confirm Trim Range
            </Button>
          ) : step === "details" ? (
            <Button
              type="button"
              onClick={handleSubmitUpload}
              disabled={selectedFile === null || title.trim().length === 0}
            >
              <Upload className="size-4" />
              Submit
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function TrimRangeEditor(props: {
  durationSeconds: number;
  hlsUrl: string;
  playbackId: string | null;
  trimRangeEndSeconds: number;
  trimRangeStartSeconds: number;
  onTrimRangeEndSecondsChange: (seconds: number) => void;
  onTrimRangeStartSecondsChange: (seconds: number) => void;
}) {
  const [currentTimeSeconds, setCurrentTimeSeconds] = useState(
    props.trimRangeStartSeconds,
  );
  const timelineRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setCurrentTimeSeconds(props.trimRangeStartSeconds);
  }, [props.hlsUrl, props.trimRangeStartSeconds]);

  const startPercent =
    props.durationSeconds === 0
      ? 0
      : (props.trimRangeStartSeconds / props.durationSeconds) * 100;
  const endPercent =
    props.durationSeconds === 0
      ? 100
      : (props.trimRangeEndSeconds / props.durationSeconds) * 100;
  const playheadPercent =
    props.durationSeconds === 0
      ? 0
      : (currentTimeSeconds / props.durationSeconds) * 100;
  const clipDurationSeconds = getClipDurationSeconds(
    props.trimRangeStartSeconds,
    props.trimRangeEndSeconds,
  );
  const clipRelativeTime = getClipRelativeTime(
    currentTimeSeconds,
    props.trimRangeStartSeconds,
    props.trimRangeEndSeconds,
  );

  const thumbnailTimes = useMemo(() => {
    if (!props.playbackId) {
      return [];
    }

    const thumbnailCount = 8;
    const safeDuration = Math.max(props.durationSeconds, 1);

    return Array.from({ length: thumbnailCount }, (_, index) => {
      const timeSeconds = (safeDuration * index) / (thumbnailCount - 1);

      return {
        src: `https://image.mux.com/${props.playbackId}/thumbnail.jpg?time=${timeSeconds.toFixed(2)}&width=220`,
        timeSeconds,
      };
    });
  }, [props.durationSeconds, props.playbackId]);

  function updateTrimStart(nextValue: number, seekToTimeSeconds: (nextSeconds: number) => void) {
    const nextStart = Math.max(
      0,
      Math.min(nextValue, props.trimRangeEndSeconds - 0.1),
    );
    props.onTrimRangeStartSecondsChange(nextStart);
    seekToTimeSeconds(nextStart);
    setCurrentTimeSeconds(nextStart);
  }

  function updateTrimEnd(nextValue: number, seekToTimeSeconds: (nextSeconds: number) => void) {
    const nextEnd = Math.min(
      props.durationSeconds,
      Math.max(nextValue, props.trimRangeStartSeconds + 0.1),
    );
    props.onTrimRangeEndSecondsChange(nextEnd);
    seekToTimeSeconds(nextEnd);
    setCurrentTimeSeconds(nextEnd);
  }

  function getSecondsFromPointer(clientX: number) {
    const timeline = timelineRef.current;
    if (!timeline) {
      return 0;
    }

    const { left, width } = timeline.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - left) / Math.max(width, 1)));
    return props.durationSeconds * ratio;
  }

  function beginHandleDrag(
    handle: "start" | "end",
    event: React.PointerEvent<HTMLButtonElement>,
    seekToTimeSeconds: (nextSeconds: number) => void,
  ) {
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);

    const moveHandle = (clientX: number) => {
      const nextSeconds = getSecondsFromPointer(clientX);
      if (handle === "start") {
        updateTrimStart(nextSeconds, seekToTimeSeconds);
        return;
      }

      updateTrimEnd(nextSeconds, seekToTimeSeconds);
    };

    moveHandle(event.clientX);

    const handlePointerMove = (moveEvent: PointerEvent) => {
      moveHandle(moveEvent.clientX);
    };

    const handlePointerUp = () => {
      window.removeEventListener("pointermove", handlePointerMove);
      window.removeEventListener("pointerup", handlePointerUp);
    };

    window.addEventListener("pointermove", handlePointerMove);
    window.addEventListener("pointerup", handlePointerUp);
  }

  function seekFromTimeline(
    event: React.PointerEvent<HTMLDivElement>,
    seekToTimeSeconds: (nextSeconds: number) => void,
  ) {
    if (
      event.button !== 0 ||
      (event.target instanceof Element && event.target.closest("button"))
    ) {
      return;
    }

    const nextSeconds = getSecondsFromPointer(event.clientX);
    seekToTimeSeconds(nextSeconds);
    setCurrentTimeSeconds(nextSeconds);
  }

  return (
    <HlsTrimPreview
      currentTimeSeconds={currentTimeSeconds}
      durationSeconds={props.durationSeconds}
      hlsUrl={props.hlsUrl}
      trimRangeEndSeconds={props.trimRangeEndSeconds}
      trimRangeStartSeconds={props.trimRangeStartSeconds}
      onCurrentTimeSecondsChange={setCurrentTimeSeconds}
    >
      {({ seekToTimeSeconds }) => (
        <div
          ref={timelineRef}
          onPointerDown={(event) => seekFromTimeline(event, seekToTimeSeconds)}
          className="relative h-8 cursor-pointer overflow-hidden border-2 border-[#1a1a1a] bg-[#f0ede8] sm:h-10"
        >
          {thumbnailTimes.length > 0 ? (
            <div className="grid h-full grid-cols-8">
              {thumbnailTimes.map((thumbnail) => (
                <img
                  key={thumbnail.src}
                  src={thumbnail.src}
                  alt={`Frame preview at ${formatTimestamp(
                    thumbnail.timeSeconds,
                  )}`}
                  className="h-full w-full object-cover"
                />
              ))}
            </div>
          ) : (
            <div className="grid h-full grid-cols-12 gap-1 p-2">
              {Array.from({ length: 12 }).map((_, index) => (
                <div
                  key={index}
                  className="rounded-sm bg-[linear-gradient(180deg,#e3ddd6_0%,#f7f3ee_100%)]"
                />
              ))}
            </div>
          )}

          <div
            className="absolute inset-y-0 left-0 bg-[#1a1a1a]/45"
            style={{ width: `${startPercent}%` }}
          />
          <div
            className="absolute inset-y-0 border-y-2 border-[#1a1a1a] bg-[#ffd966]/25"
            style={{
              left: `${startPercent}%`,
              width: `${Math.max(0, endPercent - startPercent)}%`,
            }}
          />
          <div
            className="absolute inset-y-0 right-0 bg-[#1a1a1a]/45"
            style={{ width: `${Math.max(0, 100 - endPercent)}%` }}
          />
          <div
            className="absolute inset-y-0 w-[3px] bg-[#c41e3a]"
            style={{ left: `calc(${playheadPercent}% - 1px)` }}
          />
          <div
            className="absolute inset-y-0 border-x-2 border-[#1a1a1a] bg-transparent"
            style={{
              left: `${startPercent}%`,
              width: `${Math.max(0, endPercent - startPercent)}%`,
            }}
          >
            <button
              type="button"
              aria-label="Trim start"
              onPointerDown={(event) =>
                beginHandleDrag("start", event, seekToTimeSeconds)
              }
              className="absolute left-0 top-1/2 z-10 flex h-4 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center border-2 border-[#1a1a1a] bg-[#c41e3a] shadow-[2px_2px_0px_0px_#1a1a1a]"
            >
              <span className="sr-only">Trim start</span>
            </button>
            <button
              type="button"
              aria-label="Trim end"
              onPointerDown={(event) =>
                beginHandleDrag("end", event, seekToTimeSeconds)
              }
              className="absolute left-full top-1/2 z-10 flex h-4 w-4 -translate-x-1/2 -translate-y-1/2 items-center justify-center border-2 border-[#1a1a1a] bg-[#c41e3a] shadow-[2px_2px_0px_0px_#1a1a1a]"
            >
              <span className="sr-only">Trim end</span>
            </button>
          </div>
        </div>
      )}
    </HlsTrimPreview>
  );
}

function HlsTrimPreview(props: {
  children: (api: {
    seekToTimeSeconds: (nextSeconds: number) => void;
  }) => React.ReactNode;
  currentTimeSeconds: number;
  durationSeconds: number;
  hlsUrl: string;
  trimRangeEndSeconds: number;
  trimRangeStartSeconds: number;
  onCurrentTimeSecondsChange: (seconds: number) => void;
}) {
  const mediaRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const media = mediaRef.current;
    if (!media) {
      return;
    }

    if (media.canPlayType("application/vnd.apple.mpegurl")) {
      media.src = props.hlsUrl;
      return;
    }

    if (!Hls.isSupported()) {
      media.src = props.hlsUrl;
      return;
    }

    const hls = new Hls({
      enableWorker: true,
    });
    hls.loadSource(props.hlsUrl);
    hls.attachMedia(media);

    return () => {
      hls.destroy();
    };
  }, [props.hlsUrl]);

  useEffect(() => {
    const media = mediaRef.current;
    if (!media) {
      return;
    }

    const syncIntoTrimWindow = () => {
      if (!media.paused && media.currentTime < props.trimRangeStartSeconds) {
        media.currentTime = props.trimRangeStartSeconds;
      }

      if (!media.paused && media.currentTime > props.trimRangeEndSeconds) {
        media.currentTime = props.trimRangeStartSeconds;
      }

      props.onCurrentTimeSecondsChange(media.currentTime);
    };

    const handleLoadedMetadata = () => {
      media.currentTime = props.trimRangeStartSeconds;
      props.onCurrentTimeSecondsChange(props.trimRangeStartSeconds);
    };

    const handleTimeUpdate = () => {
      if (!media.paused && media.currentTime >= props.trimRangeEndSeconds) {
        media.currentTime = props.trimRangeStartSeconds;
        void media.play().catch(() => {
          media.pause();
        });
      }

      syncIntoTrimWindow();
    };

    media.addEventListener("loadedmetadata", handleLoadedMetadata);
    media.addEventListener("timeupdate", handleTimeUpdate);

    syncIntoTrimWindow();

    return () => {
      media.removeEventListener("loadedmetadata", handleLoadedMetadata);
      media.removeEventListener("timeupdate", handleTimeUpdate);
    };
  }, [
    props.onCurrentTimeSecondsChange,
    props.trimRangeEndSeconds,
    props.trimRangeStartSeconds,
  ]);

  function seekToTimeSeconds(nextSeconds: number) {
    const media = mediaRef.current;
    const clampedTimeSeconds = Math.min(
      props.durationSeconds,
      Math.max(0, nextSeconds),
    );

    props.onCurrentTimeSecondsChange(clampedTimeSeconds);

    if (!media) {
      return;
    }

    media.currentTime = clampedTimeSeconds;
  }

  return (
    <div className="grid min-h-0 gap-3">
      <div className="flex h-[min(50dvh,34rem)] min-h-48 items-center justify-center overflow-hidden border-2 border-[#1a1a1a] bg-black sm:min-h-56">
        <video
          ref={mediaRef as RefObject<HTMLVideoElement>}
          controls
          playsInline
          className="block h-full w-full bg-black object-contain"
        />
      </div>

      {props.children({ seekToTimeSeconds })}
    </div>
  );
}
