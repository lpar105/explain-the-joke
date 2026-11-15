export function formatDuration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);

  return `${minutes}:${remainder.toString().padStart(2, "0")}`;
}

export function formatTimestamp(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  const remainder = Math.floor(seconds % 60);

  return `${minutes.toString().padStart(2, "0")}:${remainder
    .toString()
    .padStart(2, "0")}`;
}

export function formatSetDate(performanceDate: string | null, creationTime: number) {
  return new Intl.DateTimeFormat("en-NZ", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: performanceDate === null ? undefined : "UTC",
  }).format(performanceDate === null ? creationTime : Date.parse(performanceDate));
}

export function getSetDateInputValue(performanceDate: string | null, creationTime: number) {
  if (performanceDate !== null) {
    return performanceDate;
  }

  const date = new Date(creationTime);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
