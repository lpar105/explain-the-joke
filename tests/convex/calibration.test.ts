import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, internal } from '../../convex/_generated/api';
import { createConvexTest } from './test.setup';

const owner = { tokenIdentifier: 'clerk:calibration-owner', subject: 'owner', issuer: 'https://clerk.dev' };

async function prepared(duration = 60) {
  const t = createConvexTest();
  const asOwner = t.withIdentity(owner);
  const ids = await t.run(async ctx => {
    const setId = await ctx.db.insert('sets', {
      ownerTokenIdentifier: owner.tokenIdentifier, title: 'Calibrate', provisional: true,
      setStatus: 'playable', trimRangeStartSeconds: 17, trimRangeEndSeconds: 17 + duration,
    });
    const breakdownId = await ctx.db.insert('breakdowns', {
      setId, editability: 'locked', lineSeedingState: 'ready', laughSeedingState: 'pending',
    });
    await ctx.db.patch(setId, { currentBreakdownId: breakdownId });
    const ingestJobId = await ctx.db.insert('ingestJobs', { setId, breakdownId, calibrationRequired: true, calibrationStatus: 'pending', status: 'running' });
    const uploadSessionId = await ctx.db.insert('uploadSessions', {
      ownerTokenIdentifier: owner.tokenIdentifier, muxUploadId: 'upload', originalFileName: 'set.mp4',
      status: 'calibrating', confirmedSetId: setId, lastContactAt: Date.now(),
    });
    const mediaId = await ctx.db.insert('ingestArtifacts', {
      ingestJobId, stepName: 'prepareRetainedMedia', kind: 'retainedMedia',
      isCanonical: true, path: `set-ingest/${setId}/retained.wav`, fileName: 'retained.wav',
    });
    await ctx.db.insert('ingestArtifacts', {
      ingestJobId, stepName: 'preprocessLaughAudio', kind: 'scoreTrack',
      isCanonical: true, path: `set-ingest/${setId}/score-track.json`, fileName: 'score-track.json',
    });
    const lineId = await ctx.db.insert('lines', { breakdownId, ordinal: 1, startSeconds: 0, endSeconds: duration,
      text: 'A line', wordCount: 2, laughCount: 0, laughIntensityScore: 0 });
    return { setId, breakdownId, ingestJobId, uploadSessionId, mediaId, lineId, mediaKey: `set-ingest/${setId}/retained.wav` };
  });
  return { t, asOwner, ...ids, duration };
}

