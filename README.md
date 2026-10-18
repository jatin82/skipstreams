# Prime Video (Ad Skip) for Samsung Tizen TVs

A [TizenBrew](https://github.com/reisxd/TizenBrew) site-modification module that opens
`https://www.primevideo.com/` on a Samsung Tizen TV (tested target: Tizen 9) and injects
[userScript.js](./userScript.js), which:

- **Skips ads**: clicks visible "Skip Ad" controls, and plays unskippable ads muted at up
  to 16× (falls back to 8×/4×/2× if the TV decoder refuses), then restores speed/volume.
  Logic is ported from the `primeAdsSkip.js` Tampermonkey script.
- **Remote cursor**: the desktop site isn't remote-friendly, so a pointer is added.
- **TV-friendly page**: all CSS/Web animations are disabled and trailers (hero banners,
  hover previews, detail pages) never autoplay; only the real player video plays.

| Remote key | Action |
|---|---|
| Arrows | Move cursor (hold to accelerate; pushing against an edge scrolls) |
| OK / Enter | Click under cursor (focuses text fields to open the TV keyboard) |
| Back | Close the on-screen keyboard if typing, otherwise go back to the movie list (PC companion app) |
| Play/Pause, Play, Pause, Stop | Control the video |
| Left / Right (while watching, cursor hidden) | Tap: seek −10 s / +10 s. Hold: jump −5 / +5 min, repeating while held (disabled during ads) |
| OK (while watching, cursor hidden) | Play / pause |
| Up / Down (while watching) | Bring back the cursor |
| FF / Rewind | Seek ±10 s (disabled while an ad is playing) |
| Red (A) | Toggle the cursor on/off |

The cursor hides after 4 s of inactivity. The first arrow press after that only brings it back without moving it.
Hover effects are only triggered once the cursor stops (Prime's hover handlers are slow on TV hardware).

With the PC companion app (see [tv-app/README.md](./tv-app/README.md#movie-list)), the TV starts with a
**Which movie?** list loaded from a JSON file; the chosen title opens directly and starts playing.

## Why TizenBrew?

A normal Tizen `.wgt` app can't inject scripts into a third-party website. When the app goes to an
external URL, the app's own JavaScript stops running, and Prime Video can't be read across origins
from an iframe. TizenBrew opens the site in debug mode and injects the module's script through the
DevTools protocol, the same way TizenTube works for YouTube.

## Install

There are two ways to install it:

- **Option A: Samsung app (`.wgt`) + PC companion**. See [tv-app/README.md](./tv-app/README.md).
  It installs as its own "Prime Video AdSkip" app, and Developer Mode keeps your real PC IP as Host PC IP.
  Ad skipping needs `npm run watch` running on the PC.
- **Option B: TizenBrew module (no PC needed)**. Follow the steps below.

### TizenBrew module (no PC needed)

This repo contains two TizenBrew modules, served from GitHub through jsDelivr:

| Module | Add in TizenBrew as | Opens |
|---|---|---|
| Prime Video (Ad Skip) | `jatin82/skipstreams@v1.2.0` | primevideo.com |
| JioHotstar | `jatin82/skipstreams@v1.2.0/hotstar` | hotstar.com/in (opens the login page if you aren't logged in, picks the Jatin profile, skips ads, Full HD, no images) |

1. **Install TizenBrew on the TV** following the
   [TizenBrew guide](https://github.com/reisxd/TizenBrew/blob/main/docs/README.md). With a Samsung
   certificate that's already set up, re-sign and install the `.wgt` directly:
   `tizen package -t wgt -s <profile> -o .\resigned -- TizenBrewStandalone.wgt`, then
   `tizen install -n TizenBrewStandalone.wgt -s <TV-IP>:26101 -- .\resigned`.
2. On the TV, open **Apps**, enter `12345` and set **Host PC IP** to `127.0.0.1`, then restart the TV.
   TizenBrew needs this to inject scripts by itself. To install apps from the PC again, switch it back
   to the PC's IP.
3. Open **TizenBrew → Module Manager → Add GitHub module** and add each module from the table.
4. If Prime Video shows an "unsupported browser" page, set a desktop Chrome user agent in TizenBrew's
   **User-Agent settings**.

When a module starts, it shows the same **Which movie?** list as the TV apps, loaded from the online
JSON file. The site's home page stops loading. Pick a movie with Up/Down/OK, and Back while watching
brings the list back. **Exit app** (or Back on the list) closes the app.

Use the version-tag names (`@v1.2.0`). A tag never changes, so jsDelivr can't serve a stale copy. To
update, remove the module and add it again with the new tag. `@main` works too, but jsDelivr can keep
an old copy for up to 12 hours, and purges are rate-limited. The plain `jatin82/skipstreams` address
can stay stuck on an old version for a long time.

`hotstar/userScript.js` is a copy of `userScript.js`. Copy it again before every push. jsDelivr caches
GitHub files for up to 12 hours; to refresh sooner, open
`https://purge.jsdelivr.net/gh/jatin82/skipstreams@main/<file>` for `package.json`, `userScript.js`,
`hotstar/package.json` and `hotstar/userScript.js`.

## Development

- `npm run check` checks the script syntax.
- Debug on the TV by connecting Chrome DevTools to TizenBrew's debug port and filtering the
  console by `[PrimeTizen]`.
- To test in a desktop browser, paste `userScript.js` into the DevTools console on primevideo.com.
  The arrow keys and Enter will then control the cursor.

## Known limitations

- Prime Video may show "unsupported browser" or reject DRM on some TV models/firmware. That depends
  on the TV's web engine and isn't something this script can change.
- Ad detection relies on Prime's current web player DOM (`#dv-web-player`, `aria-label="Ad playing."`,
  `.atvwebplayersdk-ad-timer-remaining-time`). If Amazon changes it, update the selectors at the top
  of `AdSkipper` in `userScript.js`.
