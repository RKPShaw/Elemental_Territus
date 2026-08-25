import { TheaterSnapshot } from "./TheaterSnapshot";

interface TheaterSnapshotPageProps {
  searchParams: Promise<{ tick?: string | string[] }>;
}

export default async function TheaterSnapshotPage({ searchParams }: TheaterSnapshotPageProps) {
  const query = await searchParams;
  const rawTick = Array.isArray(query.tick) ? query.tick[0] : query.tick;
  const parsed = Number(rawTick ?? 0);
  const tick = Number.isFinite(parsed) ? Math.max(0, Math.min(300, Math.floor(parsed))) : 0;
  return <TheaterSnapshot tick={tick} />;
}
