import { AuthConfig } from 'convex/server'

if (!process.env.CLERK_FRONTEND_API_URL) {
  throw new Error(
    'Missing CLERK_FRONTEND_API_URL. Add it to your local env and Convex deployment env vars.',
  )
}

export default {
  providers: [
    {
      domain: process.env.CLERK_FRONTEND_API_URL,
      applicationID: 'convex',
    },
  ],
} satisfies AuthConfig
