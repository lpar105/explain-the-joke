'use client'

import { SignInButton, SignUpButton } from '@clerk/nextjs'
import { Authenticated, AuthLoading, Unauthenticated, useMutation, useQuery } from 'convex/react'
import { LoaderCircle, PencilLine, Trash2 } from 'lucide-react'
import Link from 'next/link'
import { Suspense, useMemo, useState } from 'react'
import CalibrationPrototype from '../../components/library/calibration-prototype'

import { api } from '../../convex/_generated/api'
import type { Id } from '../../convex/_generated/dataModel'
import { getAppErrorCodeFromConvexError, getErrorMessageForCode } from '../../lib/errors'
import UploadSetDialog from '../../components/library/upload-set-dialog'
import { Button } from '../../components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../../components/ui/dialog'
import { Input } from '../../components/ui/input'
import {
  formatCreationDate,
  formatDuration,
} from '../../lib/set-status'

type LibrarySet = {
  _id: Id<'sets'>
  _creationTime: number
  currentBreakdownId: Id<'breakdowns'> | null
  setStatus: 'playbackPending' | 'playable' | 'unavailable'
  title: string
  trimRangeEndSeconds: number
  trimRangeStartSeconds: number
  thumbnailUrl: string | null
  activePlaybackSource: {
    _id: Id<'playbackSources'>
    kind: 'temporary' | 'persistent'
    playbackId: string
    provider: 'mux' | 'bunny'
  } | null
  breakdown: {
    _id: Id<'breakdowns'>
    editability: 'locked' | 'editable'
    laughSeedingState: 'pending' | 'running' | 'retrying' | 'ready' | 'failed'
    lineSeedingState: 'pending' | 'running' | 'retrying' | 'ready' | 'failed'
  } | null
}

