import SetPageClient from "../../../components/set-page-client";

export default async function SetPage({ params }: { params: Promise<{ setId: string }> }) {
  const { setId } = await params;

  return <SetPageClient key={setId} setId={setId} />;
}
