export async function normalizeLaughRegionsAfterLines(args: {
  linesReady: Promise<void>;
  normalizeLaughRegions: () => Promise<void>;
}) {
  await args.linesReady;
  await args.normalizeLaughRegions();
}