async function archiveWords(f: Awaited<ReturnType<typeof prepared>>, words: Array<{ word: string; start: number }>) {
  await f.t.run(async ctx => {
    await ctx.db.patch(f.lineId, { text: words.map(word => word.word).join(' '), wordCount: words.length });
    await ctx.db.insert('ingestArtifacts', {
      ingestJobId: f.ingestJobId, stepName: 'transcribeWords', kind: 'transcriptRaw',
      isCanonical: true, path: 'transcript-raw.json', fileName: 'transcript-raw.json',
    });
  });
  return new Response(JSON.stringify({ words: words.map(word => ({ ...word, end: word.start + 0.01 })) }));
}

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('calibration commitment and publication', () => {
  it('fits the new residual score track and preserves manual marks', async () => {
    const f = await prepared(65);
    await f.t.run(ctx => ctx.db.patch(f.ingestJobId, { laughAudioVersion: 'mossformer2-residual-v1' }));
    await f.asOwner.action(api.calibration.confirm, {
      uploadSessionId: f.uploadSessionId, intervals: [{ start: 1, end: 2 }],
    });
    const scores = Array.from({ length: 1625 }, (_, index) =>
      (index >= 25 && index < 50) || (index >= 1550 && index < 1575) ? 0.04 : 0.01,
    );
    const transcript = await archiveWords(f, [{ word: 'First', start: 0 }, { word: 'second', start: 61 }]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      version: 'spectral-difference-v1', preprocessingVersion: 'mossformer2-residual-v1',
      retainedMediaKey: f.mediaKey, retainedMediaSha256: 'a'.repeat(64),
      totalDuration: 65, frameSeconds: 0.04, intensityReference: 0.03, scores,
    }))).mockResolvedValueOnce(transcript));

    await f.t.action(internal.calibration.publishManual, { ingestJobId: f.ingestJobId });
    expect(await f.asOwner.query(api.sets.getSetPageForViewer, { setId: f.setId })).toMatchObject({
      breakdown: { laughSeedingState: 'ready' },
      analysisData: { segments: [{ start_time: 1, end_time: 2 }, { start_time: 62, end_time: 63 }] },
    });
  });

  it('opens the saved Set before retained media or the Breakdown is ready', async () => {
    vi.useFakeTimers();
    const f = await prepared();
    await f.t.mutation(internal.setIngest.startSetIngest, { ingestJobId: f.ingestJobId });
    await f.t.run(async ctx => {
      await ctx.db.delete(f.mediaId);
      await ctx.db.delete(f.lineId);
      await ctx.db.patch(f.setId, { setStatus: 'playbackPending' });
      await ctx.db.patch(f.breakdownId, { lineSeedingState: 'pending' });
    });
    const args = { uploadSessionId: f.uploadSessionId, intervals: [{ start: 1, end: 2 }] };

    expect(await f.asOwner.action(api.calibration.confirm, args)).toEqual({ setId: f.setId });
    expect(await f.asOwner.query(api.sets.getSetPageForViewer, { setId: f.setId })).toMatchObject({
      activePlaybackSource: null,
      analysisData: null,
      setStatus: 'playbackPending',
    });
    const input = await f.t.query(internal.calibration.getInput, { ingestJobId: f.ingestJobId });
    expect(input?.inputId).toBeDefined();
    await expect(f.asOwner.action(api.calibration.confirm, { ...args, intervals: [] }))
      .resolves.toEqual({ setId: f.setId });
    expect((await f.t.query(internal.calibration.getInput, { ingestJobId: f.ingestJobId }))?.inputId)
      .toBe(input?.inputId);

    await f.t.mutation(internal.setIngest.registerArtifactMetadata, {
      ingestJobId: f.ingestJobId, kind: 'retainedMedia', stepName: 'prepareRetainedMedia',
      key: f.mediaKey, fileName: 'retained.wav', isCanonical: true,
    });
    await f.t.run(async ctx => {
      await ctx.db.patch(f.breakdownId, { lineSeedingState: 'ready' });
      await ctx.db.insert('lines', {
        breakdownId: f.breakdownId, ordinal: 1, startSeconds: 0, endSeconds: f.duration,
        text: 'A line', wordCount: 2, laughCount: 0, laughIntensityScore: 0,
      });
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      version: 'rms-zcr-v1', preprocessingVersion: 'bandpass-afftdn-attenuation-v1',
      retainedMediaKey: f.mediaKey, retainedMediaSha256: 'a'.repeat(64),
      totalDuration: f.duration, frameSeconds: 0.04, intensityReference: 2,
      scores: Array(Math.ceil(f.duration / 0.04)).fill(1),
    }))));
    await f.t.action(internal.calibration.publishManual, { ingestJobId: f.ingestJobId });
    expect(await f.asOwner.query(api.sets.getSetPageForViewer, { setId: f.setId })).toMatchObject({
      breakdown: { laughSeedingState: 'ready' },
      analysisData: { segments: [{ start_time: 1, end_time: 2 }] },
    });
  });

  it.each([12.345, 60])('commits and publishes exact manual labels for a %s-second Set', async duration => {
    const f = await prepared(duration);
    expect(await f.asOwner.query(api.sets.listForViewer)).toEqual([]);
    expect(await f.asOwner.query(api.sets.getSetPageForViewer, { setId: f.setId })).toBeNull();
    const intervals = [{ start: 0.013, end: 0.501 }, { start: 0.502, end: duration - 0.1 }];
    const args = { uploadSessionId: f.uploadSessionId, intervals };
    expect(await f.asOwner.action(api.calibration.confirm, args)).toEqual({ setId: f.setId });
    expect(await f.asOwner.query(api.sets.listForViewer)).toHaveLength(1);
    const input = await f.t.query(internal.calibration.getInput, { ingestJobId: f.ingestJobId });
    const snapshot = JSON.parse(await f.t.run(async ctx => (await ctx.storage.get(input!.inputId!))!.text()));
    expect(snapshot.sample.start).toBe(0);
    expect(snapshot.sample.end).toBeCloseTo(duration, 12);
    expect(snapshot.intervals).toEqual(intervals);
    // Lost-response retry recovers the committed result, even with changed local marks.
    await f.asOwner.action(api.calibration.confirm, { ...args, intervals: [] });
    expect((await f.t.query(internal.calibration.getInput, { ingestJobId: f.ingestJobId }))!.inputId).toBe(input!.inputId);
    const transcript = await archiveWords(f, [{ word: 'First', start: 0 }, { word: 'second', start: 0.502 }]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      version: 'rms-zcr-v1', preprocessingVersion: 'bandpass-afftdn-attenuation-v1', retainedMediaKey: f.mediaKey, retainedMediaSha256: 'a'.repeat(64),
      totalDuration: duration, frameSeconds: 0.04, intensityReference: 2, scores: Array(Math.ceil(duration / 0.04)).fill(1),
    }))).mockResolvedValueOnce(transcript));
    await f.t.action(internal.calibration.publishManual, { ingestJobId: f.ingestJobId });
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining("storage.bunnycdn.com"), {
      headers: { AccessKey: expect.any(String) },
    });
    const saved = await f.t.run(async ctx => ({
      regions: await ctx.db.query('laughRegions').collect(),
      job: await ctx.db.get(f.ingestJobId), breakdown: await ctx.db.get(f.breakdownId),
    }));
    expect(saved.regions.map(r => ({ start: r.startSeconds, end: r.endSeconds }))).toEqual(intervals);
    expect(new Set(saved.regions.map(r => r.lineId)).size).toBe(2);
    expect(saved.regions.every(r => r.intensityScore === 0.2857)).toBe(true);
    expect(saved.breakdown?.editability).toBe('editable');
    expect(saved.job?.calibrationStatus).toBe('succeeded');
    const result = JSON.parse(await f.t.run(async ctx => (await ctx.storage.get(saved.job!.calibrationResultId!))!.text()));
    expect(result).toMatchObject({ mode: 'manual-only', reason: 'no-remainder', candidateCount: 0, inputHash: input!.inputHash, retainedMediaKey: f.mediaKey });
    expect(result).not.toHaveProperty('threshold');
    await f.t.run(ctx => ctx.db.patch(saved.regions[0]._id, { intensityScore: 0.9 }));
    await f.t.action(internal.calibration.publishManual, { ingestJobId: f.ingestJobId });
    expect((await f.t.run(ctx => ctx.db.get(saved.regions[0]._id)))!.intensityScore).toBe(0.9);
    await f.t.mutation(internal.uploadLifecycle.expire, { uploadSessionId: f.uploadSessionId });
    expect(await f.t.run(ctx => ctx.db.get(f.setId))).not.toBeNull();
  });

  it('publishes a selected minute and calibrated laughter on both sides of it', async () => {
    const f = await prepared(90);
    const intervals = [{ start: 23.013, end: 24.001 }];
    await f.asOwner.action(api.calibration.confirm, { uploadSessionId: f.uploadSessionId, sampleStart: 20, intervals });
    const input = await f.t.query(internal.calibration.getInput, { ingestJobId: f.ingestJobId });
    const snapshot = JSON.parse(await f.t.run(async ctx => (await ctx.storage.get(input!.inputId!))!.text()));
    expect(snapshot.sample).toEqual({ start: 20, end: 80 });
    expect(snapshot.intervals).toEqual(intervals);

    const scores = Array(2250).fill(0.1);
    for (const start of [475, 575, 1975]) scores.fill(1, start, start + 25);
    scores.fill(1, 500, 505); // Automatic region crossing into the annotated minute.
    scores.fill(1, 2000, 2005); // Automatic region crossing out of it.
    const transcript = await archiveWords(f, [
      { word: 'First', start: 12 }, { word: 'second', start: 21 }, { word: 'third', start: 34 },
    ]);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(new Response(JSON.stringify({
      version: 'rms-zcr-v1', preprocessingVersion: 'bandpass-afftdn-attenuation-v1',
      retainedMediaKey: f.mediaKey, retainedMediaSha256: 'a'.repeat(64),
      totalDuration: 90, frameSeconds: 0.04, intensityReference: 2, scores,
    }))).mockResolvedValueOnce(transcript));
    await f.t.action(internal.calibration.publishManual, { ingestJobId: f.ingestJobId });

    const result = await f.t.run(async ctx => {
      const job = await ctx.db.get(f.ingestJobId);
      return JSON.parse(await (await ctx.storage.get(job!.calibrationResultId!))!.text());
    });
    expect(result).toMatchObject({ mode: 'calibrated', threshold: 1, candidateCount: 2 });
    expect(result.regions.map(({ startSeconds, endSeconds, source }: {
      startSeconds: number; endSeconds: number; source: string;
    }) => ({ startSeconds, endSeconds, source }))).toEqual([
      { startSeconds: 19, endSeconds: 20, source: 'automatic' },
      { startSeconds: 23.013, endSeconds: 24.001, source: 'manual' },
      { startSeconds: 80, endSeconds: 80.2, source: 'automatic' },
    ]);
    const savedRegions = await f.t.run(ctx => ctx.db.query('laughRegions').collect());
    expect(savedRegions.map(r => [r.startSeconds, r.endSeconds])).toEqual([
      [19, 20], [23.013, 24.001], [80, 80.2],
    ]);
  });

  it('retries a saved technical failure with the same immutable input and protects published results', async () => {
    vi.useFakeTimers();
    const f = await prepared();
    await f.asOwner.action(api.calibration.confirm, { uploadSessionId: f.uploadSessionId, intervals: [{ start: 1, end: 2 }] });
    const input = await f.t.query(internal.calibration.getInput, { ingestJobId: f.ingestJobId });
    await f.t.mutation(internal.calibration.recordFailure, { ingestJobId: f.ingestJobId });
    await f.t.mutation(internal.setIngest.failJob, { ingestJobId: f.ingestJobId });
    await f.asOwner.mutation(api.calibration.retry, { setId: f.setId });
    const retried = await f.t.run(ctx => ctx.db.get(f.ingestJobId));
    expect(retried).toMatchObject({ status: 'pending', calibrationInputId: input!.inputId, calibrationInputHash: input!.inputHash });
    expect(retried?.workflowId).toBeDefined();
    await f.t.run(async ctx => {
      await ctx.db.patch(f.ingestJobId, { status: 'failed' });
      await ctx.db.insert('laughRegions', { breakdownId: f.breakdownId, lineId: f.lineId, ordinal: 1, startSeconds: 3, endSeconds: 4, intensityScore: 0.9 });
    });
    await expect(f.asOwner.mutation(api.calibration.retry, { setId: f.setId })).rejects.toThrow();
  });

  it('rejects a score track from different media as a technical failure', async () => {
    const f = await prepared();
    await f.asOwner.action(api.calibration.confirm, { uploadSessionId: f.uploadSessionId, intervals: [{ start: 1, end: 2 }] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ retainedMediaKey: 'stale-media' }))));
    await expect(f.t.action(internal.calibration.publishManual, { ingestJobId: f.ingestJobId })).rejects.toThrow('Score track media mismatch');
    expect(await f.t.run(ctx => ctx.db.query('laughRegions').collect())).toEqual([]);
    expect((await f.t.run(ctx => ctx.db.get(f.setId)))?.provisional).toBe(false);
  });

  it('enforces ownership and both classes on the server', async () => {
    const f = await prepared();
    const other = f.t.withIdentity({ ...owner, tokenIdentifier: 'clerk:other' });
    await expect(other.action(api.calibration.confirm, { uploadSessionId: f.uploadSessionId, intervals: [{ start: 1, end: 2 }] })).rejects.toThrow();
    for (const intervals of [[], [{ start: 0, end: 60 }], [{ start: 1, end: 3 }, { start: 2, end: 4 }], [{ start: -1, end: 1 }]]) {
      await expect(f.asOwner.action(api.calibration.confirm, { uploadSessionId: f.uploadSessionId, intervals })).rejects.toThrow();
    }
    expect((await f.t.run(ctx => ctx.db.get(f.setId)))?.provisional).toBe(true);
  });

  it.each(['discard', 'expire'] as const)('%s revokes access and prevents late publication', async operation => {
    vi.useFakeTimers();
    const f = await prepared();
    if (operation === 'discard') await f.asOwner.mutation(api.sets.discardUploadSession, { uploadSessionId: f.uploadSessionId });
    else {
      vi.setSystemTime(Date.now() + 300_001);
      await f.t.mutation(internal.uploadLifecycle.expire, { uploadSessionId: f.uploadSessionId });
    }
    expect(await f.t.run(ctx => ctx.db.get(f.setId))).toBeNull();
    expect((await f.t.run(ctx => ctx.db.query('setDeletionJobs').collect()))).toHaveLength(1);
    await expect(f.asOwner.action(api.calibration.confirm, { uploadSessionId: f.uploadSessionId, intervals: [{ start: 1, end: 2 }] })).rejects.toThrow();
    await f.t.mutation(internal.setIngest.replaceNormalizedLaughRegions, { breakdownId: f.breakdownId, laughRegions: [] });
    expect(await f.t.run(ctx => ctx.db.query('laughRegions').collect())).toEqual([]);
    for (let i = 0; i < 12; i++) await f.t.mutation(internal.setDeletion.deleteDataBatch, {
      deletionJobId: (await f.t.run(ctx => ctx.db.query('setDeletionJobs').first()))!._id,
    });
    expect(await f.t.run(ctx => ctx.db.query('ingestJobs').collect())).toEqual([]);
    expect(await f.t.run(ctx => ctx.db.query('lines').collect())).toEqual([]);
  });

  it('active contact extends life, but an expired upload cannot revive or commit', async () => {
    vi.useFakeTimers();
    const f = await prepared();
    vi.setSystemTime(Date.now() + 240_000);
    expect(await f.asOwner.mutation(api.uploadLifecycle.contact, { uploadSessionId: f.uploadSessionId })).toBe(true);
    vi.setSystemTime(Date.now() + 240_000);
    await f.t.mutation(internal.uploadLifecycle.expire, { uploadSessionId: f.uploadSessionId });
    expect(await f.t.run(ctx => ctx.db.get(f.setId))).not.toBeNull();
    vi.setSystemTime(Date.now() + 60_001);
    await expect(f.asOwner.action(api.calibration.confirm, { uploadSessionId: f.uploadSessionId, intervals: [{ start: 1, end: 2 }] })).rejects.toThrow();
    expect(await f.asOwner.mutation(api.uploadLifecycle.contact, { uploadSessionId: f.uploadSessionId })).toBe(false);
    expect(await f.t.run(ctx => ctx.db.get(f.setId))).toBeNull();
  });
});

it('discard tracks both the analysis and independent playback workflow for cancellation', async () => {
  vi.useFakeTimers();
  const f = await prepared();
  await f.t.run(ctx => ctx.db.patch(f.ingestJobId, { workflowId: 'analysis-workflow', playbackWorkflowId: 'playback-workflow' }));
  await f.asOwner.mutation(api.sets.discardUploadSession, { uploadSessionId: f.uploadSessionId });
  const deletion = await f.t.run(ctx => ctx.db.query('setDeletionJobs').first());
  const snapshot = await f.t.query(internal.setDeletion.getCleanupSnapshot, { deletionJobId: deletion!._id });
  expect(snapshot?.workflowIds).toEqual(['analysis-workflow', 'playback-workflow']);
});
