import SetPageClient from "../../../components/set-page-client";
import { SetReviewLayoutPrototype } from "../../../components/set-review-layout-prototype";

export default async function SetPage({ params, searchParams }: {
  params: Promise<{ setId: string }>;
  searchParams: Promise<{ variant?: string | string[] }>;
}) {
  const { setId } = await params;
  if (process.env.NODE_ENV === "development" && setId === "layout-prototype") {
    const { variant } = await searchParams;
    return <SetReviewLayoutPrototype variant={variant === "a" || variant === "b" ? variant : "c"} />;
  }

  return <SetPageClient key={setId} setId={setId} />;
}
