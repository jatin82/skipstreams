# Prime Video AdSkip: Samsung TV app + PC companion

## Custom TizenBrew module button

[tizenbrew-module-button.patch](tizenbrew-module-button.patch) patches the UI of
[TizenBrew v2.0.5](https://github.com/reisxd/TizenBrew/tree/v2.0.5) to add an explicit **Add module**
button for GitHub and npm modules. Leaving the input no longer saves it. Enter, Down or Tab moves
from the input to the button; OK adds the module, and Up returns to editing.
This adds an exact module address, not a GitHub repository search.

To rebuild, apply the patch at the root of the upstream v2.0.5 checkout, then run
`npm ci --legacy-peer-deps` and `npm run build` in `tizenbrew-app\TizenBrew\tizenbrew-ui`.
Replace only `tizenbrew-ui/dist/` in the official `TizenBrewStandalone-Old.wgt` with that build.
Re-sign the package with a Samsung certificate covering the target TV before installing.
The local signed build is `dist\tizenbrew\module-button\signed\TizenBrew-ModuleButton.wgt`,
signed with `Monitor32` to match the monitor's installed author certificate.
An official TizenBrew update will overwrite this custom UI.

## App launcher

The TV app (`.wgt`) opens `https://www.primevideo.com/`. The PC companion (`companion.js`) injects
[../userScript.js](../userScript.js) into it, which skips ads and adds the remote cursor.

## Why a PC companion?

A Tizen app can't inject scripts into an external website. The only way in is the web debugger, and
the TV opens that only for an app launched in debug mode by `sdbd`. `sdbd` accepts connections only
from the **Host PC IP** set in Developer Mode. You keep your real PC IP there, so the PC has to do
the debug launch:

1. `npm run watch` runs `sdb shell 0 debug PrimeTzn01.PrimeTizen` and gets the debug port.
2. It forwards that port to the PC (`sdb forward`) and attaches through the Chrome DevTools Protocol.
3. It injects `userScript.js` into every top-level Prime/Amazon page the app opens.
4. It tells the launcher page to open Prime Video.

The script is read again on every page load, so edits to `userScript.js` apply on the next launch
without reinstalling the app.

## TV setup (one time)

On the TV, open **Apps**, type `12345` on the remote, turn **Developer mode** on, set **Host PC IP**
to your PC's IP, and reboot.

## Build and install

Requires Node.js 18+, the Tizen CLI (`tizen`, `sdb`) and a Samsung certificate profile that is valid
for the TV (here: `Monitor32`).

```powershell
cd tv-app
npm install
$env:TIZEN_CLI = "C:\Users\<you>\.tizen-extension-platform\server\sdktools\data\tools\ide\bin\tizen.bat"
$env:TV_IP = "192.168.29.51"
npm run install-tv        # packages dist/PrimeVideoAdSkip.wgt (active profile, or TIZEN_PROFILE) and installs it
```

## Watching

```powershell
cd tv-app
$env:TV_IP = "192.168.29.51"
npm run watch             # launches the app on the TV with ad skipping; keep it running while watching
```

The console shows injection events and the script's `[PrimeTizen]` logs from the TV.
When you exit the app on the TV, the companion stops too.

### Movie list

Both apps start with a **Which movie?** list loaded from
`https://edrive.blackmushroom-4418eafb.southindia.azurecontainerapps.io/public/download/tizenMoviesToPlay.json?parent=tizenMovie`
(`MOVIES_URL` in `widget*/launcher.js`):

```json
{ "jioHotstar": ["https://www.hotstar.com/in/movies/<name>/<id>/watch"], "amazonPrime": ["https://www.primevideo.com/..."] }
```

Pick with Up/Down and OK; the chosen URL opens directly, so the site's home page never loads (Prime: the
title's Play/Resume button is pressed automatically, and the page loads with artwork suppressed: the
companion blocks Prime's image downloads and the script hides any artwork). If Prime shows no Play button
(signed out), the app opens Amazon's sign-in page and returns to the title afterwards. **Exit app**, under the movies, closes the app (Back on
the list too). **Back while watching returns to this list.** Titles come from the URL
(`/movies/<name>/` or `/detail/<name>/`); other URLs show as "Movie N". The list is fetched fresh at each
launch, so editing the JSON file is enough. A URL passed to the companion skips the list.

If you open the app from the TV's app list without the companion, it shows "Waiting for PC companion…".
Press **OK** to pick a movie from the list (played without ad skipping and without the cursor), or **BACK** to exit.

## JioHotstar

```powershell
npm run install-hotstar                              # one time
npm run hotstar                                      # the TV shows the movie list
node companion.js hotstar superman/1271509950        # = https://www.hotstar.com/in/movies/superman/1271509950/watch
node companion.js hotstar https://www.hotstar.com/in/...   # any full URL also works
```

- Without a movie, the TV shows the `jioHotstar` [movie list](#movie-list).
- Opens the given URL directly. If you aren't logged in, it opens
  `https://www.hotstar.com/in/mypage#mp-login` first and returns to the URL after you log in.
- Picks the **Jatin** profile on the "Who's watching?" page (`PROFILE_NAME` in `userScript.js`).
- No animations and no images (artwork, posters, backgrounds); the login QR code is kept.
- Skips ads: each ad is a short clip in the player, so the script jumps to its end (16x playback if
  the jump doesn't work). The movie's sound is never muted; if Hotstar starts muted (it does after a fresh install), the script presses Unmute.
- Selects the highest quality in the player's Quality menu (Full HD); Hotstar remembers it per profile.

Remote (with the companion): arrows move the cursor, OK clicks, Back returns to the movie list, media keys
control playback, while watching (cursor hidden) Left/Right seek ±10 s (hold for ±5 min) and OK
plays/pauses, and Red (A) toggles the cursor.

## Troubleshooting

| Symptom | Fix |
|---|---|
| `No TV connected` | Make sure the TV is on and reachable, Host PC IP is this PC, then `sdb connect <TV-IP>` |
| `Debug launch failed` | Reinstall with `npm run install-tv`; check `sdb devices` shows the TV |
| Ads aren't skipped | Watch the companion output. Prime may have changed its player DOM; update the selectors in `userScript.js` (no reinstall needed) |
| Prime says the browser is unsupported or video won't play | Change `USER_AGENT` in `widget/launcher.js` and reinstall |
