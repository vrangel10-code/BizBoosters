# Static assets

## `logo.png` — the app logo

Save the BizBoosters logo here as **`logo.png`** and it appears on the sign-in
page and at the top of both main menus. Nothing else needs changing.

- Square, ideally 512×512 or larger. It is displayed at 96px and 56px.
- PNG with a transparent background — the app is dark, so a white rectangle
  will show as a white rectangle.

Until the file exists, `src/components/brand.tsx` falls back to a plain chest
drawn in code, so no page shows a broken image. The fallback is a placeholder,
not the brand.

Also worth adding while you are here: **`favicon.ico`** (the browser-tab icon),
generated from the same artwork.
