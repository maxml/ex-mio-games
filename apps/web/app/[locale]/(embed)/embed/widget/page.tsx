import { EmbeddedPlayerWidget } from '@/layers/views/player-widget';

// Embeddable route: `/<locale>/embed/widget?theme=<tenant theme id>`. The casino site puts it in an
// iframe; the theme id comes from the operator's settings (the embed script passes it through).
// The response sets no frame-blocking header; the allowed-origins policy is decided in MIO-135.
export default function EmbedWidgetPage({ searchParams }: { searchParams: { theme?: string } }) {
  return (
    <EmbeddedPlayerWidget
      themeId={typeof searchParams.theme === 'string' ? searchParams.theme : undefined}
    />
  );
}
