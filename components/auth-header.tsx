'use client'

import Link from 'next/link'
import { SignInButton, SignUpButton, UserButton } from '@clerk/nextjs'
import { Authenticated, AuthLoading, Unauthenticated } from 'convex/react'

export default function AuthHeader() {
  return (
    <header className="bg-tf-paper border-b-2 border-black px-4 py-3">
      <div className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <Link href="/library" className="text-lg font-black uppercase tracking-tf-tight text-tf-ink">
            Tight <span className="text-tf-red">Five</span>
          </Link>
          <nav className="flex items-center gap-2">
            <Link
              href="/library"
              className="border-tf-subtle bg-white px-3 py-2 text-[10px] font-black uppercase tracking-tf-ui text-tf-ink hover:bg-tf-paper-alt"
            >
              Library
            </Link>
          </nav>
        </div>

        <div className="flex items-center gap-3">
          <AuthLoading>
            <p className="text-[10px] font-mono uppercase text-tf-ink-muted">Connecting auth...</p>
          </AuthLoading>

          <Unauthenticated>
            <SignInButton mode="modal">
              <button className="border-tf bg-white px-4 py-2 text-[10px] font-black uppercase tracking-tf-ui text-tf-ink hover:bg-tf-paper-alt hover:shadow-tf-card">
                Sign in
              </button>
            </SignInButton>
            <SignUpButton mode="modal">
              <button className="border-tf bg-tf-blue px-4 py-2 text-[10px] font-black uppercase tracking-tf-ui text-tf-paper hover:bg-tf-blue-hover hover:shadow-tf-card">
                Sign up
              </button>
            </SignUpButton>
          </Unauthenticated>

          <Authenticated>
            <UserButton />
          </Authenticated>
        </div>
      </div>
    </header>
  )
}
