import { SetupPage } from '@/layers/views/operator-console';

export default function Page({
  searchParams,
}: {
  searchParams: { step?: string; denied?: string };
}) {
  return <SetupPage step={searchParams.step} denied={searchParams.denied} />;
}
