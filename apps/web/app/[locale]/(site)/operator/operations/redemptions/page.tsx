import { RedemptionsPage } from '@/layers/views/operator-console';

export default function Page({ searchParams }: { searchParams: { denied?: string } }) {
  return <RedemptionsPage denied={searchParams.denied} />;
}
