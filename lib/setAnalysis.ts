export type SetSegment = {
  index: number;
  start_time: number;
  end_time: number;
  duration: number;
  intensity_score: number;
};

export type SentenceLaugh = {
  index: number;
  start_time: number;
  end_time: number;
  duration: number;
  intensity_score: number;
};

export type TranscriptSentence = {
  index: number;
  start: number;
  end: number;
  text: string;
  laugh_count: number;
  laugh_intensity_score: number;
  laughs: SentenceLaugh[];
};

export type SetAnalysisData = {
  version: string;
  generatedAt: number;
  sampleRate: number;
  totalDuration: number;
  segmentCount: number;
  transcriptText: string;
  sentences: TranscriptSentence[];
  segments: SetSegment[];
  chapters: Array<{
    id: string;
    title: string;
    start: number;
  }>;
  comments: Array<{
    id: string;
    time: number;
    text: string;
  }>;
};

export function createEmptyAnalysisPayload(): SetAnalysisData {
  return {
    version: "1.1.0",
    generatedAt: 0,
    sampleRate: 0,
    totalDuration: 0,
    segmentCount: 0,
    transcriptText: "",
    sentences: [],
    segments: [],
    chapters: [],
    comments: [],
  };
}

export function composeTranscriptText(
  sentences: Array<Pick<TranscriptSentence, "text">>,
) {
  return sentences
    .map((sentence) => sentence.text.trim())
    .filter(Boolean)
    .join(" ");
}

export function normalizeAnalysisPayload(
  payload: Partial<SetAnalysisData> | null | undefined,
): SetAnalysisData {
  const empty = createEmptyAnalysisPayload();

  return {
    ...empty,
    ...payload,
    sentences: (payload?.sentences ?? []).map((sentence) => ({
      index: sentence.index,
      start: sentence.start,
      end: sentence.end,
      text: sentence.text,
      laugh_count: sentence.laugh_count ?? 0,
      laugh_intensity_score: sentence.laugh_intensity_score ?? 0,
      laughs: (sentence.laughs ?? []).map((laugh, index) => ({
        index: laugh.index ?? index + 1,
        start_time: laugh.start_time,
        end_time: laugh.end_time,
        duration: laugh.duration,
        intensity_score: laugh.intensity_score,
      })),
    })),
    segments: (payload?.segments ?? []).map((segment, index) => ({
      index: segment.index ?? index + 1,
      start_time: segment.start_time,
      end_time: segment.end_time,
      duration: segment.duration,
      intensity_score: segment.intensity_score,
    })),
    chapters: (payload?.chapters ?? [])
      .map((chapter, index) => ({
        id: chapter.id ?? `chapter-${index + 1}`,
        title: chapter.title ?? `Chapter ${index + 1}`,
        start: chapter.start,
      }))
      .sort((left, right) => left.start - right.start),
    comments: (payload?.comments ?? [])
      .map((comment, index) => ({
        id: comment.id ?? `comment-${index + 1}`,
        time: comment.time,
        text: comment.text ?? "",
      }))
      .sort((left, right) => left.time - right.time),
  };
}
