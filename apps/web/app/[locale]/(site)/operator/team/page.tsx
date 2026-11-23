import { TeamPage } from '@/layers/views/operator-console';

export default function Page({ searchParams }: { searchParams: { denied?: string } }) {
  return <TeamPage denied={searchParams.denied} />;
}
