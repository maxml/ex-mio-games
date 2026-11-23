import type { ReactNode } from 'react';
import { ConsoleBaseProvider } from '@/layers/views/operator-console';

// The operator console's pages are one route each (IA spec section 2). This layout only tells the nav
// which locale prefix its links need.
export default function OperatorLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: { locale: string };
}) {
  return <ConsoleBaseProvider base={`/${params.locale}`}>{children}</ConsoleBaseProvider>;
}
