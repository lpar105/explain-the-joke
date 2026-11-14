import { auth, currentUser } from "@clerk/nextjs/server";

import { isAllowedSetDevEmail } from "../../../../lib/dev-access";

export async function getSetDevAccess() {
  const session = await auth();
  if (!session.userId) return null;

  const email = (await currentUser())?.primaryEmailAddress;
  if (!isAllowedSetDevEmail(email?.emailAddress, email?.verification?.status === "verified")) return null;

  const claims = session.sessionClaims;
  if (claims?.aud === "convex" && typeof claims.email === "string" &&
    isAllowedSetDevEmail(claims.email, claims.email_verified === true)) {
    return { token: await session.getToken() };
  }

  // Request the email claims only for this DEV feature on instances whose session token omits them.
  try {
    return { token: await session.getToken({ template: "set-dev" }) };
  } catch (error) {
    if (typeof error === "object" && error !== null && "status" in error && error.status === 404) {
      return { token: null };
    }
    throw error;
  }
}
