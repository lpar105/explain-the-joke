'use client'

import { SignInButton, SignUpButton, UserButton } from '@clerk/nextjs'
import { Authenticated, AuthLoading, Unauthenticated } from 'convex/react'

export default function AuthHeader() {
  return (
    <header className="flex h-16 items-center justify-end gap-3 border-b border-black/5 px-4">
      <AuthLoading>
        <p className="text-sm text-zinc-500">Connecting auth...</p>
      </AuthLoading>

      <Unauthenticated>
        <SignInButton mode="modal">
          <button className="rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-900 transition hover:border-zinc-900">
            Sign in
          </button>
        </SignInButton>
        <SignUpButton mode="modal">
          <button className="rounded-full bg-zinc-950 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-800">
            Sign up
          </button>
        </SignUpButton>
      </Unauthenticated>

      <Authenticated>
        <UserButton />
      </Authenticated>
    </header>
  )
}
