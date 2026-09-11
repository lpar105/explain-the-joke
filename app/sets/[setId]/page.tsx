import SetPageClient from "../../../components/set-page-client";

export default async function SetPage(props: {
  params: Promise<{ setId: string }>;
}) {
  const { setId } = await props.params;

  return <SetPageClient setId={setId} />;
}
