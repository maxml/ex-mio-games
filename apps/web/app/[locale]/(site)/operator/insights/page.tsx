import { InsightsPage } from '@/layers/views/operator-console';

export default function Page({ searchParams }: { searchParams: { denied?: string } }) {
  return <InsightsPage denied={searchParams.denied} />;
}
