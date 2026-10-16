'use client'

import { useEffect, useRef, useState } from 'react'
import { validateManualSample } from '../../lib/calibration'
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
  onConfirm: (regions: Region[]) => void;
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

  const [zoom, setZoom] = useState(1)
  const [loop, setLoop] = useState(true)
  const [playing, setPlaying] = useState(false)
  const [frames, setFrames] = useState<string[]>([])
  const video = useRef<HTMLVideoElement>(null)
  const timeline = useRef<HTMLDivElement>(null)
  const dragging = useRef<{ kind: 'sample' | 'create' | 'start' | 'end'; origin: number; index?: number; sample: number } | null>(null)
  const [draft, setDraft] = useState<Region | null>(null)
  const length = Math.min(60, duration)
  const end = sample + length
  const annotating = step === 'annotate'
  const viewStart = annotating ? sample : 0
  const viewLength = annotating ? length : duration
  let valid = true
  try { validateManualSample(duration, regions) } catch { valid = false }
  const percent = (value: number) => (value - viewStart) / viewLength * 100
  function seek(value: number) {
    const next = clamp(value, annotating ? sample : 0, annotating ? end : duration)
    setCursor(next)
    if (video.current) video.current.currentTime = next + props.trimStart
  }
  function add(a: number, b: number) {
    const start = clamp(Math.min(a, b), sample, end)
    const finish = clamp(Math.max(a, b), sample, end)
    if (finish > start) setRegions(old => [...old, { start, end: finish }].sort((a, b) => a.start - b.start))
  }
  function seconds(clientX: number) {
    const bounds = timeline.current!.getBoundingClientRect()
    return viewStart + clamp((clientX - bounds.left) / bounds.width, 0, 1) * viewLength
  }
  function move(clientX: number) {
    const action = dragging.current
    if (!action) return
    const value = seconds(clientX)
    if (action.kind === 'sample') {
      const next = clamp(action.sample + value - action.origin, 0, duration - length)
      setSample(next); seek(next)
    } else if (action.kind === 'create') setDraft({ start: Math.min(action.origin, value), end: Math.max(action.origin, value) })
    else {
      setRegions(old => old.map((region, index) => index !== action.index ? region : {
        ...region, [action.kind]: action.kind === 'start' ? clamp(value, sample, region.end - .05) : clamp(value, region.start + .05, end),
      }))
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
      if (props.saving || !open || !annotating || (event.target as HTMLElement).closest('input,textarea,select,[contenteditable]')) return
      if (event.key.toLowerCase() === 'i') { event.preventDefault(); setMark(cursor) }
      if (event.key.toLowerCase() === 'o' && mark !== null) { event.preventDefault(); add(mark, cursor); setMark(null) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  })
  function changeStep(next: 'select' | 'annotate') {
    video.current?.pause(); setPlaying(false); setStep(next); setMark(null); seek(sample)
  }
  const player = <div className="flex h-[min(50dvh,34rem)] min-h-48 items-center justify-center overflow-hidden border-2 border-[#1a1a1a] bg-black sm:min-h-56">
    <video key={step} ref={video} src={source} controls playsInline className="block h-full w-full bg-black object-contain" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onLoadedMetadata={e => {
      e.currentTarget.currentTime = props.trimStart + sample; setCursor(sample)
    }} onTimeUpdate={e => {
      const media = e.currentTarget
      const retainedTime = media.currentTime - props.trimStart
      if (!media.paused && (retainedTime >= end || retainedTime < sample)) {
        if (loop) media.currentTime = props.trimStart + sample
        else { media.pause(); media.currentTime = props.trimStart + end }
      }
      setCursor(clamp(media.currentTime - props.trimStart, 0, duration))
    }} />
  </div>
  const strip = <div className="overflow-x-auto">
    <div ref={timeline} className={`relative touch-none select-none overflow-hidden border-2 border-[#1a1a1a] bg-[#f0ede8] ${annotating ? 'h-24 sm:h-28 cursor-crosshair' : 'h-24 sm:h-28 cursor-pointer'}`} style={{ width: `${annotating ? zoom * 100 : 100}%` }} onPointerDown={e => {
      if (props.saving || e.button !== 0) return
      const value = seconds(e.clientX)
      if (!dragging.current) {
        if (annotating) { dragging.current = { kind: 'create', origin: value, sample }; setDraft({ start: value, end: value }) }
        else { seek(value); return }
      }
      e.currentTarget.setPointerCapture(e.pointerId)
    }} onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) move(e.clientX) }} onPointerUp={e => {
      const action = dragging.current
      if (action?.kind === 'create') { const value = seconds(e.clientX); if (Math.abs(action.origin - value) < .05) seek(value); else add(action.origin, value) }
      dragging.current = null; setDraft(null)
      if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId)
    }} onPointerCancel={() => { dragging.current = null; setDraft(null) }}>
      <div className="pointer-events-none grid h-full grid-cols-8">{Array.from({ length: 8 }, (_, index) => frames[index] ? <img key={index} src={frames[index]} alt="" className="h-full w-full object-cover" /> : <div key={index} className="border-r border-[#d4cec6] bg-[linear-gradient(180deg,#e3ddd6_0%,#f7f3ee_100%)]" />)}</div>
      {!annotating ? <>
        <div className="pointer-events-none absolute inset-y-0 left-0 bg-[#1a1a1a]/55" style={{ width: `${percent(sample)}%` }} />
        <div className="pointer-events-none absolute inset-y-0 right-0 bg-[#1a1a1a]/55" style={{ width: `${100 - percent(end)}%` }} />
        <div role="slider" aria-label="Calibration sample position" aria-valuenow={sample} aria-valuemin={0} aria-valuemax={duration - length} tabIndex={0} className="absolute inset-y-0 cursor-grab border-2 border-[#1a1a1a] bg-[#ffd966]/25 active:cursor-grabbing" style={{ left: `${percent(sample)}%`, width: `${length / duration * 100}%` }} onKeyDown={e => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') { e.preventDefault(); const next = clamp(sample + (e.key === 'ArrowLeft' ? -1 : 1), 0, duration - length); setSample(next); seek(next) }
        }} onPointerDown={e => { dragging.current = { kind: 'sample', origin: seconds(e.clientX), sample } }}>
          <span className="absolute left-0 top-1/2 flex h-5 w-4 -translate-y-1/2 items-center justify-center border-2 border-black bg-[#c41e3a]"><GripVertical className="size-3 text-white" /></span>
          <span className="absolute right-0 top-1/2 flex h-5 w-4 -translate-y-1/2 items-center justify-center border-2 border-black bg-[#c41e3a]"><GripVertical className="size-3 text-white" /></span>
        </div>
      </> : <>{regions.map((region, index) => <div key={index} className="absolute inset-y-1 border-2 border-[#1a1a1a] bg-[#ffd966]/80" style={{ left: `${percent(region.start)}%`, width: `${(region.end - region.start) / length * 100}%` }}>
        <span className="pointer-events-none px-3 text-[10px] font-black">{index + 1}</span>
        <button aria-label={`Delete laugh ${index + 1}`} className="absolute right-3 top-1 bg-[#ffd966] p-1" onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); setRegions(old => old.filter((_, i) => i !== index)) }}><Trash2 className="size-3" /></button>
        {(['start', 'end'] as const).map(edge => <button key={edge} aria-label={`Drag laugh ${index + 1} ${edge}`} className={`absolute inset-y-0 w-3 cursor-ew-resize border-black bg-[#c41e3a] ${edge === 'start' ? 'left-0 border-r-2' : 'right-0 border-l-2'}`} onPointerDown={() => { dragging.current = { kind: edge, origin: 0, index, sample } }} />)}
      </div>)}{draft && <div className="pointer-events-none absolute inset-y-1 border-2 border-black bg-[#ffd966]/60" style={{ left: `${percent(draft.start)}%`, width: `${(draft.end - draft.start) / length * 100}%` }} />}</>}
      <div className="pointer-events-none absolute inset-y-0 w-[3px] bg-[#c41e3a]" style={{ left: `calc(${percent(cursor)}% - 1px)` }} />
    </div>
  </div>
  return <>
    <Dialog key={step} open={open} onOpenChange={next => { if (!next && !props.saving) props.onDiscard() }}>
      <DialogContent className="flex h-[calc(100dvh-1rem)] max-h-[60rem] max-w-6xl flex-col overflow-hidden p-0 sm:h-auto sm:max-h-[calc(100dvh-2rem)]">
        <DialogHeader><DialogTitle>{annotating ? 'Mark the laughs' : 'Select Calibration Sample'}</DialogTitle><DialogDescription>{annotating ? 'Step 2 of 2 · Mark every laugh in your selected sample' : 'Trim confirmed · Step 1 of 2 · Use the whole retained Set'}</DialogDescription></DialogHeader>
        <fieldset disabled={props.saving} className="grid min-h-0 flex-1 gap-3 overflow-y-auto p-3 sm:p-4">
          {player}
          {strip}
          <div className="flex justify-between gap-2 font-mono text-[11px] text-[#6d675f]"><span>{stamp(viewStart)}</span><span className="text-center">{annotating ? 'Drag to mark laughter · drag red edges to retime' : 'Entire retained Set'}</span><span>{stamp(viewStart + viewLength)}</span></div>
          {!annotating ? <>
            <p className="text-xs text-[#6d675f]">The whole retained Set is your sample. Include laughter and unmarked non-laughter.</p>
          </> : <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => { if (!video.current) return; if (video.current.paused) void video.current.play(); else video.current.pause() }}>{playing ? <Pause /> : <Play />} {playing ? 'Pause' : 'Play'}</Button><Button size="sm" variant="outline" onClick={() => setMark(cursor)}>Start laugh (I)</Button><Button size="sm" variant="outline" disabled={mark === null} onClick={() => { add(mark!, cursor); setMark(null) }}>End laugh (O)</Button></div>
              <div className="flex items-center gap-3 text-xs"><label><input type="checkbox" checked={loop} onChange={e => setLoop(e.target.checked)} /> Loop sample</label><label className="flex items-center gap-2">Zoom<input aria-label="Timeline zoom" type="range" min="1" max="5" value={zoom} onChange={e => setZoom(+e.target.value)} className="w-20" /></label></div>
            </div>
            {mark !== null && <p className="text-xs">Laugh starts at {stamp(mark)}. Mark its end with O.</p>}
          </>}
          {annotating && !valid && <p role="status" className="text-xs">Mark laughter and leave non-laughter unmarked. Marks must not overlap.</p>}
          {props.error && <p role="alert" className="text-sm text-[#a61b32]">Upload not saved. {props.error}</p>}
        </fieldset>
        <DialogFooter className="shrink-0 border-t-2 border-[#1a1a1a] bg-[#faf8f5] p-3 sm:p-4">
          <Button disabled={props.saving} variant="outline" onClick={props.onDiscard}>Cancel</Button>
          {annotating && <Button disabled={props.saving} variant="outline" onClick={() => {
            if (regions.length && !window.confirm('Discard existing laugh marks?')) return
            setRegions([]); changeStep('select')
          }}>Choose another sample</Button>}
          <Button disabled={props.saving || (annotating && (!valid || mark !== null))} onClick={() => {
            if (!annotating) { setZoom(1); changeStep('annotate') }
            else { video.current?.pause(); props.onConfirm(regions) }
          }}><Check />{props.saving ? 'Saving…' : annotating ? 'Confirm Calibration' : 'Use whole Set'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}

