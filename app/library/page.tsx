'use client'

import { SignInButton, SignUpButton } from '@clerk/nextjs'
import { Authenticated, AuthLoading, Unauthenticated, useMutation, useQuery } from 'convex/react'
import { LoaderCircle, PencilLine, Plus } from 'lucide-react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useMemo, useState } from 'react'

import { api } from '../../convex/_generated/api'
import { Button } from '../../components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import {
  formatCreationDate,
  formatDuration,
  getBreakdownBadgeLabel,
  getBreakdownSummary,
  getSetStatusLabel,
} from '../../lib/set-status'

export default function LibraryPage() {
  return (
    <main className="min-h-[calc(100vh-4.5rem)] bg-[#faf8f5] px-4 py-5 text-[#1a1a1a] md:px-6">
      <div className="mx-auto flex min-h-full max-w-7xl flex-col gap-6">
        <section className="border-2 border-[#1a1a1a] bg-white shadow-[6px_6px_0px_0px_#1a1a1a]">
          <div className="grid gap-4 border-b-2 border-[#1a1a1a] bg-[#f0ede8] p-4 md:grid-cols-[1fr_auto] md:items-end">
            <div>
              <p className="font-mono text-[10px] uppercase tracking-[0.28em] text-[#6d675f]">
                View and Add Sets
              </p>
              <h1 className="mt-2 text-3xl font-black uppercase tracking-tight md:text-5xl">
                My Library
              </h1>
            </div>
            <Authenticated>
              <UploadSetDialog />
            </Authenticated>
          </div>

          <div className="p-4">
            <AuthLoading>
              <LibrarySkeleton />
            </AuthLoading>

            <Unauthenticated>
              <div className="flex min-h-90 flex-col items-center justify-center border-2 border-dashed border-[#1a1a1a] bg-[#f7f3ee] px-6 text-center">
                <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-[#6d675f]">Sign In Required</p>
                <h2 className="mt-3 text-2xl font-black uppercase tracking-tight">
                  Your library appears after sign-in
                </h2>
                <p className="mt-2 max-w-xl text-sm font-medium text-[#5a554f]">
                  Sign in to open your library, upload a new set, or view existing ones.
                </p>
                <div className="mt-5 flex flex-wrap justify-center gap-3">
                  <SignInButton mode="modal">
                    <Button>Sign In</Button>
                  </SignInButton>
                  <SignUpButton mode="modal">
                    <Button variant="outline">Create Account</Button>
                  </SignUpButton>
                </div>
              </div>
            </Unauthenticated>

            <Authenticated>
              <LibraryGrid />
            </Authenticated>
          </div>
        </section>
      </div>
    </main>
  )
}

function UploadSetDialog() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [title, setTitle] = useState('')

  function continueToTrimRange() {
    const params = new URLSearchParams()
    if (title.trim()) {
      params.set('title', title.trim())
    }

    setOpen(false)
    router.push(params.size > 0 ? `/library/new?${params.toString()}` : '/library/new')
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="lg" variant="destructive">
          <Plus className="size-4" />
          Add New Set
        </Button>
      </DialogTrigger>

      <DialogContent className="max-w-xl p-0">
        <DialogHeader>
          <DialogTitle>Upload New Set</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 p-4">
          <label className="grid gap-2">
            <span className="text-[10px] font-black uppercase tracking-[0.2em] text-[#1a1a1a]">
              Set Title
            </span>
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Late Show Crowd Work"
            />
          </label>

          <div className="border-2 border-dashed border-[#1a1a1a] bg-white p-4">
            <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-[#6d675f]">
              Next step
            </p>
            <p className="mt-2 text-sm leading-6 text-[#4f4a43]">
              TEMP This library entry point now acts like the prototype&apos;s upload modal, but it
              keeps the domain contract clean: the next screen is where Trim Range confirmation
              creates the real Set and its locked current Breakdown.
            </p>
          </div>

          <DialogFooter className="border-t-2 border-[#1a1a1a] pt-4">
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={continueToTrimRange}>
              Continue
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function LibraryGrid() {
  const sets = useQuery(api.sets.listForViewer, {})
  const [editingSetId, setEditingSetId] = useState<string | null>(null)

  const activeSet = useMemo(
    () => sets?.find((set) => set._id === editingSetId) ?? null,
    [editingSetId, sets],
  )

  if (sets === undefined) {
    return <LibrarySkeleton />
  }

  if (sets.length === 0) {
    return (
      <div className="flex min-h-[360px] flex-col items-center justify-center border-2 border-dashed border-[#1a1a1a] bg-[#f7f3ee] px-6 text-center">
        <p className="font-mono text-[11px] uppercase tracking-[0.3em] text-[#6d675f]">Empty Rack</p>
        <h2 className="mt-3 text-2xl font-black uppercase tracking-tight">
          No Sets Uploaded Yet
        </h2>
        <p className="mt-2 max-w-xl text-sm font-medium text-[#5a554f]">
          Upload a set to get started!
        </p>
      </div>
    )
  }

  return (
    <>
      <div className="grid grid-cols-1 gap-x-3 gap-y-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
        {sets.map((set) => (
          <LibrarySetCard
            key={set._id}
            set={set}
            onManage={() => setEditingSetId(set._id)}
          />
        ))}
      </div>

      <ManageSetDialog
        key={activeSet?._id ?? 'closed'}
        set={activeSet}
        onOpenChange={(open) => !open && setEditingSetId(null)}
      />
    </>
  )
}

function LibrarySetCard({
  set,
  onManage,
}: {
  set: NonNullable<ReturnType<typeof useQuery<typeof api.sets.listForViewer>>>[number]
  onManage: () => void
}) {
  const breakdown = set.breakdown
  const setStatusLabel = getSetStatusLabel(set.setStatus)
  const breakdownBadge = breakdown
    ? getBreakdownBadgeLabel(
      breakdown.editability,
      breakdown.lineSeedingState,
      breakdown.laughSeedingState,
    )
    : 'No Breakdown'
  const breakdownSummary = breakdown
    ? getBreakdownSummary(
      breakdown.editability,
      breakdown.lineSeedingState,
      breakdown.laughSeedingState,
    )
    : 'No current Breakdown has been linked yet.'
  const retainedDuration = Math.max(
    0,
    set.trimRangeEndSeconds - set.trimRangeStartSeconds,
  )

  return (
    <div className="group relative">
      <Button
        size="icon"
        variant="outline"
        onClick={onManage}
        className="absolute right-2 top-2 z-10 md:opacity-0 md:group-hover:opacity-100"
        aria-label={`Manage ${set.title}`}
      >
        <PencilLine className="size-4" />
      </Button>

      <Link href={`/sets/${set._id}`} className="block">
        <div className="border-2 border-[#1a1a1a] bg-white shadow-[4px_4px_0px_0px_#1a1a1a] transition-transform duration-150 group-hover:-translate-y-1">
          <SetPoster
            setStatusLabel={setStatusLabel}
            breakdownBadge={breakdownBadge}
            isLocked={breakdown?.editability !== 'editable'}
          />

          <div className="grid gap-3 p-3">
            <div className="space-y-1">
              <h2 className="line-clamp-2 pr-11 text-lg font-black uppercase tracking-tight text-[#1a1a1a]">
                {set.title}
              </h2>
              <p className="text-[11px] font-medium text-[#6d675f]">
                {formatCreationDate(set._creationTime)} / {formatDuration(retainedDuration)}
              </p>
            </div>

            <div className="flex flex-wrap gap-2">
              <StatusPill tone="set">{setStatusLabel}</StatusPill>
              <StatusPill
                tone={
                  breakdown?.lineSeedingState === 'failed' || breakdown?.laughSeedingState === 'failed'
                    ? 'error'
                    : breakdown?.editability === 'editable'
                      ? 'success'
                      : 'breakdown'
                }
              >
                {breakdownBadge}
              </StatusPill>
            </div>

            <p className="text-sm leading-6 text-[#4f4a43]">{breakdownSummary}</p>
          </div>
        </div>
      </Link>
    </div>
  )
}

function SetPoster({
  setStatusLabel,
  breakdownBadge,
  isLocked,
}: {
  setStatusLabel: string
  breakdownBadge: string
  isLocked: boolean
}) {
  return (
    <div className="relative aspect-video overflow-hidden bg-[#f0ede8]">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,#ffffff_0%,#f0ede8_50%,#e3ddd6_100%)]" />
      <div className="absolute inset-0 bg-[linear-gradient(135deg,transparent_0%,transparent_47%,rgba(26,26,26,0.08)_47%,rgba(26,26,26,0.08)_53%,transparent_53%,transparent_100%)]" />
      <div className="absolute inset-0 flex flex-col justify-between p-3">
        <div className="flex items-start justify-between gap-2">
          <StatusPill tone="poster">{setStatusLabel}</StatusPill>
        </div>
      </div>
    </div>
  )
}

function StatusPill({
  children,
  tone,
}: {
  children: React.ReactNode
  tone: 'set' | 'breakdown' | 'success' | 'error' | 'poster'
}) {
  const className =
    tone === 'success'
      ? 'bg-[#e7f7ee] text-[#0f5132]'
      : tone === 'error'
        ? 'bg-[#fff0f0] text-[#a61b32]'
        : tone === 'poster'
          ? 'bg-[#1a1a1a] text-[#faf8f5]'
          : tone === 'set'
            ? 'bg-[#1a3a52] text-[#faf8f5]'
            : 'bg-white text-[#1a1a1a]'

  return (
    <span
      className={`inline-flex items-center border-2 border-[#1a1a1a] px-2.5 py-1 text-[10px] font-black uppercase tracking-[0.16em] ${className}`}
    >
      {children}
    </span>
  )
}

function ManageSetDialog({
  set,
  onOpenChange,
}: {
  set: NonNullable<ReturnType<typeof useQuery<typeof api.sets.listForViewer>>>[number] | null
  onOpenChange: (open: boolean) => void
}) {
  const renameSet = useMutation(api.sets.rename)
  const [draftTitle, setDraftTitle] = useState(() => set?.title ?? '')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()

    if (!set) {
      return
    }

    setIsSaving(true)
    setErrorMessage(null)

    try {
      await renameSet({
        setId: set._id,
        title: draftTitle,
      })
      onOpenChange(false)
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : 'Rename failed.')
      setIsSaving(false)
    }
  }

  return (
    <Dialog open={Boolean(set)} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg p-0">
        <DialogHeader>
          <DialogTitle>Manage Set</DialogTitle>
        </DialogHeader>

        {set ? (
          <form onSubmit={handleSubmit} className="grid gap-4 p-4">
            <label className="grid gap-2">
              <span className="text-[10px] font-black uppercase tracking-[0.2em] text-[#1a1a1a]">
                Set Title
              </span>
              <Input
                value={draftTitle}
                onChange={(event) => setDraftTitle(event.target.value)}
                placeholder="Untitled Set"
              />
            </label>

            <div className="border-2 border-[#1a1a1a] bg-white p-3">
              <p className="text-[10px] font-mono uppercase tracking-[0.2em] text-[#6d675f]">
                Not here yet
              </p>
              <p className="mt-2 text-sm leading-6 text-[#4f4a43]">
                Deletion is intentionally not wired into this modal yet because the product model
                routes Set removal through a Trash Window rather than a permanent library delete.
              </p>
            </div>

            {errorMessage ? (
              <p className="border-2 border-[#1a1a1a] bg-[#fff0f0] px-3 py-3 text-sm text-[#a61b32]">
                {errorMessage}
              </p>
            ) : null}

            <DialogFooter className="border-t-2 border-[#1a1a1a] pt-4">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={isSaving}>
                {isSaving ? <LoaderCircle className="size-4 animate-spin" /> : null}
                Save Title
              </Button>
            </DialogFooter>
          </form>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

function LibrarySkeleton() {
  return (
    <div className="grid grid-cols-1 gap-x-3 gap-y-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
      {Array.from({ length: 8 }).map((_, index) => (
        <div
          key={index}
          className="overflow-hidden border-2 border-[#1a1a1a] bg-white shadow-[4px_4px_0px_0px_#1a1a1a]"
        >
          <div className="aspect-video animate-pulse bg-[#f0ede8]" />
          <div className="grid gap-3 p-3">
            <div className="h-5 w-2/3 animate-pulse bg-[#ece7e1]" />
            <div className="h-4 w-1/2 animate-pulse bg-[#f2efeb]" />
            <div className="flex gap-2">
              <div className="h-7 w-28 animate-pulse bg-[#ece7e1]" />
              <div className="h-7 w-32 animate-pulse bg-[#f2efeb]" />
            </div>
            <div className="h-12 animate-pulse bg-[#f6f2ee]" />
          </div>
        </div>
      ))}
    </div>
  )
}
