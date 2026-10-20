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
| Prime Video (Ad Skip) | `jatin82/skipstreams@01` | primevideo.com |
| JioHotstar | `jatin82/skipstreams@01/hotstar` | hotstar.com/in (opens the login page if you aren't logged in, picks the Jatin profile, skips ads, Full HD, no images) |

1. **Install TizenBrew on the TV** following the
   [TizenBrew guide](https://github.com/reisxd/TizenBrew/blob/main/docs/README.md). With a Samsung
   certificate that's already set up, re-sign and install the `.wgt` directly:
   `tizen package -t wgt -s <profile> -o .\resigned -- TizenBrewStandalone.wgt`, then
   `tizen install -n TizenBrewStandalone.wgt -s <TV-IP>:26101 -- .\resigned`.
2. On the TV, open **Apps**, enter `12345` and set **Host PC IP** to `127.0.0.1`, then restart the TV.
   TizenBrew needs this to inject scripts by itself. To install apps from the PC again, switch it back
   to the PC's IP.
3. Open **TizenBrew → Module Manager → Add GitHub module** and add each module from the table.
   The custom widget prefills `jatin82/skipstreams@`, with the cursor at the end. Enter only the
   remaining part, such as `01` or `01/hotstar`. The field is editable if you want another
   repository; replace the whole value when pasting a full address. The prefix alone cannot be
   submitted, and **Add NPM Module** still starts with an empty field.
4. If Prime Video shows an "unsupported browser" page, set a desktop Chrome user agent in TizenBrew's
   **User-Agent settings**.

When a module starts, it shows the same **Which movie?** list as the TV apps, loaded from the online
JSON file. The modules start on the site's tiny `robots.txt` page, so no home page, images or scripts load
before you pick; only the chosen movie's page opens. Pick a movie with Up/Down/OK, and Back while watching
brings the list back. Both modules in release `01` make **Exit app** (or Back
on the list) return to TizenBrew's module screen through the updated custom service bridge,
rather than closing TizenBrew to the Samsung launcher. Both require the updated custom
TizenBrew widget's return bridge. A missing/disconnected return
bridge shows an error on the list instead of
falling back to the TV launcher.

Prime autoplay uses the stable playback test/automation IDs for both **Watch now** and
**Resume Episode** links. It ignores hidden/disabled controls and preserves the link's
existing `autoplay`, resume-time (`t`), and tracking parameters. Artwork suppression leaves
video/audio `<source>` elements intact. Required player JavaScript, styles, manifests and DRM
requests are not blanket-blocked: removing those would prevent real playback. DOM image
suppression is not a guarantee that every image request is prevented before it starts.

Release tags use two digits without a prefix or dots, starting at `01`. Both modules retain
semantic package versions internally (`1.5.0` for release `01`) for compatibility.
Use the release-tag names (`@01` for Prime, `@01/hotstar` for JioHotstar). A tag never changes, so jsDelivr can't serve a stale copy. To
update, remove the module and add it again with the new tag. `@main` works too, but jsDelivr can keep
an old copy for up to 12 hours, and purges are rate-limited. The plain `jatin82/skipstreams` address
can stay stuck on an old version for a long time.

`hotstar/userScript.js` is a copy of `userScript.js`. Copy it again before every push. jsDelivr caches
GitHub files for up to 12 hours; to refresh sooner, open
`https://purge.jsdelivr.net/gh/jatin82/skipstreams@main/<file>` for `package.json`, `userScript.js`,
`hotstar/package.json` and `hotstar/userScript.js`.

## Development

### Local TizenBrew preview with real websites

Requirements: Node.js 18+ and an installed desktop Chrome or Edge. The preview uses the
generated TizenBrew UI in `tv-app/dist/tizenbrew/debug-logs/ui/dist`; if it is missing, build
the custom widget first with `python tv-app\build-debug-tizenbrew.py`.

From the repository root:

```powershell
npm install
npm run local:live
```

This opens the actual TizenBrew web UI in a new, isolated desktop-browser context. The terminal
prints its loopback URL. The window opens maximized and follows its actual size rather than
emulating a fixed TV viewport, so the top navigation and bottom controls remain reachable.
Click **Restart service** in that local UI to enable the **local adapter**,
then choose Prime, JioHotstar or Google. These modules load **real websites** and inject the
matching **working-tree script**, not the version downloaded from a release tag. The local
module names are labelled `[local source]`; arbitrary third-party/native module services are
not executed. No TV, SDB connection, or real Tizen service is contacted or started.

- Enter credentials yourself on the real site's sign-in page if needed. The runner does not
  collect credentials, record browsing traces, or persist your account profile.
- Arrows/Enter work normally; **Esc is mapped to TV Back**. First Back during playback opens
  the movie list; Back on the list or Exit app returns to the local TizenBrew UI.
- The preview supplies device/service APIs only to the local UI. It does **not** mock video,
  XHR, or fetch on the real Prime/Hotstar pages.
- The browser is real, but the Tizen APIs are an adapter, not a Tizen emulator. Account,
  regional restrictions, DRM, codecs and actual Samsung-TV behavior still need verification.
- Close the browser or press Ctrl+C to stop. Restart the preview after editing scripts.
  Its local service state and catalog are reset each run.
- Chrome is preferred when installed; to use Edge:

  ```powershell
  $env:LOCAL_BREW_BROWSER = 'msedge'
  npm run local:live
  ```

The implementation is in `local-tizenbrew.js`. It serves only the built UI over a loopback
HTTP listener and substitutes a dummy token in served UI assets. Do not publish the generated
UI/widget on disk: that original build still contains the private diagnostic token.

### Repeatable local regression tests

```powershell
npm test
npm run test:local
npm run test:local:headed
```

`npm test` runs fast unit tests. The Playwright suite uses the complete userscripts against
**offline fixtures**, separately from the real-site preview above. Every application request
is intercepted; no real account, stream, or TV service is used. It covers the supplied Watch/Resume
markup, disabled/hidden controls, resume-time preservation, artwork/media-source handling,
movie selection, first-Back behavior, Exit-to-TizenBrew, and missing-bridge errors.
The desktop-bar layout check also exercises small windows; it is skipped with an explicit
message if the generated TizenBrew UI has not been built.
The fixtures and browser configuration are in `tests/local` and `playwright.config.js`.
Failure screenshots/traces go to `test-results/local`; the HTML report is in `playwright-report`.
These generated directories are ignored by Git.

### Google injection smoke test

The independent `google-test` TizenBrew module opens `https://www.google.com/`.
Its script logs the exact message **`i am injected`**, followed by
`[GoogleInjectionTest] https://www.google.com/` (or Google's redirected URL).
It does not load the Prime/Hotstar script or change their module settings.

Add `jatin82/skipstreams@v1.4.1/google-test` in TizenBrew's GitHub module manager.
Use the immutable version tag to avoid a stale CDN copy. With Host PC IP still `127.0.0.1`,
launch **Google Injection Test**, then look for `i am injected` in the Windows dashboard.
The patched on-TV service must be installed, logging enabled as described below, and the Windows receiver running.
Absence of the marker is a failed/unverified injection test, even if TizenBrew startup logs arrive.
Run `node --test google-test/userScript.test.js` locally to check the module's entry point and marker.

### Live debug logs on Windows

On the Windows PC at `192.168.29.126`, run (Node.js 18+ required):

```powershell
cd tv-app
npm run debug-logs
```

Open `http://192.168.29.126:8087` on your laptop. Allow Node.js inbound TCP **8087** on
Windows Firewall's **Private** network profile if prompted. The PC, TV and laptop must be on
the same trusted LAN. Do not expose this port to the Internet: all page console output is
visible to anyone who can access this address and may contain personal information.

The patched TizenBrew **on-TV service** collects console events from its existing loopback debugger
and POSTs batches to `http://192.168.29.126:8087/ingest`. The Windows server does **not** connect
through SDB. Keep Developer Mode Host PC IP at **`127.0.0.1`** during normal use.
All page console levels (Prime/Hotstar userscripts and site code) and uncaught JavaScript errors are
captured after TizenBrew attaches its debugger. Isolated workers and other apps are not captured.
Uploads originate in the Node service, so page CSP/HTTPS restrictions do not apply.
No userscript changes, module update, or CDN purge are needed, but the patched TizenBrew widget
must be installed once. Keep the Windows server running while testing.
The dashboard supports filtering, pausing display and downloading JSON. It retains the last 1,000
events in memory (8,000 characters per message); stopping the server discards them. Clear display only
clears that browser's current view, not the server's history. Logs emitted before attaching may not be available.

Build from the existing signed custom module-button widget (preserves its UI and module behavior):

```powershell
python tv-app\build-debug-tizenbrew.py
$debugDir = Join-Path (Get-Location) 'tv-app\dist\tizenbrew\debug-logs'
tizen package -t wgt -s Monitor32 -o "$debugDir\signed" -- "$debugDir\TizenBrew-DebugLogs.wgt"
```

The build regenerates the packaged Preact UI using its existing lockfile. On the first build,
if Vite is missing, restore that generated workspace's dependencies and rerun:

```powershell
npm --prefix tv-app\dist\tizenbrew\debug-logs\ui ci --legacy-peer-deps --no-audit --no-fund
python tv-app\build-debug-tizenbrew.py
```

`--legacy-peer-deps` is needed for the package's existing React-to-Preact compatibility aliases;
it does not change the dependency versions in the lockfile.

Run these build commands from the repository root; the signing CLI requires absolute paths.
The build creates a random upload token in
`tv-app/dist/tizenbrew/debug-logs/receiver.json` and embeds it in the patched service. The server
reads the same file. Keep it private and do not commit it or the signed package. The token authenticates
uploads; the dashboard itself is LAN-only and has no login. HTTP is not encrypted.
**Logging defaults to disabled.** The same configuration file contains `"loggingEnabled": false`;
older files without that field are updated with the false default. To enable diagnostics, change
it to the boolean `true`, rebuild, sign and reinstall. A string such as `"true"` is rejected.
This single build-time flag controls the bottom log view, UI console/error capture, TV-local
diagnostic recording and Windows log uploads. With it false, no log uploader or heartbeat
recorder is started, and existing saved logs are not deleted. Check/Restart controls, debugger
recovery and Google Back remain functional. The Windows receiver is not needed in this mode.
The logging behavior described below applies when the flag is enabled.
To change the Windows IP/port, edit that generated config, rebuild and reinstall the widget; use
`npm run debug-logs -- --port <port>` to change the receiver's listening port.

**One-time installation:** temporarily change TV Developer Mode Host PC IP to `192.168.29.126`
and restart the TV, then connect with SDB and install the newly signed widget using the same
author certificate as the installed app. Do not uninstall TizenBrew (to preserve module settings).
After installation, restore Host PC IP to `127.0.0.1`, restart the TV, and open TizenBrew normally.
An official TizenBrew update will overwrite the forwarding patch.
The build also corrects the custom UI's modern-browser detection on `file:` URLs. It keeps
Vite's capability probes and legacy fallback, but prevents a capable TV from running both
UI bundles at once. Duplicate UI startup can leave the displayed module manager without
the service client initialized by the other bundle.

The service batches up to 20 entries once per second and keeps at most 200 pending events.
Failed uploads retry on subsequent ticks; queue overflow and upload failures are reported in the
on-TV service console. On debugger disconnect the forwarder drains pending logs for up to ten seconds.
Diagnostic events report execution contexts, selected modules, page navigation, script evaluation
requests/results and debugger disconnects without uploading script contents. The Windows dashboard
history is in memory; the TV-local diagnostic log persists across service restarts.
A startup log confirms forwarding is active in the dashboard.
Injection steps additionally report debugger-domain enabling, skipped injection without a selected
module, script cache hits/misses/writes, download URL and HTTP status, response-body read/length,
context destruction and target crashes. These diagnostics observe the existing injection behavior;
an HTTP failure is reported without silently substituting a successful result.
Injection diagnostics preserve and report synchronous debugger-call throws, rejected debugger
promises (including non-Error values), evaluation exception details, and uncaught page exceptions.
Errors caught internally by site code are not visible unless logged. A terminated service,
lost debugger connection, or unavailable network can prevent delivery; this is not a guarantee
that every possible failure reaches the dashboard.
The dashboard's status shows the last received batch; inspect service heartbeat entries for liveness.
The patched service now also has a separate uploader that starts before its normal startup code
and does not require a page-debugger connection. It forwards service console log/info/debug/warn/error,
reports loopback SDB requests, debugger attempts/connections/failures and module launches, and sends
a heartbeat every ten seconds with PID/session, uptime, selected module, debugger flags and UI socket
state. These entries use `service://TizenBrew`. If page events stop but service heartbeats continue,
the service is still running; if both stop, the service, network or receiver needs investigation.
Transport errors are excluded from console forwarding to avoid recursive upload failures.
Uncaught exceptions are observed using `uncaughtExceptionMonitor` where supported without suppressing
Node's default termination. These records do not by themselves prove process exit: the TV's runtime
may have its own exception handler. Older TV Node runtimes may not emit that event, and a process crash can
prevent a final upload. Normal service-console logs and heartbeats still work on those runtimes.
The device-information check at `http://127.0.0.1:8001/api/v2/` now shares in-flight requests
between startup and UI eligibility queries. UI replies wait for the current result instead of sending
a stale `null`. Failed connections, HTTP errors, invalid JSON and missing developer-mode fields
are logged and retried up to three times, one second apart, using the bundled fetch client's
three-second request/body timeouts and a 64 KiB response limit. Exhausted retries produce an
explicit UI error rather than an unhandled rejection or a false claim that Developer Mode is off.
Later requests can retry; successful checks retain the existing `127.0.0.1`/`1.0.0.127` host rules.
Heartbeat state includes the device API's pending/result/error status.
The service also synchronously appends diagnostic records to
`/home/owner/share/tizenbrew-diagnostics.jsonl` on the TV, rotating the previous generation to
`tizenbrew-diagnostics.jsonl.1`. Each file is capped at 256 KiB (512 KiB total); the oldest generation
is overwritten on rotation. Records include TV timestamps, PID/session and process uptime. They
cover page/debugger events, service console and socket lifecycle, heartbeat timing gaps, upload
start/TCP connection/completion/error, and process exit/fatal exceptions where supported.
Upload progress is written only locally to avoid feedback loops. Tokens are redacted from local
records; logs may still contain sensitive site data. Local write failures appear in the service
console and heartbeat state rather than silently pretending persistence succeeded.
Synchronous appends survive normal process restarts, but cannot guarantee the final record after
power loss, a forced kill or a blocked process. Missing exit records alone do not prove a crash.

#### Retrieving TV-local diagnostics

Install the newest diagnostic widget before reproducing the failure. Keep Host PC IP at
`127.0.0.1` for the Home-screen-only test and wait at least 30 seconds after debugger attachment.
Then temporarily change Host PC IP to the Windows PC IP and restart to permit PC SDB access.
Open TizenBrew to start its service, but do not launch a module. The previous log generation
is retained across this restart; retrieve it promptly before continued logging rotates it out.
Do not uninstall the app or clear its data.

From the repository root:

```powershell
sdb connect 192.168.29.51:26101
sdb -s 192.168.29.51:26101 forward tcp:18081 tcp:8081
npm --prefix tv-app run read-tv-diagnostics
sdb -s 192.168.29.51:26101 forward --remove tcp:18081
```

The reader uses the existing private receiver token and saves a timestamped `.jsonl` file in the
ignored `tv-app/dist/tizenbrew/debug-logs` directory without overwriting an existing file.
Optional arguments are `--port <forwarded-port>`, `--config <receiver.json>` and `--output <file>`.
It uses the service's existing loopback-only HTTP listener, not the UI WebSocket, and does not
change module configuration or the UI's active connection. Retrieval requires a responsive
service; if it is suspended or stalled, reopen/restart it before retrying. Old builds, authorization
failures, unavailable files and timeouts produce an explicit error rather than an empty download.
The HTTP route `/__tv_debug/logs` requires the bearer token and does not allow writes.
If local heartbeats continue with upload errors, investigate transport; a long heartbeat timing
gap suggests delayed execution. An exit record confirms exit handling ran; an exception record
alone does not prove termination. A log that simply ends still cannot distinguish every cause.

#### On-TV controls and live logs

By default, TizenBrew reserves a compact 100-pixel bottom bar for **Check service**,
**Restart service**, and status. The log view is hidden. When `loggingEnabled` is true, the bar
expands to 27% for service diagnostics. The existing
remote arrow/Enter navigation reaches **Check service**, **Restart service**, and the log history.
When the log history is focused, Up/Down scroll by most of a page; Up at the top returns to the
buttons. Otherwise, the log view follows new entries. The panel loads both retained TV-local log
files, including earlier service sessions, then merges live records without the old 100-entry
limit. It shows SERVICE, TRANSPORT, PAGE and UI source labels and UTC timestamps. The rolling
display is limited to 2 MiB to protect TV memory, independently of the 512 KiB saved TV log.
Records already displayed remain visible when the connection fails.

**Check service** requires a fresh, authenticated response within three seconds and shows the
PID and uptime. A timeout/disconnection is not presented as proof that the process has stopped.
After a successful manual check, the panel also repairs a closed app WebSocket, reloads the
installed-module catalog, and verifies debugger readiness. A service HTTP reply alone does not
clear the app's connection error.
Live records are polled every two seconds through `/__tv_debug/live`; the service keeps a bounded
200-record live buffer and sends up to 40 incremental records per response, bounded to roughly
240 KiB. Live messages retain the full logged text (up to 8,000 characters), rather than a separate
2,000-character preview. Saved and live records share IDs for deduplication. Live gaps trigger a
saved-history reload; **Check service** also refreshes history manually. Unreadable saved lines and
history-download errors are reported without hiding the remaining valid records.
The full bounded TV-local log remains available through the existing download command.

An independent UI capture starts before the app renders. It records UI console messages, failed
assertions, uncaught errors, resource-load failures and unhandled rejections even when the service
or its page debugger is unavailable. Its own buffer is capped at 128 KiB and lasts for the current
UI page; it is not a substitute for the persistent service log. Service-check and manual-recovery
failures also appear in this local UI stream. These messages need not reach the Windows receiver
to appear on screen. UI console behavior and default exception handling are preserved, and the
private diagnostic token is redacted.
This cannot reconstruct messages that were never captured, native OS logs, or activity while the
corresponding JavaScript runtime is stopped.

**Restart service** sends an authenticated POST to `/__tv_debug/restart`, which requests exit of
the service runtime after acknowledging the request. The UI then uses Tizen's service app-control
operation to launch it and waits up to 30 seconds for a different service session. If the old
service is unreachable, it requests a launch instead and reports "started / reconnected", not an
unverified restart. Launch acceptance alone is never shown as recovery. Authentication and native
launch errors remain visible. Module configuration is not changed.
Some TV runtimes reinitialize the service within the same OS PID, so verification uses the new
diagnostic session rather than assuming the PID or process uptime must change.

**Service startup is manual.** Opening TizenBrew only connects to an already-running service;
it never invokes Tizen's service-launch operation automatically. If no service is available,
press **Restart service** to start it. Check service and background health checks do not start
or restart the service. An explicit Restart also requests initial debugger setup when no existing
endpoint is available; use Host PC IP `127.0.0.1` for that normal self-debug workflow.

After a service restart, the panel reconnects the app WebSocket and reloads Home automatically.
It clears only the matching connection error after a fresh status/catalog handshake; unrelated
errors are retained. While attached to TizenBrew's local page, the debugger publishes its port
into that page's memory. Recovery can reattach to that existing port without exiting/relaunching
the UI again. The service first verifies that the loopback port exposes exactly the TizenBrew UI
target, rather than an unrelated website. This hint does not survive a full page/app restart.
If no valid debugger endpoint remains, Home still gets its module catalog, but the UI reports
the missing debugger and blocks module navigation instead of opening an uninjected website.
Reopen TizenBrew in normal loopback mode in that case. The panel distinguishes service health,
app connectivity and debugger readiness; none alone proves a userscript executed.
It is shown on TizenBrew screens only, not over Google/Prime after navigation.
Service socket errors no longer repeatedly reload the page, so the recovery controls and retained
messages stay visible. Service-protocol errors use the UI's existing error banner.
Translations are initialized synchronously with the browser-language fallback before rendering;
the TV locale is applied afterward. This prevents asynchronous locale discovery from changing
the translation hook path while the diagnostic panel is already mounted.
Control labels use the existing localization system with English fallbacks; diagnostic detail
messages retain the service log's English wording.

The additional HTTP routes use the same private token and TV-loopback listener. Browser access
is limited to the local app's opaque (`null`) origin; normal website origins are rejected. The
token is embedded in the private widget's UI as well as its service, so do not publish this widget.

For the Google injection-test module, the TV Back/Return key (10009) returns to TizenBrew Home.
The on-TV debugger installs the handler, clears Google as the active module and navigates back
to the local UI; the installed module/configuration is not removed. Debugger-driven navigation
avoids an HTTPS page attempting a blocked direct `file:` navigation. A failed navigation is
logged and restores the active-module selection. This requires a functioning debugger and
support for `Runtime.addBinding`; an unsupported binding is reported explicitly. No change or
republish of the existing Google module tag is needed for this handler.

Use `--host <address>`, `--port <port>`, or `--config <receiver.json>` for the Windows receiver.
Stop it with Ctrl+C. Run `npm run test-debug-logs` in `tv-app` for receiver and TV-forwarder tests.

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
