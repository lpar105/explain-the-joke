import { fetchQuery } from "convex/nextjs";
import { notFound } from "next/navigation";

import SetPageClient from "../../../../components/set-page-client";
import { api } from "../../../../convex/_generated/api";
import { getSetDevAccess } from "./access";

export default async function SetDevPage({ params }: { params: Promise<{ setId: string }> }) {
  const access = await getSetDevAccess();
  if (!access) notFound();

  if (!access.token) {
    return (
      <main className="mx-auto my-6 max-w-3xl border-tf bg-white p-6 text-center shadow-tf-card">
        <h1 className="text-2xl font-black uppercase">DEV access isn’t configured</h1>
        <p className="my-4 text-sm">Clerk needs to supply the verified email for DEV artifact requests.</p>
      </main>
    );
  }

  const { setId } = await params;
  const artifacts = await fetchQuery(api.sets.listDevArtifacts, { setId }, { token: access.token });
  if (!artifacts) notFound();

  return <SetPageClient key={setId} setId={setId} devArtifacts={artifacts} />;
}
