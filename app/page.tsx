'use client'

import { SignInButton, SignUpButton } from '@clerk/nextjs'
import {
  Authenticated,
  AuthLoading,
  Unauthenticated,
  useQuery,
} from 'convex/react'
import { api } from '../convex/_generated/api'

export default function Home() {
  return (
    <main className="min-h-[calc(100vh-4rem)] bg-zinc-50 px-6 py-16 text-zinc-950">
      <div className="mx-auto flex w-full max-w-4xl flex-col gap-6">
        <section className="rounded-3xl border border-zinc-200 bg-white p-8 shadow-sm">
          <p className="text-sm font-medium uppercase tracking-[0.2em] text-zinc-500">
            Clerk to Convex
          </p>
          <h1 className="mt-4 text-4xl font-semibold tracking-tight sm:text-5xl">
            Finish the auth bridge, then verify Convex can see the signed-in user.
          </h1>
          <p className="mt-4 max-w-2xl text-base leading-7 text-zinc-600">
            This page now checks Convex auth state, not just Clerk UI state, so
            we can confirm the backend is receiving a valid Clerk token.
          </p>
        </section>

        <AuthLoading>
          <section className="rounded-3xl border border-dashed border-zinc-300 bg-white p-8">
            <p className="text-sm text-zinc-500">Waiting for Clerk and Convex to finish connecting...</p>
          </section>
        </AuthLoading>

        <Unauthenticated>
          <section className="rounded-3xl border border-zinc-200 bg-white p-8 shadow-sm">
            <h2 className="text-2xl font-semibold">Sign in to test the Convex session</h2>
            <p className="mt-3 max-w-xl text-zinc-600">
              After sign-in, this page will call a protected Convex query and
              show the identity returned by <code>ctx.auth.getUserIdentity()</code>.
            </p>
            <div className="mt-6 flex flex-wrap gap-3">
              <SignInButton mode="modal">
                <button className="rounded-full bg-zinc-950 px-5 py-3 text-sm font-medium text-white transition hover:bg-zinc-800">
                  Sign in
                </button>
              </SignInButton>
              <SignUpButton mode="modal">
                <button className="rounded-full border border-zinc-300 px-5 py-3 text-sm font-medium text-zinc-900 transition hover:border-zinc-900">
                  Create account
                </button>
              </SignUpButton>
            </div>
          </section>
        </Unauthenticated>

        <Authenticated>
          <SignedInState />
        </Authenticated>
      </div>
    </main>
  )
}

function SignedInState() {
  const viewer = useQuery(api.auth.viewer, {})

  return (
    <section className="rounded-3xl border border-emerald-200 bg-emerald-50 p-8 shadow-sm">
      <h2 className="text-2xl font-semibold text-emerald-950">
        {viewer ? 'Convex sees your Clerk identity.' : 'Checking the authenticated Convex query...'}
      </h2>

      {viewer === undefined ? (
        <p className="mt-3 text-emerald-900/80">
          The signed-in query is still loading.
        </p>
      ) : viewer === null ? (
        <p className="mt-3 text-amber-700">
          Clerk says you are signed in, but Convex still returned no identity.
          If that persists, activate the Clerk Convex integration in the Clerk
          dashboard and sign out and back in again.
        </p>
      ) : (
        <div className="mt-6 grid gap-4 sm:grid-cols-2">
          <IdentityCard label="Name" value={viewer.name ?? 'No name on token'} />
          <IdentityCard label="Email" value={viewer.email ?? 'No email on token'} />
          <IdentityCard label="Subject" value={viewer.subject} />
          <IdentityCard label="Token identifier" value={viewer.tokenIdentifier} />
        </div>
      )}
    </section>
  )
}

function IdentityCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-2xl border border-emerald-200 bg-white p-4">
      <p className="text-xs font-medium uppercase tracking-[0.2em] text-emerald-700">
        {label}
      </p>
      <p className="mt-2 break-all font-mono text-sm text-zinc-900">{value}</p>
    </div>
  )
}
