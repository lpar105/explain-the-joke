"use client";

import type { DragEvent } from "react";

import {
  useEffect,
  useRef,
  useState,
} from "react";
import { createUpload, type UpChunk } from "@mux/upchunk";
import {
  RefreshCcw,
  Upload,
  Video,
} from "lucide-react";

import { getErrorMessageForCode } from "../../lib/errors";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

type UploadState = "idle" | "uploading" | "processing" | "error";

function isVideoFile(file: File) {
  return file.type.startsWith("video/");
}

export default function DirectUploadField(props: {
  autoUpload?: boolean;
  disabled?: boolean;
  getUploadEndpoint: (file: File) => Promise<string>;
  onFileSelected: (file: File) => void;
  onUploadError: (message: string) => void;
  onUploadProgress?: (progressPercent: number) => void;
  onUploadStart: () => void;
  onUploadSuccess: () => void;
  startUploadNonce?: number;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const uploadRef = useRef<UpChunk | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [uploadState, setUploadState] = useState<UploadState>("idle");
  const [progressPercent, setProgressPercent] = useState(0);
  const [isDragActive, setIsDragActive] = useState(false);
  const previousStartUploadNonceRef = useRef<number | undefined>(props.startUploadNonce);

  function beginUpload(file: File) {
    if (!isVideoFile(file)) {
      props.onUploadError("Only video files can enter the Trim Range flow.");
      setUploadState("error");
      return;
    }

    props.onFileSelected(file);
    props.onUploadError("");
    props.onUploadStart();
    setSelectedFile(file);
    setUploadState("uploading");
    setProgressPercent(0);

    const upload = createUpload({
      endpoint: () => props.getUploadEndpoint(file),
      file,
      dynamicChunkSize: true,
      useLargeFileWorkaround: true,
    });

    uploadRef.current = upload;

    upload.on("progress", (event) => {
      const nextProgress = Math.round((event as CustomEvent<number>).detail);
      setProgressPercent(nextProgress);
      props.onUploadProgress?.(nextProgress);
    });

    upload.on("success", () => {
      setProgressPercent(100);
      props.onUploadProgress?.(100);
      setUploadState("processing");
      props.onUploadSuccess();
    });

    upload.on("error", () => {
      setUploadState("error");
      props.onUploadError(getErrorMessageForCode("processing_unavailable"));
    });
  }

  function handleFiles(files: FileList | null) {
    const file = files?.[0];
    if (!file || props.disabled) {
      return;
    }

    if (!isVideoFile(file)) {
      props.onUploadError("Only video files can enter the Trim Range flow.");
      setUploadState("error");
      return;
    }

    setIsDragActive(false);
    uploadRef.current?.abort();
    setSelectedFile(file);
    setUploadState("idle");
    setProgressPercent(0);
    props.onFileSelected(file);
    props.onUploadError("");

    if (props.autoUpload ?? true) {
      beginUpload(file);
    }
  }

  useEffect(() => {
    if (props.autoUpload ?? true) {
      previousStartUploadNonceRef.current = props.startUploadNonce;
      return;
    }

    if (
      props.startUploadNonce === undefined ||
      props.startUploadNonce === previousStartUploadNonceRef.current
    ) {
      return;
    }

    previousStartUploadNonceRef.current = props.startUploadNonce;

    if (!selectedFile || props.disabled) {
      return;
    }

    beginUpload(selectedFile);
  }, [props.autoUpload, props.disabled, props.startUploadNonce, selectedFile]);

  function handleRetry() {
    if (!selectedFile || props.disabled) {
      return;
    }

    uploadRef.current?.abort();
    beginUpload(selectedFile);
  }

  const showControls = uploadState === "error";

  return (
    <div className="grid gap-3">
      <input
        ref={inputRef}
        type="file"
        accept="video/*"
        className="hidden"
        onChange={(event) => handleFiles(event.target.files)}
      />

      <div
        className={cn(
          "grid gap-4 border-2 border-dashed border-[#1a1a1a] bg-[#faf8f5] p-4 transition duration-150",
          isDragActive ? "bg-[#f0ede8] shadow-[4px_4px_0px_0px_#c41e3a]" : undefined,
          "shadow-[4px_4px_0px_0px_#1a1a1a]",
        )}
        onDragEnter={(event: DragEvent<HTMLDivElement>) => {
          event.preventDefault();
          if (!props.disabled) {
            setIsDragActive(true);
          }
        }}
        onDragOver={(event: DragEvent<HTMLDivElement>) => {
          event.preventDefault();
          if (!props.disabled) {
            setIsDragActive(true);
          }
        }}
        onDragLeave={(event: DragEvent<HTMLDivElement>) => {
          event.preventDefault();
          if (event.currentTarget === event.target) {
            setIsDragActive(false);
          }
        }}
        onDrop={(event: DragEvent<HTMLDivElement>) => {
          event.preventDefault();
          handleFiles(event.dataTransfer.files);
        }}
      >
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="grid gap-1">
            <h3 className="text-xl font-black uppercase tracking-tight text-[#1a1a1a] ">
              Add video
            </h3>
          </div>

          <Button
            type="button"
            onClick={() => inputRef.current?.click()}
            disabled={props.disabled}
          >
            <Upload className="size-4" />
            {selectedFile ? "Replace File" : "Choose File"}
          </Button>
        </div>

        {selectedFile ? (
          <div className="flex flex-wrap items-center gap-2 text-[11px] font-medium text-[#4f4a43]">
            <Video className="size-4" />
            <span>{selectedFile.name}</span>
          </div>
        ) : (
          <p className="text-sm leading-6 text-[#4f4a43]">
            Drop a video here or choose one from disk.
          </p>
        )}

        <div className="grid gap-2">
          <div className="h-3 overflow-hidden border-2 border-[#1a1a1a] bg-[#e3ddd6]">
            <div
              className="h-full bg-[#1a3a52] transition-[width]"
              style={{ width: `${progressPercent}%` }}
            />
          </div>
        </div>

        {showControls ? (
          <div className="flex flex-wrap items-center gap-2">
            {uploadState === "error" ? (
              <Button type="button" variant="outline" onClick={handleRetry}>
                <RefreshCcw className="size-4" />
                Retry
              </Button>
            ) : null}
          </div>
        ) : null}

      </div>
    </div>
  );
}