export default function LibraryPage() {
  return (
    <main className="min-h-[calc(100vh-4.5rem)] bg-[#faf8f5] px-4 py-5 text-[#1a1a1a] md:px-6">
      <Suspense fallback={null}><CalibrationPrototype /></Suspense>
      <div className="mx-auto flex min-h-full max-w-7xl flex-col gap-6">
        <section className="border-2 border-[#1a1a1a] bg-white shadow-[6px_6px_0px_0px_#1a1a1a]">
          <div className="grid gap-4 border-b-2 border-[#1a1a1a] bg-[#f0ede8] p-4 md:grid-cols-[1fr_auto] md:items-end">
            <div>
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

function LibraryGrid() {
  const sets = useQuery(api.sets.listForViewer, {}) as LibrarySet[] | undefined
  const [editingSetId, setEditingSetId] = useState<string | null>(null)
  const [statusMessage, setStatusMessage] = useState<string | null>(null)

  const activeSet = useMemo(
    () => sets?.find((set) => set._id === editingSetId) ?? null,
    [editingSetId, sets],
  )

  if (sets === undefined) {
    return <LibrarySkeleton />
  }

  if (sets.length === 0) {
    return (
      <div className="grid gap-4">
        {statusMessage ? <LibraryStatusMessage message={statusMessage} /> : null}
        <div className="flex min-h-[360px] flex-col items-center justify-center border-2 border-dashed border-[#1a1a1a] bg-[#f7f3ee] px-6 text-center">
          <h2 className="mt-3 text-2xl font-black uppercase tracking-tight">
            No Sets Uploaded Yet
          </h2>
        </div>
      </div>
    )
  }

  return (
    <>
      {statusMessage ? <LibraryStatusMessage message={statusMessage} /> : null}
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
        onDeleted={() => {
          setEditingSetId(null)
          setStatusMessage('Set deleted.')
        }}
        onOpenChange={(open) => !open && setEditingSetId(null)}
      />
    </>
  )
}

function LibrarySetCard({
  set,
  onManage,
}: {
  set: LibrarySet
  onManage: () => void
}) {
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
        className="absolute right-2 top-2 z-10 md:opacity-0 md:group-hover:opacity-100 md:group-focus-within:opacity-100 md:focus-visible:opacity-100"
        aria-label={`Manage ${set.title}`}
      >
        <PencilLine className="size-4" />
      </Button>

      <Link href={`/sets/${set._id}`} className="block">
        <div className="border-2 border-[#1a1a1a] bg-white shadow-[4px_4px_0px_0px_#1a1a1a] transition-transform duration-150 group-hover:-translate-y-1">
          <SetPoster
            title={set.title}
            thumbnailUrl={set.thumbnailUrl}
            fallbackVideoUrl={
              set.activePlaybackSource?.provider === 'bunny'
                ? set.activePlaybackSource.playbackId
                : null
            }
          />

          <div className="grid min-w-0 gap-3 p-3">
            <div className="min-w-0 space-y-1">
              <h2 className="overflow-hidden text-ellipsis whitespace-nowrap pr-11 text-lg font-black uppercase tracking-tight text-[#1a1a1a]">
                {set.title}
              </h2>
              <p className="text-[11px] font-medium text-[#6d675f]">
                {formatCreationDate(set._creationTime)} / {formatDuration(retainedDuration)}
              </p>
            </div>
          </div>
        </div>
      </Link>
    </div>
  )
}

function SetPoster({
  title,
  thumbnailUrl,
  fallbackVideoUrl,
}: {
  title: string
  thumbnailUrl: string | null
  fallbackVideoUrl: string | null
}) {
  return (
    <div className="relative aspect-video overflow-hidden bg-[#f0ede8]">
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top_left,#ffffff_0%,#f0ede8_50%,#e3ddd6_100%)]" />
      <div className="absolute inset-0 bg-[linear-gradient(135deg,transparent_0%,transparent_47%,rgba(26,26,26,0.08)_47%,rgba(26,26,26,0.08)_53%,transparent_53%,transparent_100%)]" />
      {thumbnailUrl ? (
        // These URLs come from the app's configured Mux/Bunny providers and
        // should be fetched directly so a newly-ready thumbnail is not delayed.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={thumbnailUrl}
          src={thumbnailUrl}
          alt={`Video thumbnail for ${title}`}
          loading="lazy"
          className="absolute inset-0 size-full object-cover"
          onError={(event) => {
            event.currentTarget.style.display = 'none'
          }}
        />
      ) : fallbackVideoUrl ? (
        <video
          src={fallbackVideoUrl}
          aria-label={`Video thumbnail for ${title}`}
          preload="metadata"
          muted
          playsInline
          className="absolute inset-0 size-full object-cover"
        />
      ) : null}
    </div>
  )
}

function LibraryStatusMessage({ message }: { message: string }) {
  return (
    <p
      role="status"
      className="border-2 border-[#1a1a1a] bg-[#e8f4ec] px-3 py-3 text-sm font-bold text-[#1a3a2a]"
    >
      {message}
    </p>
  )
}

function ManageSetDialog({
  set,
  onDeleted,
  onOpenChange,
}: {
  set: NonNullable<ReturnType<typeof useQuery<typeof api.sets.listForViewer>>>[number] | null
  onDeleted: () => void
  onOpenChange: (open: boolean) => void
}) {
  const renameSet = useMutation(api.sets.rename)
  const deleteSet = useMutation(api.setDeletion.requestDeletion)
  const [draftTitle, setDraftTitle] = useState(() => set?.title ?? '')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [isSaving, setIsSaving] = useState(false)
  const [isDeleting, setIsDeleting] = useState(false)

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
      const errorCode = getAppErrorCodeFromConvexError(error)
      setErrorMessage(
        errorCode ? getErrorMessageForCode(errorCode) : 'Something went wrong on our side. Try again.',
      )
      setIsSaving(false)
    }
  }

  async function handleDelete() {
    if (!set || isDeleting || isSaving) {
      return
    }

    setIsDeleting(true)
    setErrorMessage(null)

    try {
      await deleteSet({ setId: set._id })
      onDeleted()
    } catch (error) {
      const errorCode = getAppErrorCodeFromConvexError(error)
      setErrorMessage(
        errorCode ? getErrorMessageForCode(errorCode) : 'Something went wrong on our side. Try again.',
      )
      setIsDeleting(false)
    }
  }

  return (
    <Dialog
      open={Boolean(set)}
      onOpenChange={(open) => {
        if (!isSaving && !isDeleting) {
          onOpenChange(open)
        }
      }}
    >
      <DialogContent className="max-w-lg p-0">
        <DialogHeader>
          <DialogTitle>Manage Set</DialogTitle>
          <DialogDescription className="sr-only">
            Rename this Set or review the available management actions.
          </DialogDescription>
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
                disabled={isSaving || isDeleting}
              />
            </label>

            {errorMessage ? (
              <p className="border-2 border-[#1a1a1a] bg-[#fff0f0] px-3 py-3 text-sm text-[#a61b32]">
                {errorMessage}
              </p>
            ) : null}

            <DialogFooter className="border-t-2 border-[#1a1a1a] pt-4">
              <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isSaving || isDeleting}>
                Cancel
              </Button>
              <Button type="submit" disabled={isSaving || isDeleting}>
                {isSaving ? <LoaderCircle className="size-4 animate-spin" /> : null}
                Save Title
              </Button>
            </DialogFooter>

            <section className="grid gap-3 border-2 border-[#c41e3a] bg-[#fff0f0] p-3">
              <div>
                <h3 className="text-sm font-black uppercase tracking-tight text-[#a61b32]">
                  Delete Set
                </h3>
                <p className="mt-1 text-xs font-medium text-[#6d2532]">
                  Permanently deletes this Set, its analysis, and all stored media. This cannot be undone.
                </p>
              </div>
              <Button
                type="button"
                variant="destructive"
                disabled={isSaving || isDeleting}
                onClick={handleDelete}
              >
                {isDeleting ? (
                  <LoaderCircle className="size-4 animate-spin" />
                ) : (
                  <Trash2 className="size-4" />
                )}
                Delete Set
              </Button>
            </section>
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
