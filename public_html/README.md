# Afterglow — landing page (public_html)

A static landing page for Afterglow, in the spirit of the Alto's Adventure site:
one quiet vertical scroll, big artwork, minimal chrome, no libraries.

## Upload to Hostinger

Upload **the contents of this folder** — not the folder itself — into `public_html`.

```
public_html/
├── index.html          the landing page (all CSS inlined, no external requests)
├── .htaccess           compression, caching, security headers
├── assets/
│   ├── hero.jpg        hero artwork, generated from assets/icon.png
│   ├── icon-192.png    favicon / home-screen icon
│   ├── icon-512.png
│   ├── apple-touch-icon.png
│   ├── og.jpg          social preview card
│   └── screens/        ← add gameplay captures here (see below)
└── play/
    └── index.html      the full game (self-contained, ~524 KB)
```

Two ways to get it up:

- **hPanel → Files → File Manager** — open `public_html`, delete the default
  placeholder, upload a zip of these contents, then extract.
- **FTP/SFTP** — any client, drag the contents into `public_html`.

No Node, no PHP, no database, no build step. It is plain static files.

> **Note before you delete anything:** if this domain already serves something
> from `public_html`, back it up first.

## Adding gameplay screenshots

The gallery has four frames. Each one looks deliberate while empty, and any real
image you drop in simply covers the frame — no code edit needed:

| File | Suggested shot |
| --- | --- |
| `assets/screens/01.jpg` | A crest launch, rider airborne above the ridgeline |
| `assets/screens/02.jpg` | A deep descent opening into the valley floor |
| `assets/screens/03.jpg` | The moonlit forest, preferably mid-combo |
| `assets/screens/04.jpg` | Glowstones chained across the jungle canopy |

Use **16:10 JPEGs, roughly 1600×1000, under 250 KB each**. Any missing file is
simply ignored — the placeholder shows instead, so you can add them one at a time.

To capture: open the game on a desktop browser, press the key that reaches the
level you want, ride until the moment looks right, then take a screenshot with
the browser at roughly 1600×1000. Hiding the HUD is not necessary — the in-game
HUD is part of the look.

## Two things to fill in before launch

Both are single edits in `index.html`:

1. **Contact address** — search for `hello@example.com` and replace it (appears once,
   in the footer near the bottom).
2. **Store links** — the Google Play and App Store entries are currently
   non-clickable "Coming soon" chips. When a listing goes live, change the
   relevant `<span class="chip">` into an `<a class="chip" href="YOUR_URL">`
   and remove its `<span class="chip__soon">Coming soon</span>`.

## Updating the playable game

`play/index.html` is a copy of the game's production build. After a game change:

```bash
npm run build
cp dist/index.html public_html/play/index.html
```

Then re-upload that one file. Nothing else changes.

## Colours

Taken from the game's own artwork so the page and the game read as one thing:

| Token | Value | Use |
| --- | --- | --- |
| `--night` | `#102032` | page background |
| `--cream` | `#fff4dc` | text on dark, light section background |
| `--peach` | `#ffcf96` | primary accent |
| `--peach-hot` | `#ff9e4f` | active dot, warm highlight |
| `--gold` | `#c28b50` | kickers, small rules |
| `--violet` | `#6f5aa8` | dusk gradient |

## Accessibility & performance notes

- Semantic landmarks, one `h1`, logical heading order.
- All controls are real links or buttons and show a visible focus ring.
- `prefers-reduced-motion` disables every transition and smooth-scroll.
- System font stack — no webfont request, no layout shift, no third-party calls.
- No analytics, no trackers, no cookies: the page makes exactly two kinds of
  request, its own images and (if you press Play) the game file.
