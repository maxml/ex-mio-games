import { EmbeddedPlayerWidget } from '@/layers/views/player-widget';

// Embeddable route: `/<locale>/embed/widget?theme=<tenant theme id>`. The casino site puts it in an
// iframe; the theme id comes from the operator's settings (the embed script passes it through).
// The response sets no frame-blocking header; the allowed-origins policy is decided in MIO-135.
// The theme comes from the query string, so the page is rendered per request, not prerendered.
export const dynamic = 'force-dynamic';

export default function EmbedWidgetPage({
  searchParams,
}: {
  searchParams: { theme?: string; token?: string };
}) {
  return (
    <EmbeddedPlayerWidget
      themeId={typeof searchParams.theme === 'string' ? searchParams.theme : undefined}
      launchToken={typeof searchParams.token === 'string' ? searchParams.token : undefined}
    />
  );
}
