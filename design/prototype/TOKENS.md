# Design tokens

All colours, radii, fonts and shadows are CSS variables defined in `src/theme/tokens.css`. The values are neutral placeholders: no brand material exists yet (backlog MIO-120). Components never contain raw colours; `pnpm check:no-raw-colors` fails the build if one appears outside `src/theme/`: hex, `rgb()` and friends, Tailwind palette classes, and CSS named colours in style props, `.css` declarations and SVG colour attributes.

## Token set

| Group | Tokens | Used for |
|---|---|---|
| Surfaces and text | `bg`, `surface`, `surface-2`, `border`, `input-border`, `fg`, `fg-muted` | Page, cards, inset areas, decorative lines, form-field outlines (3:1), text |
| Actions | `primary`, `primary-fg`, `accent`, `accent-fg`, `ring` | Buttons, selected state, focus outline |
| Status | `success`, `warning`, `danger`, `info` | Status text and borders only, always with an icon or word |
| Gamification | `coin`, `wheel-1` to `wheel-6`, `wheel-fg`, `wheel-rim` | Coin icon, wheel segments (cycled), segment labels, rim |
| Shape and type | `radius-sm`, `radius-md`, `radius-lg`, `font-sans`, `font-display`, `shadow-card` | Corners, typefaces, card elevation |

`src/index.css` maps the semantic tokens to Tailwind utilities (`bg-surface`, `text-fg-muted`, `border-border`, `text-success`, ...) with `@theme inline`, so a utility reads the variable at runtime instead of a build-time copy.

## Tenant override

A tenant theme is a JSON file with a subset of the token names (schema: `src/theme/tenant-theme.schema.json`). Two examples ship: `lucky-star.json` (dark, purple and gold, round) and `northbet.json` (light, green, square).

```json
{ "id": "my-casino", "name": "My Casino", "tokens": { "primary": "#0b7a55", "primary-fg": "#ffffff", "radius-md": "4px" } }
```

At runtime `themeStyle()` / `ThemeProvider` write each entry as an inline CSS variable (`--primary: ...`) on the widget root or `<html>`. Unlisted tokens fall back to `tokens.css`. No rebuild is needed; in production the server can return the same JSON in the widget bootstrap response.

## Rules a tenant theme must meet

- `pnpm check:contrast` first validates each tenant file against `tenant-theme.schema.json` (an unknown token name such as `primry-fg`, or a malformed value, fails), then checks 28 text and UI pairs per theme against WCAG AA (4.5 for text; 3 for focus ring on page, card and inset, form-field border, wheel rim, coin and primary-on-card). It runs inside `pnpm build`, so a failing tenant file fails the build. Check an extra file with `node scripts/check-contrast.mjs path/to/theme.json`.
- Status colours are never the only signal: pills carry an icon and a word.
- Wheel segments cycle through `wheel-1..6`; every segment label uses `wheel-fg`, so all six must contrast with it.
