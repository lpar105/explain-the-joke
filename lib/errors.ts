import { ConvexError } from "convex/values";

export const APP_ERROR_CODES = [
  "validation",
  "auth",
  "not_found",
  "processing_unavailable",
  "internal",
] as const;

export type AppErrorCode = (typeof APP_ERROR_CODES)[number];

export type AppErrorData = {
  code: AppErrorCode;
};

export type ApiErrorResponse = AppErrorData & {
  debugMessage?: string;
};

export class AppError extends Error {
  code: AppErrorCode;
  debugMessage?: string;
  details?: Record<string, unknown>;
  status: number;

  constructor(
    code: AppErrorCode,
    options?: {
      debugMessage?: string;
      details?: Record<string, unknown>;
      status?: number;
    },
  ) {
    super(code);
    this.name = "AppError";
    this.code = code;
    this.debugMessage = options?.debugMessage;
    this.details = options?.details;
    this.status = options?.status ?? getStatusForErrorCode(code);
  }
}

export function getStatusForErrorCode(code: AppErrorCode) {
  switch (code) {
    case "validation":
      return 400;
    case "auth":
      return 401;
    case "not_found":
      return 404;
    case "processing_unavailable":
      return 503;
    case "internal":
      return 500;
  }
}

export function getErrorMessageForCode(code: AppErrorCode) {
  switch (code) {
    case "validation":
      return "Check the details and try again.";
    case "auth":
      return "Sign in and try again.";
    case "not_found":
      return "That Set is no longer available.";
    case "processing_unavailable":
      return "We couldn't complete that step for this Set. Try again.";
    case "internal":
      return "Something went wrong on our side. Try again.";
  }
}

export function getUploadSessionFailureMessage(code: AppErrorCode) {
  switch (code) {
    case "processing_unavailable":
      return "We couldn't prepare playback for this Set. Try uploading again.";
    default:
      return getErrorMessageForCode(code);
  }
}

export function isAppErrorCode(value: unknown): value is AppErrorCode {
  return typeof value === "string" && APP_ERROR_CODES.includes(value as AppErrorCode);
}

export function toAppError(
  error: unknown,
  fallbackCode: AppErrorCode = "internal",
) {
  if (error instanceof AppError) {
    return error;
  }

  if (error instanceof ConvexError) {
    const errorData = error.data;
    if (
      typeof errorData === "object" &&
      errorData !== null &&
      "code" in errorData &&
      isAppErrorCode((errorData as { code?: unknown }).code)
    ) {
      return new AppError((errorData as { code: AppErrorCode }).code, {
        debugMessage: error.message,
      });
    }
  }

  return new AppError(fallbackCode, {
    debugMessage: error instanceof Error ? error.message : String(error),
  });
}

export function toConvexError(code: AppErrorCode): ConvexError<AppErrorData> {
  return new ConvexError({
    code,
  });
}

export function getAppErrorCodeFromConvexError(error: unknown) {
  if (!(error instanceof ConvexError)) {
    return null;
  }

  const errorData = error.data;
  if (
    typeof errorData !== "object" ||
    errorData === null ||
    !("code" in errorData) ||
    !isAppErrorCode((errorData as { code?: unknown }).code)
  ) {
    return null;
  }

  return (errorData as { code: AppErrorCode }).code;
}

export function getAppErrorCodeFromApiPayload(payload: unknown) {
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("code" in payload) ||
    !isAppErrorCode((payload as { code?: unknown }).code)
  ) {
    return null;
  }

  return (payload as { code: AppErrorCode }).code;
}

export function toApiErrorResponseBody(error: unknown, fallbackCode: AppErrorCode) {
  const appError = toAppError(error, fallbackCode);
  const responseBody: ApiErrorResponse = {
    code: appError.code,
  };

  if (process.env.NODE_ENV !== "production" && appError.debugMessage) {
    responseBody.debugMessage = appError.debugMessage;
  }

  return {
    body: responseBody,
    status: appError.status,
  };
}

export function logServerError(
  message: string,
  error: unknown,
  context?: Record<string, unknown>,
) {
  const appError = toAppError(error);

  console.error(message, {
    code: appError.code,
    context,
    debugMessage: appError.debugMessage,
    details: appError.details,
    error,
  });
}
