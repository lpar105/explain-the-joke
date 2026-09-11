import { currentUser } from "@clerk/nextjs/server";
import { notFound } from "next/navigation";

import PipelineDashboardClient from "../../components/pipeline-dashboard-client";
import { isAllowedDevEmail } from "../../lib/dev-access";

function getPrimaryEmailAddress(
  user: Awaited<ReturnType<typeof currentUser>>,
) {
  return (
    user?.primaryEmailAddress?.emailAddress ??
    user?.emailAddresses[0]?.emailAddress ??
    null
  );
}

export default async function PipelinePage() {
  const user = await currentUser();
  const emailAddress = getPrimaryEmailAddress(user);

  if (!isAllowedDevEmail(emailAddress)) {
    notFound();
  }

  return <PipelineDashboardClient />;
}
