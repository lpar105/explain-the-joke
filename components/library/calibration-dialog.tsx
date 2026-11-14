'use client'

import { useEffect, useRef, useState } from 'react'
import { CALIBRATION_SAMPLE_SECONDS, constrainLaughMark, retimeLaughMark, validateManualSample } from '../../lib/calibration'
import { Check, GripVertical, Pause, Play, Trash2 } from 'lucide-react'
import { Button } from '../ui/button'

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'

type Region = { start: number; end: number }
const stamp = (value: number) => `${Math.floor(value / 60)}:${(value % 60).toFixed(1).padStart(4, '0')}`
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))


type CalibrationProps = {
  source: string;
  duration: number;
  trimStart: number;
  saving: boolean;
  error: string | null;
  onConfirm: (sampleStart: number, regions: Region[]) => void;
  onDiscard: () => void;
};

export default function CalibrationDialog(props: CalibrationProps) {
  const { source, duration } = props;
  const [step, setStep] = useState<'select' | 'annotate'>('select')
  const open = true
  const [sample, setSample] = useState(0)
  const [cursor, setCursor] = useState(0)
  const [regions, setRegions] = useState<Region[]>([])
  const [mark, setMark] = useState<number | null>(null)

  const [playing, setPlaying] = useState(false)
  const [frames, setFrames] = useState<string[]>([])
  const video = useRef<HTMLVideoElement>(null)
  const timeline = useRef<HTMLDivElement>(null)
  const dragging = useRef<{ kind: 'sample' | 'create' | 'start' | 'end'; origin: number; index?: number; sample: number } | null>(null)
  const [draft, setDraft] = useState<Region | null>(null)
  const length = Math.min(CALIBRATION_SAMPLE_SECONDS, duration)
  const lastSampleStart = duration - length
  const canChooseSample = lastSampleStart > 0
  const end = Math.min(duration, sample + length)
  const sampleBounds = { start: sample, end }
  const annotating = step === 'annotate'
  const viewStart = annotating ? sample : 0
  const viewLength = annotating ? length : duration
  let valid = true
  try { validateManualSample(duration, regions, sample) } catch { valid = false }
  const percent = (value: number) => (value - viewStart) / viewLength * 100
  function seek(value: number) {
    const next = clamp(value, annotating ? sample : 0, annotating ? end : duration)
    setCursor(next)
    if (video.current) video.current.currentTime = next + props.trimStart
  }
  function togglePlayback() {
    const media = video.current
    if (!media) return
    if (media.paused) void media.play()
    else media.pause()
  }
  function add(a: number, b: number) {
    setRegions(old => {
      const region = constrainLaughMark(a, b, sampleBounds, old)
      return region ? [...old, region].sort((a, b) => a.start - b.start) : old
    })
  }
  function seconds(clientX: number) {
    const bounds = timeline.current!.getBoundingClientRect()
    return viewStart + (clientX - bounds.left) / bounds.width * viewLength
  }
  function move(clientX: number) {
    const action = dragging.current
    if (!action) return
    const value = seconds(clientX)
    if (action.kind === 'sample') {
      const next = clamp(action.sample + value - action.origin, 0, lastSampleStart)
      setSample(next); seek(next)
    } else if (action.kind === 'create') {
      setDraft(constrainLaughMark(action.origin, value, sampleBounds, regions))
    } else if (action.index !== undefined) {
      const { index, kind, origin } = action
      setRegions(old => retimeLaughMark(old, index, kind, value - origin, sampleBounds))
    }
  }
  // Generate actual thumbnails from the local video, like the Mux strip in TrimRangeEditor.
  useEffect(() => {
    if (!source) return
    let cancelled = false
    const preview = document.createElement('video')
    preview.muted = true; preview.preload = 'auto'; preview.src = source
    const canvas = document.createElement('canvas'); canvas.width = 220; canvas.height = 124
    const images: string[] = []
    let index = 0
    const capture = () => {
      if (cancelled) return
      canvas.getContext('2d')?.drawImage(preview, 0, 0, 220, 124)
      images.push(canvas.toDataURL('image/jpeg', .7)); setFrames([...images]); index++
      if (index < 8) preview.currentTime = props.trimStart + viewStart + viewLength * (index + .5) / 8
    }
    preview.onloadedmetadata = () => { preview.currentTime = props.trimStart + viewStart + viewLength / 16 }
    preview.onseeked = capture
    return () => { cancelled = true; preview.onseeked = null; preview.onloadedmetadata = null; preview.removeAttribute('src'); preview.load() }
  }, [source, viewStart, viewLength, props.trimStart])
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (props.saving || !open || !annotating || dragging.current || (event.target as HTMLElement).closest('input,textarea,select,[contenteditable]')) return
      if (event.key === ' ' && !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
        event.preventDefault()
        if (!event.repeat) togglePlayback()
        return
      }
      if (event.key.toLowerCase() === 'i') { event.preventDefault(); setMark(cursor) }
      if (event.key.toLowerCase() === 'o' && mark !== null) { event.preventDefault(); add(mark, cursor); setMark(null) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  })
  function changeStep(next: 'select' | 'annotate') {
    video.current?.pause(); setPlaying(false); setStep(next); setMark(null); seek(sample)
  }
  const player = <div className="relative min-h-14 flex-1 overflow-hidden border-2 border-[#1a1a1a] bg-black">
    <video key={step} ref={video} src={source} controls playsInline className="absolute inset-0 h-full w-full bg-black object-contain" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onLoadedMetadata={e => {
      e.currentTarget.currentTime = props.trimStart + sample; setCursor(sample)
    }} onEnded={e => {
      if (!annotating) return
      e.currentTarget.currentTime = props.trimStart + sample
      void e.currentTarget.play()
    }} onTimeUpdate={e => {
      const media = e.currentTarget
      const retainedTime = media.currentTime - props.trimStart
      const playbackStart = annotating ? sample : 0
      const playbackEnd = annotating ? end : duration
      if (!media.paused && retainedTime < playbackStart) {
        media.currentTime = props.trimStart + playbackStart
      } else if (!media.paused && retainedTime >= playbackEnd) {
        if (annotating) media.currentTime = props.trimStart + playbackStart
        else { media.pause(); media.currentTime = props.trimStart + playbackEnd }
      }
      setCursor(clamp(media.currentTime - props.trimStart, playbackStart, playbackEnd))
    }} />
  </div>
  const strip = <div className="shrink-0 border-2 border-[#1a1a1a] bg-[#f0ede8] px-2">
    <div ref={timeline} aria-label={annotating ? 'Laughter timeline' : 'Calibration sample timeline'} className={`relative h-[clamp(3rem,12dvh,7rem)] touch-none select-none ${annotating ? 'cursor-crosshair' : 'cursor-pointer'}`} onPointerDown={e => {
      if (props.saving || !e.isPrimary || e.button !== 0) return
      const value = seconds(e.clientX)
      if (!dragging.current) {
        if (annotating) dragging.current = { kind: 'create', origin: clamp(value, sample, end), sample }
        else { seek(value); return }
      }
      e.currentTarget.setPointerCapture(e.pointerId)
    }} onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) move(e.clientX) }} onPointerUp={e => {
      if (!e.currentTarget.hasPointerCapture(e.pointerId)) return
      const action = dragging.current
      if (action?.kind === 'create') { const value = seconds(e.clientX); if (Math.abs(action.origin - value) < .05) seek(value); else add(action.origin, value) }
      else move(e.clientX)
      dragging.current = null; setDraft(null)
    }} onLostPointerCapture={() => { dragging.current = null; setDraft(null) }}>
      <div className="pointer-events-none grid h-full grid-cols-8 grid-rows-1 overflow-hidden">{Array.from({ length: 8 }, (_, index) => frames[index] ? <img key={index} src={frames[index]} alt="" className="h-full min-h-0 w-full object-cover" /> : <div key={index} className="border-r border-[#d4cec6] bg-[linear-gradient(180deg,#e3ddd6_0%,#f7f3ee_100%)]" />)}</div>
      {!annotating ? <>
        <div className="pointer-events-none absolute inset-y-0 left-0 bg-[#1a1a1a]/55" style={{ width: `${percent(sample)}%` }} />
        <div className="pointer-events-none absolute inset-y-0 right-0 bg-[#1a1a1a]/55" style={{ width: `${100 - percent(end)}%` }} />
        <div role="slider" aria-label="Calibration sample position" aria-valuetext={stamp(sample) + ' to ' + stamp(end)} aria-valuenow={sample} aria-valuemin={0} aria-valuemax={lastSampleStart} tabIndex={canChooseSample ? 0 : undefined} aria-disabled={!canChooseSample} className={'absolute inset-y-0 border-2 border-[#1a1a1a] bg-[#ffd966]/25 ' + (canChooseSample ? 'cursor-grab active:cursor-grabbing' : '')} style={{ left: `${percent(sample)}%`, width: `${length / duration * 100}%` }} onKeyDown={e => {
          if (!canChooseSample || props.saving) return
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
            e.preventDefault()
            const next = clamp(sample + (e.key === 'ArrowLeft' ? -1 : 1), 0, lastSampleStart)
            setSample(next); seek(next)
          }
        }} onPointerDown={e => {
          if (canChooseSample && !props.saving && e.isPrimary && e.button === 0) {
            dragging.current = { kind: 'sample', origin: seconds(e.clientX), sample }
          }
        }}>
          {canChooseSample && <><span className="absolute left-0 top-1/2 flex h-5 w-4 -translate-y-1/2 items-center justify-center border-2 border-black bg-[#c41e3a]"><GripVertical className="size-3 text-white" /></span>
          <span className="absolute right-0 top-1/2 flex h-5 w-4 -translate-y-1/2 items-center justify-center border-2 border-black bg-[#c41e3a]"><GripVertical className="size-3 text-white" /></span></>}
        </div>
      </> : <>{regions.map((region, index) => <div key={index} className="absolute inset-y-0 bg-[#ffd966]/80" style={{ left: `${percent(region.start)}%`, width: `${(region.end - region.start) / length * 100}%` }}>
        <button aria-label={`Delete laugh ${index + 1}`} className="absolute top-1/2 left-1/2 z-10 -translate-x-1/2 -translate-y-1/2 bg-[#ffd966] p-0.5 focus:z-30" onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); setRegions(old => old.filter((_, i) => i !== index)) }}><Trash2 className="size-3" /></button>
        {(['start', 'end'] as const).map(edge => <button key={edge} aria-label={`Drag laugh ${index + 1} ${edge}`} className={`absolute z-20 h-[30%] w-4 cursor-ew-resize border border-black bg-[#c41e3a] focus:z-30 ${edge === 'start' ? 'top-0 left-0 -translate-x-1/2' : 'right-0 bottom-0 translate-x-1/2'}`} onPointerDown={e => {
          if (props.saving || !e.isPrimary || e.button !== 0) return
          dragging.current = { kind: edge, origin: seconds(e.clientX) - region[edge], index, sample }
        }} />)}
      </div>)}{draft && <div className="pointer-events-none absolute inset-y-0 bg-[#ffd966]/60 ring-1 ring-black ring-inset" style={{ left: `${percent(draft.start)}%`, width: `${(draft.end - draft.start) / length * 100}%` }} />}</>}
      <div className="pointer-events-none absolute inset-y-0 w-[3px] bg-[#c41e3a]" style={{ left: `calc(${percent(cursor)}% - 1px)` }} />
    </div>
  </div>
  return <>
    <Dialog key={step} open={open} onOpenChange={next => { if (!next && !props.saving) props.onDiscard() }}>
      <DialogContent className="flex h-[calc(100dvh-1rem)] max-h-[48rem] max-w-6xl flex-col overflow-y-auto p-0 sm:h-[calc(100dvh-2rem)]">
        <DialogHeader className="shrink-0 py-3 pr-14"><DialogTitle className="text-lg sm:text-2xl">{annotating ? 'Mark the laughs' : 'Select Calibration Sample'}</DialogTitle><DialogDescription className={annotating ? 'sr-only' : undefined}>{annotating ? 'Step 2 of 2 · Mark every laugh in your selected sample' : canChooseSample ? 'Step 1 of 2 · Drag to choose a 60-second sample' : 'Step 1 of 2 · Use the whole retained Set'}</DialogDescription></DialogHeader>
        <fieldset disabled={props.saving} className="contents">
          <div className="flex min-w-0 flex-1 flex-col gap-2 p-2 sm:p-3">
            {player}
            {strip}
            {!annotating ? <>
              <div className="flex justify-between gap-2 font-mono text-[11px] text-[#6d675f]"><span>{stamp(viewStart)}</span><span className="text-center">{canChooseSample ? stamp(sample) + ' to ' + stamp(end) : 'Entire retained Set'}</span><span>{stamp(viewStart + viewLength)}</span></div>
              <p className="text-xs text-[#6d675f]">{canChooseSample ? "Choose a minute with both laughter and non-laughter." : "Include laughter and unmarked non-laughter."}</p>
            </> : <>
              <div className="flex flex-wrap gap-1 sm:gap-2"><Button size="sm" className="px-2 tracking-normal sm:px-3" variant="outline" aria-keyshortcuts="Space" onClick={togglePlayback}>{playing ? <Pause /> : <Play />} {playing ? 'Pause' : 'Play'}</Button><Button size="sm" className="px-2 tracking-normal sm:px-3" variant="outline" onClick={() => setMark(cursor)}>Start laugh (I)</Button><Button size="sm" className="px-2 tracking-normal sm:px-3" variant="outline" disabled={mark === null} onClick={() => { add(mark!, cursor); setMark(null) }}>End laugh (O)</Button></div>
            </>}
            {props.error && <p role="alert" className="text-sm text-[#a61b32]">Upload not saved. {props.error}</p>}
          </div>
        </fieldset>
        <DialogFooter className="shrink-0 border-t-2 border-[#1a1a1a] bg-[#faf8f5] p-2 sm:p-3">
          <Button size="sm" disabled={props.saving} variant="outline" onClick={props.onDiscard}>Cancel</Button>
          {annotating && <Button size="sm" disabled={props.saving} variant="outline" onClick={() => {
            if (regions.length && !window.confirm('Discard existing laugh marks?')) return
            setRegions([]); changeStep('select')
          }}>Choose another sample</Button>}
          <Button size="sm" disabled={props.saving || (annotating && (!valid || mark !== null))} onClick={() => {
            if (!annotating) changeStep('annotate')
            else { video.current?.pause(); props.onConfirm(sample, regions) }
          }}><Check />{props.saving ? 'Saving…' : annotating ? 'Confirm Calibration' : canChooseSample ? 'Use selected minute' : 'Use whole Set'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}

