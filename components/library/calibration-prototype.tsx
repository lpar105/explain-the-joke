'use client'

// Throwaway two-modal continuation of the trim flow. Local media only; no mutations.
import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { Check, GripVertical, Pause, Play, Trash2 } from 'lucide-react'
import { Button } from '../ui/button'

import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../ui/dialog'

type Region = { start: number; end: number }
const stamp = (value: number) => `${Math.floor(value / 60)}:${(value % 60).toFixed(1).padStart(4, '0')}`
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value))


export default function CalibrationPrototype() {
  const params = useSearchParams()
  if (process.env.NODE_ENV === 'production' || params.get('prototype') !== 'calibration') return null
  return <CalibrationModals />
}

function CalibrationModals() {
  const [step, setStep] = useState<'select' | 'annotate'>('select')
  const [open, setOpen] = useState(true)
  const [source, setSource] = useState('')
  const [duration, setDuration] = useState(180)
  const [sample, setSample] = useState(0)
  const [cursor, setCursor] = useState(0)
  const [regions, setRegions] = useState<Region[]>([])
  const [mark, setMark] = useState<number | null>(null)

  const [complete, setComplete] = useState(false)
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
  const merged = regions.slice().sort((a, b) => a.start - b.start).reduce<Region[]>((all, region) => {
    const last = all.at(-1)
    if (last && last.end >= region.start) last.end = Math.max(last.end, region.end)
    else all.push({ ...region })
    return all
  }, [])
  const positive = merged.reduce((sum, region) => sum + region.end - region.start, 0)
  const valid = positive > 0 && positive < length
  const percent = (value: number) => (value - viewStart) / viewLength * 100
  function seek(value: number) {
    const next = clamp(value, annotating ? sample : 0, annotating ? end : duration)
    setCursor(next)
    if (video.current) video.current.currentTime = next
  }
  function add(a: number, b: number) {
    const start = clamp(Math.min(a, b), sample, end)
    const finish = clamp(Math.max(a, b), sample, end)
    if (finish - start >= .05) setRegions(old => [...old, { start, end: finish }])
    setComplete(false)
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
      setComplete(false)
    }
  }
  useEffect(() => () => { if (source) URL.revokeObjectURL(source) }, [source])
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
      if (index < 8) preview.currentTime = viewStart + viewLength * (index + .5) / 8
    }
    preview.onloadedmetadata = () => { preview.currentTime = viewStart + viewLength / 16 }
    preview.onseeked = capture
    return () => { cancelled = true; preview.onseeked = null; preview.onloadedmetadata = null; preview.removeAttribute('src'); preview.load() }
  }, [source, viewStart, viewLength])
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!open || !annotating || (event.target as HTMLElement).closest('input,textarea,select,[contenteditable]')) return
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
    {source ? <video key={step} ref={video} src={source} controls playsInline className="block h-full w-full bg-black object-contain" onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} onLoadedMetadata={e => {
      setDuration(e.currentTarget.duration); e.currentTarget.currentTime = sample; setCursor(sample)
    }} onTimeUpdate={e => {
      const media = e.currentTarget
      if (!media.paused && (media.currentTime >= end || media.currentTime < sample)) {
        if (loop) media.currentTime = sample
        else { media.pause(); media.currentTime = end }
      }
      setCursor(media.currentTime)
    }} /> : <label className="flex cursor-pointer flex-col items-center gap-3 px-6 text-center text-[#faf8f5]"><Play className="size-10" /><span className="text-sm font-bold">Choose a local video to preview this flow</span><span className="text-xs text-white/60">Prototype only · video stays on your device</span><input aria-label="Choose local preview video" type="file" accept="video/*" className="max-w-64 text-xs" onChange={e => {
      const file = e.target.files?.[0]
      if (file) { setSource(URL.createObjectURL(file)); setSample(0); setCursor(0); setFrames([]); setRegions([]); setMark(null); setStep('select') }
    }} /></label>}
  </div>
  const strip = <div className="overflow-x-auto">
    <div ref={timeline} className={`relative touch-none select-none overflow-hidden border-2 border-[#1a1a1a] bg-[#f0ede8] ${annotating ? 'h-24 sm:h-28 cursor-crosshair' : 'h-24 sm:h-28 cursor-pointer'}`} style={{ width: `${annotating ? zoom * 100 : 100}%` }} onPointerDown={e => {
      if (e.button !== 0) return
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
    {!open && <div className="border-2 border-black bg-[#f0ede8] p-4"><p className="mb-3 text-sm">{complete ? 'Calibration confirmed in this prototype.' : 'Calibration prototype closed.'}</p><Button onClick={() => { setComplete(false); setOpen(true) }}>Reopen calibration prototype</Button></div>}
    <Dialog key={step} open={open} onOpenChange={setOpen}>
      <DialogContent className="flex h-[calc(100dvh-1rem)] max-h-[60rem] max-w-6xl flex-col overflow-hidden p-0 sm:h-auto sm:max-h-[calc(100dvh-2rem)]">
        <DialogHeader><DialogTitle>{annotating ? 'Mark the laughs' : 'Select Calibration Sample'}</DialogTitle><DialogDescription>{annotating ? 'Step 2 of 2 · Mark every laugh in your selected sample' : 'Trim confirmed · Step 1 of 2 · Choose a minute with laughter and non-laughter'}</DialogDescription></DialogHeader>
        <div className="grid min-h-0 flex-1 gap-3 overflow-y-auto p-3 sm:p-4">
          {player}
          {strip}
          <div className="flex justify-between gap-2 font-mono text-[11px] text-[#6d675f]"><span>{stamp(viewStart)}</span><span className="text-center">{annotating ? 'Drag to mark laughter · drag red edges to retime' : `Drag the highlighted window · fixed ${length.toFixed(0)}-second selection`}</span><span>{stamp(viewStart + viewLength)}</span></div>
          {!annotating ? <>
            <p className="text-xs text-[#6d675f]">Choose a continuous minute containing both laughter and non-laughter. For a Set shorter than a minute, use the whole Set.</p>
          </> : <>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => { if (!video.current) return; if (video.current.paused) void video.current.play(); else video.current.pause() }}>{playing ? <Pause /> : <Play />} {playing ? 'Pause' : 'Play'}</Button><Button size="sm" variant="outline" onClick={() => setMark(cursor)}>Start laugh (I)</Button><Button size="sm" variant="outline" disabled={mark === null} onClick={() => { add(mark!, cursor); setMark(null) }}>End laugh (O)</Button></div>
              <div className="flex items-center gap-3 text-xs"><label><input type="checkbox" checked={loop} onChange={e => setLoop(e.target.checked)} /> Loop sample</label><label className="flex items-center gap-2">Zoom<input aria-label="Timeline zoom" type="range" min="1" max="5" value={zoom} onChange={e => setZoom(+e.target.value)} className="w-20" /></label></div>
            </div>
            {mark !== null && <p className="text-xs">Laugh starts at {stamp(mark)}. Mark its end with O.</p>}
          </>}
        </div>
        <DialogFooter className="shrink-0 border-t-2 border-[#1a1a1a] bg-[#faf8f5] p-3 sm:p-4">
          <span className="mr-auto font-mono text-[10px] uppercase text-[#6d675f]">Prototype · nothing saved</span>
          <Button variant="outline" onClick={() => { if (annotating) changeStep('select'); else setOpen(false) }}>{annotating ? 'Choose another sample' : 'Cancel'}</Button>
          <Button disabled={annotating && (!valid || mark !== null)} onClick={() => {
            if (!annotating) { setRegions([]); setZoom(1); changeStep('annotate') }
            else { setComplete(true); setOpen(false) }
          }}><Check />{annotating ? 'Confirm Calibration' : `Use ${length.toFixed(0)}-Second Sample`}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  </>
}

