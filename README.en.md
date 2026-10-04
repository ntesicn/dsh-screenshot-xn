# dsh-screenshot-xn (DSH screenshot)

[简体中文](README.md) ｜ **English**

Adds a screenshot plugin to DSH Desktop: click the button next to the input box (or press `Alt+A`) → the whole screen dims and an **independent full-screen screenshot panel** appears (WeChat-style: it covers the entire screen including the taskbar, and the DSH window is temporarily hidden first, so what you see is the real desktop) → marquee select and annotate (rectangle / ellipse / arrow / pen / mosaic / text, with undo and redo) → click "insert into conversation / copy / save as", the panel closes, and the result lands in DSH.

The same selection can also **recognize text** and **translate** it: "recognize text" at the far left of the toolbar reads the selected region into copyable, editable text (default engine PP-OCRv6, running locally, **offline, no key**; falls back to the Windows built-in OCR when the model is not ready), and "translate" then turns it into any one of 9 languages (using **the model you already configured in DSH**, zero configuration by default); the source text and the translation both land on the same result card, each with its own "copy / Copy".

## Preview

All three below are real-machine shots (this machine's 3440×1440 primary screen), not staged and not composited:

**① Marquee select + annotate + region recognition (panel)** — the toolbar appears after you drag out a selection (the two buttons "recognize text" and "translate" are at the far left of the first row); rectangles/ellipses drawn in red, yellow arrows and a hand-drawn curve, and two text annotations are all drawn inside the selection; below is the result card of "recognize text" (engine `ppocr-v6-small`, elapsed time, line count, and "copy / Copy" at the end of the row). Recognition reads the **original image** on screen: a red frame drawn over text does not enter the recognition result.

<img src="assets/shot-3-annotate-ocr.png" alt="Full-screen screenshot panel: marquee selection 911×303 with a rectangle/ellipse/arrow/hand-drawn curve and two text annotations, and below it the recognize-text result card (ppocr-v6-small, 3 lines, 205 ms)" width="900">

**② Capture mode (right-click the screenshot button)** — "through capture (hide DSH)" and "normal capture (including the DSH window)", with a blue dot in front of the currently selected one; the choice is remembered, and both left click and `Alt+A` use it.

**③ The same setting in the DSH plugin page** — `plugins → DSH screenshot (xn)`, whose dropdown shows the same `captureMode`; changes take effect immediately and survive a restart.

<table>
<tr>
<td width="50%"><img src="assets/shot-1-mode-menu.png" alt="The capture mode menu popped up by right-clicking the screenshot button: through capture (hide DSH) / normal capture (including the DSH window), with a note at the bottom that the choice is remembered"></td>
<td width="50%"><img src="assets/shot-2-plugin-page.png" alt="DSH plugin page: DSH screenshot (xn) v1.0.1, the &quot;capture mode / Capture mode&quot; dropdown row, component dsh-screenshot-xn running"></td>
</tr>
<tr>
<td align="center">② Switch modes from the right-click menu</td>
<td align="center">③ Switch modes from the plugin page (the same setting)</td>
</tr>
</table>

> **Plugin name**: `dsh-screenshot-xn` (renamed from `dsh-screenshot` on 2026-09-30, to distinguish it from screenshot plugins with the same or a similar name on the market).
> The directory is still `E:\dshplugins\dsh-screenshot`; the only things changed are the **package name and the cordis row id/name** (which is what the plugin list and plugin page display).
> **Unchanged** (all frozen contracts, untouched by the rename): the route `/api/dsh-screenshot/*`, the metrics header `X-DSH-Screenshot`,
> the slot entry ids `dsh-screenshot.button` / `dsh-screenshot.overlay`, and the DOM marker `data-dsh-screenshot-ui`.
> The same-name migration has been done: registration in the active profile (dependency key / bundles / row id+name), the persisted `captureMode` override, and the node_modules links.

- Code origin: `E:\dshplugins\dsh-screenshot`
- Runtime: DSH Desktop (Windows). The host half depends on Windows PowerShell 5.1 + .NET `System.Drawing` (both built into the system, no third-party native dependencies); the independent panel is hosted by a kiosk window of the system browser (Edge / Chrome); the client half is pure browser code.
- Verified versions: **DSH 0.1.7-rc.2**, active profile `comfyui`, node v24.14.1, Windows PowerShell 5.1.26100.9444 (R-06: after upgrading DSH, re-verify the slots and routes visually).

> **You must restart DSH Desktop after changing code**: the host half (the routes in `index.js`, kiosk launching, exit cleanup) is only loaded when the DSH process starts. If the host is still an old version, clicking the screenshot button shows "independent screenshot panel unavailable… (overlay.start http 404)" and **automatically falls back** to the in-DSH overlay flow described under "Limitations" below — no functionality is missing, but that is not this version's main path.

---

## Installation

Installation is handled by the official `plugin_manager` tool; **do not** hand-write the profile's `package.json` / `cordis.patch.yml`, and do not run pnpm in the profile directory.

1. Point `plugin_manager`'s `install_bundle` at this directory's absolute path:

   ```
   plugin_manager
     action: install_bundle
     target: E:\dshplugins\dsh-screenshot
   ```

   That action calls pnpm to install the local directory into the active profile, and applies `cordis.patch.yml` according to `package.json`'s `dsh.bundle.patch`.

2. **Approval is required**: the install action (and possibly build scripts) will ask the user for approval; the installation does not take effect without approval. If `pendingBuilds` shows up in the response body, this plugin needs no build scripts at all — do not authorize any for it.

3. Record the `application` field returned by `install_bundle` (DoD A-7):

   | `application` | Meaning and follow-up |
   | --- | --- |
   | `applied` | Effective immediately (the client half is hot-loaded); the host half's routes are still the ones loaded at process start, so restart DSH if you changed `index.js` |
   | `restart-required` | Restart DSH Desktop and verify again |
   | `overridden` | A higher-priority layer overrode this row; check the profile's patch layers |
   | `failed` | Look at the response body's `warnings`/error reason; the usual cause is that `target` is not this directory's absolute path |

4. Self-check list (can be done within 30 s after install + restart):
   - Open any ordinary conversation; the screenshot button appears in the input box's action area, and hovering shows 「截图 / Screenshot」;
   - Click the button: the DSH window flickers (temporarily hidden and then restored), and then **the whole screen** is covered by the screenshot panel (including the taskbar);
   - Marquee select a region → the toolbar appears → click 「复制」 → the panel closes, you are back in DSH, and a success toast appears;
   - Press Esc in the panel (or right-click, or make the selection too small) → the panel closes, and the draft text and attachments in DSH are exactly the same as before entering;
   - Temporarily rename both Edge and Chrome (simulating "no browser") → clicking the screenshot button shows 「未找到可用的浏览器…」 and **you can still capture** (falling back to the in-DSH overlay).

---

## Configuration

Configuration goes in the `config:` of that one `cordis.patch.yml` row (`config: {}` means everything uses defaults). All keys are optional, and unknown keys are ignored.
Among them `captureMode` is special: it is declared by the `Config` schema as a **volatile** field, and is contributed to the DSH plugin page's `plugins.bundle.config` by the **client half** (`key` = the package name `dsh-screenshot`) — so it shows up as the "capture mode / Capture mode" dropdown on the `plugins → dsh-screenshot` page, through the same mechanism as the voice input plugin's "recognition service / recognition language". The value you change there (or in the right-click menu) is written by DSH into the **current profile**'s `cordis.patch.yml` (not this plugin's bundle patch), and takes effect immediately and survives a restart. Hand-writing `config: { captureMode: normal }` works just as well.
> Note: the DSH plugin page only renders the config area when there **is a client contribution** (the `configured ? … : null` layer outside `renderSlot("plugins.bundle.config", …, { entryKey: pkg.name })`), so this item has to be contributed by this plugin's `client.js` — that was the last missing link, added in t74.
> It looks like this (real-machine shot): see **③ Switch modes from the plugin page** under "Preview".

```yaml
- insert:
    - id: dsh-screenshot-xn
      name: dsh-screenshot-xn
      config:
        timeoutMs: 20000
        cacheTtlMs: 1500
        keepTempFile: false
```

**Capture (host)**

| Key | Default | Meaning |
| --- | --- | --- |
| `captureMode` | `through` | **The persistable capture mode** (`through` / `normal`), and the only item rendered in the settings page / plugin management: declared as a `volatile` field of `Config`, it takes effect immediately on change and is written into the current profile's patch, surviving a restart. The mode chosen in the right-click menu is what gets written here. |
| `enabled` | `true` | When `false` the plugin registers no routes at all (equivalent to temporarily disabling it) |
| `timeoutMs` | `20000` | Upper bound for a single capture; after the timeout the child process is terminated and `502 capture.failed` (`capture.timeout`) is returned |
| `cacheTtlMs` | `1500` | Short TTL cache for capture results: concurrent fetches are merged into one capture by "single flight"; the cache reference is released after the TTL (D-9) |
| `scriptPath` | `lib/capture.ps1` | Capture script path; a relative path is resolved against the package directory, and an absolute path also works (the fault-injection point of D-6) |
| `outDir` | `%TEMP%\dsh-screenshot-xn` | Temporary directory for capture PNGs (deleted right after reading, see `keepTempFile`) |
| `tag` | `dsh-screenshot-xn` | Filename prefix of the temporary PNGs |
| `keepTempFile` | `false` | When `true` the temporary PNGs are kept, for troubleshooting (note that disk usage accumulates). Since t75 it is also the switch for the region PNG used by recognition and the text file used by the clipboard |
| `powershellPath` | `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` | PowerShell engine path; when it does not exist it falls back to `powershell.exe` from `PATH` |
| `hideWaitMs` | `250` | How long to wait after hiding the DSH window before capturing. The value is clamped to `150`–`400` ms |
| `hideMethod` | `hide` | `hide` (`SW_HIDE`, the window disappears entirely) or `minimize` (`SW_MINIMIZE`, going through the minimize animation) |
| `dshImage` | Derived from `process.execPath` (e.g. `DSH Desktop`) | The image name used to confirm "this is my own window". Hiding is only allowed when one of pid / image name / title matches |
| `dshTitleHint` | `DSH` | Only windows whose title contains this fragment count as DSH's (the final fallback criterion) |
| `dshPid` | The pid of the plugin host process's parent process | The preferred owning process of the window (the Electron main process). The script also cross-checks with the image name/title |

**Independent screenshot panel (overlay, B1)**

| Key | Default | Meaning |
| --- | --- | --- |
| `overlayBrowserPaths` | Edge ×2 → Chrome ×2 (`C:\Program Files…`) | Candidate browser executables, taking the first that exists in order; if you supply a custom list it will **no longer** look in `PATH` |
| `overlayDir` | In-package `overlay/` | Panel page directory (`index.html` + `overlay.js` + `overlay.css`), served same-origin by the host |
| `overlayHostScript` | `lib/overlay-host.ps1` | Helper script for browser lookup / kiosk liveness probing / closing and force-killing the window |
| `overlayHeartbeatMs` | `5000` | Heartbeat silence limit: the panel page sends a heartbeat every 1 s, and if no message arrives within this window the session is judged `aborted` (clamped to 1000–5000) |
| `overlayTimeoutMs` | `120000` | Upper bound for a single panel session; when reached it is judged `timeout` and the kiosk window is closed (clamped to 5 s–15 min) |
| `overlayRetainMs` | `30000` | How long the frame/result is retained after a session ends (the client needs to fetch the result PNG after `ready`) |
| `overlayBodyLimitBytes` | `33554432` | Upper bound for the result posted back by the panel (32 MB) |
| `overlayLaunch` | None (use a real browser) | **For offline testing only**: replace the browser launch command with a custom argv stand-in, where `${url}` / `${token}` are substituted; the environment variable `DSH_SCREENSHOT_OVERLAY_LAUNCH` (JSON array or space-separated command) also works |

**Region recognition and translation (t75)**

| Key | Default | Meaning |
| --- | --- | --- |
| `ocrEnabled` | `true` | When `false` the recognition endpoint returns `503 ocr.disabled` (the button is still visible in the panel, and clicking it explains why) |
| `ocrScriptPath` | `lib/ocr.ps1` | Recognition script path; a relative path is resolved against the package directory. It runs on **Windows PowerShell 5.1** (`powershellPath`, the same engine `capture.ps1` uses) — only 5.1 still projects the WinRT type `Windows.Media.Ocr` |
| `ocrLanguage` | Empty (auto) | A BCP-47 tag such as `zh-Hans-CN` / `en-US`; **empty = use the language order configured for the Windows user**. Dirty values (containing quotes, semicolons, over-long variants) always fall back to "auto" and are never passed into script arguments |
| `ocrTimeoutMs` | `20000` | Upper bound for a single recognition; on timeout it returns `504 ocr.timeout` |

**Recognition engine (t77: switched to PP-OCRv6 by default, running locally)**

The Windows built-in engine is very poor at **screenshots of small Chinese text** (for the same real-machine screenshot of 1978×1059, "截取屏幕、框选并标注，然后复制、另存为或插入当前对话。"
was read as "截取驛幂梃选并标注 然 制 、 另 存 为 或 入 当 前 对 话"). So the default engine was switched to
**PP-OCRv6 (detection + recognition) running on `onnxruntime-node`**: for that same image it reads
`DSH 截图 v1.0.0` / `dsh-screenshot` / `截取屏幕、框选并标注，然后复制、另存为或插入当前对话。` /
`穿透截图(隐藏 DSH) / Through (hide DSH)`, in about 1.6s (CPU, 960 long edge, 30 lines).

| Key | Default | Meaning |
| --- | --- | --- |
| `ocrEngine` | `auto` | `auto` = use PP-OCR when the model is ready, otherwise fall back to the Windows engine; `onnx` = force PP-OCR (unavailable means `503 ocr.unavailable`, with no silent degrade); `windows` = use the built-in engine only |
| `ocrModelTier` | `small` | `tiny` / `small` / `medium` (two models: detection + recognition). Sizes: tiny ≈ ?/ small ≈ 9.9MB + 21.2MB / medium larger, with quality increasing |
| `ocrModelDir` | `~/.dsh/dsh-screenshot-ocr` | Model storage directory (the user data directory, not a temporary directory); delete it to go back to the Windows engine |
| `ocrModelSource` | The official ModelScope direct link | Model download source prefix; change it when you need your own mirror/proxy (the default source is directly reachable in China) |
| `ocrDownloadModels` | `true` | Download models on demand at the first recognition (SHA256 verified, written to `.part` and then atomically renamed). `false` = never go online, using only existing models or the Windows engine |
| `ocrDetLimit` | `960` | Upper bound for the detection input's long edge (clamped to 320–4096); larger is more accurate and slower |

**Dependencies and size**: the runtime is the npm package `onnxruntime-node` (prebuilt, no Python/GPU/administrator needed), declared as an
**optional dependency**: when build scripts are not allowed / it cannot be installed / you are offline, **the plugin still installs and works**, and OCR automatically falls back to the Windows engine (the `auto` tier).
Its postinstall downloads native libraries, so **allowing build scripts** at install time makes OCR stronger (the manager will ask). This package ships the binaries of every platform in its tarball (measured at 287MB),
and this plugin includes a pruning helper that keeps only the current platform:

```
node lib/prune-onnx-runtime.mjs            # first see how much can be saved (report only)
node lib/prune-onnx-runtime.mjs --apply    # actually delete: 288MB → 65MB (win-x64); reinstalling the dependency restores it
```

Neither the models nor the ONNX Runtime are **distributed with the package**, nor do they go into git. Licensing: the PP-OCR models and the RapidOCR manifest are Apache-2.0,
and `onnxruntime-node` is MIT; this plugin only downloads the official direct links and verifies against the official SHA256 (see the manifest in `lib/ocr-models.mjs`).

| `translateEnabled` | `true` | When `false` the translation endpoint returns `503 translate.disabled`. Translation **really calls your model** (spending tokens), so it has its own switch |
| `translateProvider` / `translateModel` | Empty / empty | Which model route to use for translation; **leaving both empty = use DSH's current default model** (`agentDefaultModel.currentSelection()`), hence zero configuration by default |
| `translateTarget` | `zh-Hans` | The default target language; the value is an id from the closed set in `lib/ocr.mjs` (`zh-Hans`/`zh-Hant`/`en`/`ja`/`ko`/`fr`/`de`/`es`/`ru`). It only decides the panel dropdown's **initial value**: what the user changes on the card affects only the current session |
| `translateTimeoutMs` | `45000` | Upper bound for a single translation; when reached it aborts the request with `AbortController` and returns `504 translate.timeout` |
| `translateMaxTokens` | `4000` | Upper bound for the translation output (a screenful of text needs no more) |
| `translatePrompt` | Empty | Extra requirements appended after the system prompt (for example "keep terminology in English"), listed item by item alongside the built-in rules |

**Host routes (the client half depends on them, and they can also be used for self-checks)**

| Item | Value |
| --- | --- |
| Capture | `GET /api/dsh-screenshot/capture` (other methods `405 {"ok":false,"error":"method.not_allowed"}`) |
| Capture success | `200`, body is a PNG, `Content-Type: image/png`, `Cache-Control: no-store, max-age=0` |
| Capture metrics header | `X-DSH-Screenshot: <base64url(JSON)>`, shaped like `{"widthPx":3440,"heightPx":1440,"url":"/api/dsh-screenshot/capture","scale":1,"bounds":{"x":0,"y":0,"width":3440,"height":1440},"viewportCss":{...},"bytes":2202907,"elapsedMs":148,"mode":"through","hiddenMs":325,"restoreOk":true}` |
| Capture failure | `502`, `{"ok":false,"error":"capture.failed","message":"<short text, e.g. capture.timeout: no result within 20000 ms>"}` |
| Capture query parameters | `vw`/`vh` = the client's CSS viewport width/height at capture time; `fresh=1` skips the cache and captures again; `mode=through` enables through capture (absent/any other value = normal mode) |
| Panel session | `POST /api/dsh-screenshot/overlay/start` → `{ok:true,token,startMs,mode,hiddenMs,frameBytes}`, or `{ok:false,reason:"no-browser"}` when no browser is available (**without hiding DSH and without capturing**) |
| Panel page and static assets | `GET …/overlay/page?token=`, `…/overlay/asset/<name>`, `…/overlay/lib/<name>.mjs` (pure logic modules are handed straight to the page for import, not copied) |
| Panel frame / result | `GET …/overlay/frame?token=` (the frozen frame in the session cache, so refreshing the page does not capture a second time), `GET …/overlay/result.png?token=` (only available after `ready`) |
| Panel status / heartbeat / submit | `GET …/overlay/status?token=` → `{state:"running"|"ready"|"cancelled"|"aborted"|"timeout", action, hasResult}`; `GET …/overlay/ping?token=`; `POST …/overlay/result?token=` with body `{action:"insert"|"copy"|"save"|"cancel", png:"data:image/png;base64,…"}` (you can also POST the PNG bytes directly + `?action=`) |
| Region recognition | `POST …/overlay/ocr?token=` with body `{png:"data:image/png;base64,…", language?:"zh-Hans-CN"}` → `200 {ok:true,text,lines:[{text,words:[{text,x,y,width,height}]}],language,engine,elapsedMs,empty}`; failures `400 ocr.bad-body` / `503 ocr.unavailable,ocr.disabled` / `502 ocr.failed` / `504 ocr.timeout` |
| Translation | `POST …/overlay/translate?token=` with body `{text:"…", target?:"ja"}` → `200 {ok:true,text,source,target,provider,model,unchanged,truncated,elapsedMs}`; failures `400 translate.bad-body` / `503 translate.unavailable,translate.disabled` / `502 translate.failed` / `504 translate.timeout` |
| Copy text | `POST …/overlay/clipboard?token=` with body `{text:"…"}` → `200 {ok:true,chars,elapsedMs}`. **The page itself never touches the clipboard**: it hands the text to the host, and the host writes the system clipboard with `lib/clipboard.ps1` (t57-4 in `tests/overlay-page.test.mjs` pins this down) |
| Unknown token | `404 {"ok":false,"error":"overlay.unknown-token"}` (all data routes validate the token first, including the three above) |

Note: the metrics header uses the **base64url** alphabet (`-`, `_`, with no `=` padding), so clients must restore standard base64 before decoding.

Capture pipeline: `index.js` → `lib/capture.ps1` (DPI-aware, `SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)`) → outputs `---JSON-BEGIN--- {...} ---JSON-END---`; when the script fails it reports the error with a non-zero exit code + JSON containing `ok:false`. It prefers the `subprocess` process Service already provided by the host, falling back to `node:child_process` when unavailable; both paths are bounded by `timeoutMs`, hide the child process console window, and force-terminate on timeout (D-7: no leftover processes).

**Hiding DSH during capture (across both paths)**

- Semantics: before capturing, **DSH's own window** is temporarily hidden (`SW_HIDE`, or `hideMethod: minimize`), then it waits `hideWaitMs` for the desktop compositor to repaint, captures one frame, and **restores immediately** (`SW_RESTORE` + `SetForegroundWindow`). Desktop content occluded by DSH can therefore be captured, and the image seen in the panel **does not contain the DSH UI**.
- Only its own window is touched: the script confirms "this is DSH's window" with three criteria — ① parent process pid ② image name ③ title fragment — and it must be a visible top-level window and not the script itself. **If any one of them does not match, nothing is hidden**, and it falls back to an ordinary capture (the response is still `200`, only `mode` goes back to `normal` and the image contains DSH) — better to capture DSH than to minimize the user's other windows.
- Restoration does not rely on luck: hide + wait + capture + restore all run inside the script's `try/finally`; the restoration criterion is "the window is visible again and not minimized", and `SW_RESTORE` retries and degrades in turn to `SW_SHOW`/`SW_SHOWNORMAL`; if the script reports `restoreOk:false`, the host additionally runs the `-RestoreOnly` rescue entry point (idempotent, with a 5 s cap). When restoration is unconfirmed the whole request returns `502`, and an image that "may be stuck in the hidden state" is never handed to the client.
- Timings (measured on this machine at 3440×1440, in-script timing taking the median of 3 runs):

  | Path | Total script time | Of which the hide segment `hiddenMs` | End to end (including process startup) |
  | --- | --- | --- | --- |
  | Normal (no hiding) | 89 ms | 0 | ≈ 490 ms |
  | Hide then capture (`hideWaitMs: 250`) | 539 ms | 325 ms | ≈ 980 ms |
  | Hide then capture (`hideWaitMs: 150`) | 442 ms | 230 ms | ≈ 890 ms |

  That is, hiding costs about 350–450 ms more than not hiding. To make the panel pop up faster, set `hideWaitMs` to `150` (less waiting may leave individual windows on a semi-transparent fade-out frame; weigh that yourself).

---

## Uninstall

Two ways, either one:

1. **Complete removal**: `plugin_manager` → `action: remove_bundle`, `target: dsh-screenshot-xn`. That action removes the package and the bundle row from the active profile; after restarting as prompted the button disappears and DSH starts normally (F-4). The workspace source directory is unaffected.
2. **Temporary disabling**: `plugin_manager` → `action: set_bundle`, `target: dsh-screenshot-xn`, `enabled: false`. After a restart the plugin is not activated and the input box is unaffected (D-5); `enabled: true` restores it.

Leftover check: after uninstalling, `%TEMP%\dsh-screenshot-xn` holds at most the temporary PNGs this plugin left behind (on the normal path they are deleted right after reading); `%TEMP%\dsh-screenshot-xn-overlay-<token>` is the one-off profile of the panel browser and is deleted when the session ends (abnormal paths such as force-killing may leave an empty directory, which can simply be deleted).

---

## Troubleshooting

| Symptom | Cause and handling |
| --- | --- |
| No screenshot button next to the input box | ① The plugin is not activated: confirm that `install_bundle` returned `application: applied`, otherwise restart once; ② the client bundle is not loaded: open the developer tools and look for `bundle ... loaded without registering "dsh-screenshot"`; ③ the slot: this plugin currently registers only `conversation.input.right` (if that slot does not render under some composer variant, the fallback is to register `conversation.composer.dock` instead, which moves the button below the input card — see "Limitations") |
| After clicking the screenshot button, **the whole screen is covered by a white/grey background, with only a line "drag the mouse to select" and one input box visible** | The panel page's **CSS/JS did not load** (an unstyled skeleton). Cause (fixed in t64): the host put token validation before the static asset branch, while the page's `<link>`, `<script>` and static `import '…/overlay/lib/x.mjs'` all carry no token → all three families 404, not a single line of script runs, there is no heartbeat, and the session goes `aborted` after 5 s. **After fixing it you must restart DSH Desktop** (the host half is only loaded at process start); the page has its own startup watchdog, so if this happens again it shows a red banner at the top of the screen (containing its own URL), and the host log gains an `overlay static file missing:` line |
| After clicking the screenshot button, 「独立截图面板不可用…（overlay.start http 404）」 appears | The host half is still an old version (without the overlay routes): **restart DSH Desktop**. This capture has already automatically fallen back to the in-DSH overlay flow, so no functionality is missing |
| After clicking the screenshot button, 「未找到可用的浏览器（Edge / Chrome）…」 appears | There is no Edge/Chrome on the machine, or `overlayBrowserPaths` points somewhere wrong: the panel cannot be hosted full-screen, and this capture automatically falls back to the in-DSH overlay flow |
| After clicking the screenshot button it spins forever / reports 「抓屏失败」 | The host capture route is not reachable. First fetch `/api/dsh-screenshot/capture` in the browser and look at the response: `404` means the route is not registered (the plugin is not activated or the `webServer` service is absent; look for `[dsh-screenshot]` lines in the DSH log); `502` means the script failed, and `message` carries a `capture.*` sub-code (`capture.script-missing` = `scriptPath` points somewhere wrong, `capture.timeout` = timeout, `capture.spawn-failed` = powershell not found) |
| After clicking the screenshot button, `502` with `capture.timeout` in `message` | A single capture exceeded `timeoutMs`. First raise `timeoutMs`; if it still times out, run `npm run capture:probe` manually to observe the timings (measured on this machine: the script's own capture 73 ms, 155 ms including saving; about 560 ms end to end after Node starts the process) |
| The panel appears, but the DSH window still shows up in the image | The host failed to confirm "this is DSH's window" (pid/image name/title all three do not match) → the script by design falls back to a capture with "no hiding" and shows a visible hint in the UI. Check `dshPid` / `dshImage` / `dshTitleHint` |
| The panel freezes, or after submitting it never returns to DSH | The panel page sends a heartbeat every 1 s; if no message arrives for longer than `overlayHeartbeatMs` the host judges `aborted` and closes the window, with a visible hint on the DSH side (retryable); the overall session cap is `overlayTimeoutMs` |
| Nothing is inserted into DSH after the panel submits | Insertion goes through the official paste bridge (the attachment count of `useInput` must increase for it to count as success); when the bridge is unavailable it **really degrades** to "copy to clipboard + prompt to press Ctrl+V manually", never silently. Look for `[dsh-screenshot] paste bridge …` lines in the console |
| Route `404` | When `webServer` is not activated (a minimal profile) the plugin only logs one line and registers no routes; that is by design (the plugin will not drag startup down). Switch to a profile with a web carrier |
| Coordinates do not line up (the marquee selection and the pasted image disagree) | The panel is **full-screen 1:1**: the page draws by "bitmap size = frozen frame pixels, CSS size = viewport size", so marquee selection coordinates are screen coordinates. If an offset really does appear, first confirm that the capture is DPI-aware (`dpi_awareness` in the output of `npm run capture:probe` should contain `=True`, and `scale` should be 1), and attach the panel console's `[dsh-screenshot] overlay mapping` log |
| The in-DSH panel is hard to read after a theme switch | The in-DSH overlay uses only `--dsw-alias-*` tokens; the independent panel is a **separate window** with its own dark UI and does not depend on the DSH theme (that is deliberate: a separate window cannot get DSH's CSS variables) |
| Permission/security software blocks PowerShell | Capture depends on launching `powershell.exe`. When enterprise policy disables `-ExecutionPolicy Bypass` or intercepts scripts, point `scriptPath` at an allowed copy, or invoke it again under an allowed policy; failures are always reported explicitly as `502 + capture.failed`, never silently |
| Want to verify the pure-logic unit tests | Run `npm test` (that is, `node --test`) in the package directory. The cases are fully offline: they do not read the real screen, do not go online, and do not load the DSH runtime |
| Recognition says "this machine has no usable OCR language pack" | The Windows OCR engine needs language packs: `Settings → Time & language → Language & region`, and add "optional language features → optical character recognition" for Chinese/English. To see exactly which ones are installed on this machine, just run `powershell -NoProfile -ExecutionPolicy Bypass -File lib/ocr.ps1 -ListLanguages`; having only one installed is fine too, since leaving `ocrLanguage` empty uses it |
| Recognition comes out as question marks/boxes | That is a PowerShell **stdout encoding** problem, not a recognition problem: a redirected pipe writes by default in the OEM code page (936/GBK on Chinese machines) while the host reads UTF-8. `lib/ocr.ps1` and `lib/clipboard.ps1` already pin `[Console]::OutputEncoding` to UTF-8 at the top; remember to do the same when you write your own script against the same set of interfaces |
| Clicking translate does nothing / reports 「没有可用于翻译的模型」 | Translation goes through `ctx.get('llm')` + DSH's default model. First confirm that this profile has a usable model (the model selector has a value); you can also explicitly specify `translateProvider` / `translateModel` in the config |
| Do not want the screenshot feature to spend tokens | Set `translateEnabled` to `false`: the translation endpoint then returns `503 translate.disabled` and the UI explains why. Recognition is purely local and unaffected |

---

## Features and interaction (against DoD section B)

- **Entry point**: the screenshot button in the input box's action area (`conversation.input.right`), with the label 「截图 / Screenshot」; `Alt+A` is the same entry point (an in-app shortcut, see "Limitations").
- **Two capture modes (right-click menu, C-6)**: **right-clicking the screenshot icon** pops up the mode menu (real-machine shot: **② Switch modes from the right-click menu** under "Preview"); choose "through capture (hide DSH)" (**the default**) or "normal capture (including the DSH window)":
  - Through: DSH is temporarily hidden before the capture and restored after it, and **there is no DSH in the image** (this is what normal screenshots use);
  - Normal: no hiding, and **the DSH window is right there in the image** (used to capture DSH's own UI); in this case the panel's hint line states 「普通模式：这次画面里包含 DSH 窗口…」, and the DSH side also gives a hint that 「普通模式：本次画面会包含 DSH 窗口」 — so you will not think the plugin is broken;
  - The choice **is remembered** (t73): once selected it is written straight back to the host → the host writes it into the **plugin config** (`captureMode`, that is, the item in the settings page / plugin management, landing in the current profile's patch), so **no re-selection is needed after a DSH restart**; **left click / Alt+A both use the remembered mode**; the menu itself does not trigger a capture (captures are always triggered explicitly by left click / Alt+A). The menu supports the keyboard: ↑↓ to move, Enter/Space to select, Esc or clicking outside to close, and the button carries `aria-haspopup="menu"` / `aria-expanded`.
  - **The two ways of switching are equivalent**: the right-click menu (convenient) and **this plugin's "capture mode" dropdown in the DSH plugin page** (`plugins → dsh-screenshot-xn → capture mode`, the same mechanism as the voice input plugin's "recognition service / recognition language", using a native `<select>`) write the same configuration; changes in the plugin page take effect **immediately, with no restart** (the field is declared `volatile`, and the loader updates the running value in place), and after a DSH restart the last selected value still applies.
  - **Once changed, it is always the one used (t74c)**: selecting in the plugin page control writes into the shared session state **immediately**, and `startShot()` checks with the host once more **before** capturing — no matter whether the mode was changed from the right-click menu, the plugin page, another window, or by hand-editing the patch, **the next capture uses the latest value**. Before the fix the behavior was "the plugin page could switch it, but the capture still followed that older choice from the right-click menu" (the plugin page is another React tree, which only wrote the host config and nobody updated the client's in-memory copy).
- **Main path = the independent full-screen screenshot panel (B1)**: click the button / `Alt+A` → `POST /overlay/start?mode=…`: the host **captures one frame according to the current mode** (through = hide DSH first, capture, then restore; normal = capture directly), then uses the system browser to launch a **full-screen kiosk window** (covering the whole screen including the taskbar) that opens the panel page → marquee select and annotate in the panel → click "insert into conversation / copy / save as" → the panel hands "the action name + a PNG containing only the selection and annotations" back to the host and closes itself → **the action is executed on the DSH side** (insertion goes through the already-verified paste bridge, copy writes the system clipboard, save as opens the system dialog), followed by a light toast and focus returning to the input box.
  - Panel availability is decided **before** capturing: when the machine has no Edge/Chrome, `start` answers `no-browser` directly (no hiding, no capture), the UI shows a visible hint, and it falls back.
  - `Esc` / right-click / a marquee selection smaller than 8 px: the panel closes, **producing no image**, writing no clipboard, and touching no draft (B-4/B-5), with a neutral hint on the DSH side.
  - Abnormal endings other than cancellation (the panel being closed directly → `aborted`, exceeding `overlayTimeoutMs` → `timeout`, the host losing contact → `unreachable`) all give a **visible error hint** and can be retried; there is never a permanent busy state.
  - Slow and stuck are distinguishable: the DSH-side button is in a busy state during the session (disabled + progress cursor + `aria-busy`).
- **Fallback path = the in-DSH overlay** (`shell.overlay`, with the entry setting its own `pointer-events`): when the panel is unavailable (no browser / the host has not loaded the overlay routes / `start` failed) it **automatically** takes this path, states in the UI that "switched to the in-DSH capture", and **captures according to the current mode just the same** (`startCapture(runtime, through)`); this path is the complete implementation from the previous round (capture → frozen frame inside the DSH window → marquee select → annotate → three kinds of output), so no functionality is missing.
- **Marquee select**: drag out a rectangle; inside the region keeps its original colors while outside is dimmed; the "width × height" and crosshair guides are shown live; releasing brings up the selection and the toolbar. A selection narrower or shorter than 8 px counts as invalid: this capture is cancelled, no image is produced and no clipboard is written (B-5).
- **Fine-tuning**: 8 handles resize it (the opposite edge stays fixed), and dragging inside the selection pans it.
- **Toolbar (t65/t66/t68)**: **all buttons are icon buttons** (hovering reveals the name, `title` + `aria-label`), **fixed to two rows** (not relying on automatic wrapping — the wrap points would be random and the ragged lengths ugly):
  - First row: tools (move/rectangle/ellipse/arrow/pen/mosaic/text) + undo/redo, with four action icons at the end of the row in the order **copy → ⤓ save as → ✕ cancel → ✓ insert into conversation** (✓ is the confirmation key at the end of the row and also the default highlighted action);
  - Second row: colors (circular swatches, **appearing only under tools that deposit color**) + the levels that the current tool can use + the output size `width × height px` at the end of the row.
- **Colors and levels shown/hidden by the current tool (t68/t72)**: **colors appear only under rectangle/ellipse/arrow/pen/text** — the move tool deposits no color, and mosaic's color does not participate in drawing at all in `lib` (it only pixelates), so neither of them shows the swatches; **line width (thin/medium/thick) appears only under rectangle/ellipse/arrow/pen**; font size appears only under the text tool; mosaic granularity appears only under the mosaic tool. Each vertical divider is shown only when "the group behind it is visible and a visible group has already appeared before it" (for example, under the mosaic tool both the swatches and line width are collapsed, so no lone divider hangs in front of granularity). Undo/redo are greyed out when there is no history. The icons use the same set of path data as `client.js`'s `toolIcon`/`undoIcon`/`redoIcon`/`closeIcon` (plus `check`/`copy`/`download` for the action icons), so the toolbars of both entry points look the same and follow the same show/hide rules.
- **Annotations**: six kinds — rectangle, ellipse, arrow, pen, mosaic and text — with optional color/line width/font size (B-6); the mosaic block size changes with the intensity setting. The independent panel and the in-DSH overlay use the **same pure logic** (`lib/annotations.mjs` and the like, imported by the panel as ES modules served by the host); there are no two implementations.
- **Undo/redo**: Ctrl+Z / Ctrl+Y, rolling back and restoring in operation order, with the original image untouched (B-7); moving/resizing/deleting an already-placed annotation also counts as one history entry each (**one drag = one history entry**).
- **Selecting / moving / resizing / deleting placed annotations (B-13)** — the panel's flow is **"hover means handle, press means drag"** (t71):
  - **Hover means handle**: when the mouse enters the area of an already-drawn annotation the cursor immediately becomes a drag handle (`move`); on the corner handle of a selected annotation it is a resize cursor; inside the selection (under the move tool) it is also a move cursor. **No need to switch tools first, and no need to click to select first**.
  - **Press means drag**: pressing on an annotation drags it right away — the displacement matches the drag and is **clamped inside the selection** (it stops at the edge); only that annotation is affected. Dragging takes priority over "drawing a new annotation": to draw a new one where an existing annotation sits, drag it away first (or undo with `Ctrl+Z`).
  - **Double-click to edit text**: while the cursor is in the handle state (that is, clicking on a placed **text** annotation), double-clicking → an input box appears, **prefilled with the original text and fully selected** → Enter replaces it (one edit = one history entry, position unchanged); clearing the text or pressing Esc = no change.
  - **Resizing**: dragging any corner handle changes the font size for text, `rect` for rectangle/ellipse/arrow, and `bounds` for pen/mosaic; there is a minimum edge of 8 px.
  - **Deleting**: in the selected state, Delete or Backspace deletes only that annotation; the deletion can be restored with Ctrl+Z.
  - **One drag = one history entry**: every intermediate frame is only a preview, and a history entry is written only on release (one Ctrl+Z goes back to before the drag).
  - Implementation stance: it reuses `lib/annotations.mjs`'s `annotationRect` / `findAnnotationAt` / `hitAnnotationHandle` / `moveAnnotation` / `resizeAnnotationRect` / `scaleAnnotation`; **annotations are always stored in "device pixels"** (the lib's convention), and the entry point converts the pointer's viewport coordinates once, so drawing and exporting never convert again — at any zoom ratio "what you see, what you drag, and what you export" are the same coordinate set (t70 fix: the panel previously stored annotations in viewport coordinates and multiplied by the ratio only when drawing, the opposite of the lib's convention, and had no drag logic at all).
  - Difference from the in-DSH overlay: over there "select/move" still requires switching to the "move" tool first (B-13's original premise), whereas this side of the panel has been made tool-independent (t71, the user's stance). If you want both sides exactly the same, just say so and I will change that one too.
  - Known defect: the visual position and the hit position of the selection handles are offset; see R5-02 under "Limitations".
- **Output**: copy to clipboard (only the selection's content, including annotations but excluding the mask and the toolbar), save as (default filename `DSH截图_yyyyMMdd_HHmmss.png`; when degrading to WebP above 4 MB the default name and extension become `.webp` in step), insert into conversation (the default highlighted action).
- **Implementation path of insert into conversation (B-10 / B-12)**: it goes through the official paste intake bridge — it constructs a `ClipboardEvent('paste')` (with a `File` in the DataTransfer) and dispatches it to the input box editor, hitting the paste command that the conversation registers itself, exactly the same code path as "the user manually pasting an image with Ctrl+V". The success criterion is hard: the length of `useInput(s => s.attachmentIds)` must increase within the window for it to count as success; when the bridge is unavailable, the event is rejected, or there is no increment, it **really degrades** to copying to the clipboard + the visible hint "screenshot copied; you can paste it in the input box with Ctrl+V", never failing silently.
- **Region recognition + translation (t75)**: two more icon buttons appear at the far left of the toolbar's first row — **recognize text** (a viewfinder frame) and **translate** (a globe) — separated from the four "what to do with the image" actions on the right by a vertical divider. After a marquee selection:
  - Clicking **recognize text** → a **result card** pops up, whose upper half holds the recognized text, whose title row gives "line count · engine language · elapsed time" on the right, and whose row end holds "copy / Copy" and a close ✕.
  - Clicking **translate** → both halves of the card are filled in: the source text on top and the translation below, with a "target / Target" dropdown (9 languages, whose options come straight from the closed set in `lib/ocr.mjs`), the model route and the elapsed time on the right of the title row, and "copy / Copy" at the row end as well. **Changing the target language = re-translating only, without recognizing again**; **clicking translate on an already-recognized selection does not recognize it a second time**.
  - The card sits below the toolbar (retreating above the selection when there is no room, and finally being clamped back inside the viewport); it scrolls, its text **can be selected**, and pressing the pointer inside it does not drag out a new selection. The first `Esc` only collapses the card, and the second cancels the whole capture.
  - **What is recognized is the original image on screen**: the region to be recognized is **cut as-is** from the frozen frame, without drawing annotations — if you draw a red frame over text and then click recognize, the red frame does not become part of the recognition result (the same goes for mosaic: what you want to hide should not be recognized).
  - **As soon as the selection changes, the card collapses immediately**: results are accounted against "the selection that produced them", so there is no such thing as "after shrinking the selection, the translation is still of the previous region's text".
  - Recognition is **offline**: `Windows.Media.Ocr` is an engine built into Windows, needing no API key and no network. Translation in turn uses **the model you already configured in DSH** (zero configuration by default) and asks for no extra key.
  - No text in the selection **is not an error**: the card writes 「没识别到文字 · No text found」. Genuine failures each have their own words: no language pack installed, recognition timeout, model unavailable, translation timeout, text too long (truncated by line above 8000 characters and marked) — each has its own error code (`OCR_ERROR_KEYS` in `lib/ocr.mjs` maps host codes to panel copy, so the two sides never each write their own set).

---

## Limitations

1. **Primary screen only (single-screen convention, E-2)**: both the capture and the panel work on the primary screen, and in dual/multi-screen environments there is no cross-screen stitching (cross-screen is P2, not in this round); `npm run capture:probe` reports `capture_bounds`, `virtual_screen`, `screen_count` and `single_screen`; with multiple screens the host log gains a "capturing the primary screen only" line.
2. **The panel needs a system browser (Edge / Chrome)**: the kiosk window is hosted by its executable (default candidates in the configuration table). Without a browser it falls back to the in-DSH overlay — that path's image is **inside the DSH window**, so desktop content occluded by DSH cannot be captured (the B1 main path does not have this problem, because DSH is already hidden when capturing).
3. **`ALT+A` is an in-app shortcut and only works while the DSH window is focused**: a host-side global hotkey (PRD F-04/C-1) is not done this round — the plugin host cannot reach Electron's `globalShortcut`, and registering a system-level hotkey needs a resident process/native module, while the user has confirmed "no resident process". `ALT+A` therefore goes through the page's `keydown`, and **pressing it while DSH is not focused has no effect** (while the panel is open DSH is behind it, so pressing it again does not re-trigger); it may conflict with some input methods/system shortcuts (when it conflicts, the behavior of the input box in DSH is what counts).
4. **Automatic degrade above 4 MB (F-23 / D-8)**: lossless PNG is preferred; above 4 MB it is first downsampled to the logical resolution, and if still over, converted to lossy WebP. When degrading to WebP the artifact label follows the actual encoding format too (`formatOf` in `lib/output.mjs`); the threshold and degradation method are configurable (`DEFAULT_SIZE_POLICY` in `lib/capture-plan.mjs`). The panel side uses the same policy, so the bytes the panel hands back have already been processed according to that policy.
5. **Zoom ratios of 125% / 150% / 200% (D-3)**: the capture script runs with per-monitor-v2 DPI awareness, so the bitmap should be in physical pixels (`scale` in `capture:probe` should be 1). The panel page's 1:1 is the alignment of "**screen physical pixels : canvas bitmap : frozen frame pixels**": the canvas bitmap size = frozen frame pixels, the canvas CSS size = the viewport, and the frozen frame layer is drawn with the identity transform (since t64; before that it mistakenly used the annotation layer's CSS→device ratio, so when viewport ≠ frame size it cropped the whole screen into a magnified top-left image — see the 1:1 contract and negative sample 8 in `tests/overlay-page.test.mjs`). With a full-screen kiosk + 100% display scaling the viewport CSS width = the frame pixel width (measured on this machine: 3440×1440, `AppliedDPI=96`), and the three are strictly 1:1; **if you make the kiosk windowed, or change the display scaling/browser zoom**, the page's mapping premise no longer holds (a known boundary, out of scope for this round).
6. **The panel takes a moment to appear the first time (D-1)**: the capture leg (hide → capture → restore) measured ≈890–980 ms on this machine, and kiosk cold start measured 435–458 ms in the spike (`docs/stage2-spike/REPORT.md`), so the rule of thumb for "click the button → the panel is interactive" is about 1.2–1.5 s. To shorten that stretch, lower `hideWaitMs` (see the timing table above).
7. **The button slot is source-level evidence**: the kind/scope and render position of `conversation.input.right` have been verified, but the ownerProps were not verified one by one; the current implementation registers only this one slot (with no automatic fallback), so if you visually find that it does not render under this composer variant, the fallback is to register `conversation.composer.dock` instead.
8. **Known defect R5-02: the visual position and the hit position of the selection handles are misaligned** (logged in review round 5, not fixed this round): the 8 handle squares drawn on the selection's outline are offset from their draggable hit areas (hit testing works by coordinates + the `HANDLE_TOLERANCE` tolerance and does not depend on the square elements themselves). When resizing the selection, go by "after the hit, the cursor becomes the resize arrow for the corresponding direction"; it does not affect marquee selection, annotations or output.
9. **P1 not done**: the global hotkey (F-04) and settings persistence (F-05) are deferred this round; P2 (cross-screen stitching, scrolling long screenshots, cloud capture, etc.) is not done.
10. **Windows only**: the capture goes through PowerShell + `System.Drawing`; recognition goes through Windows' built-in `Windows.Media.Ocr` (equally Windows-specific). On other platforms the plugin registers no routes (it only logs one line).
11. **Recognition reads the original image, without annotations (a deliberate choice in t75)**: the region to be recognized is cut straight from the frozen frame, and the rectangles/ellipses/arrows/pen strokes/text you drew **will not** enter the recognition result. The benefit is that "draw a frame over the text and then recognize" is not polluted by your own annotations; the cost is that "recognize the annotations along with it" is impossible (which was never recognition's job anyway).
12. **Translation spends your own tokens**: translation sends one text call with DSH's current default model (`translateEnabled` can turn it off). Recognition is entirely local and costs nothing.
13. **A single recognition is on the scale of "one screenful of text"**: the text to translate is capped at 8000 characters (truncated by line above that and marked "text too long" on the card), and the region's edge length is capped at 4096 device pixels (scaled down proportionally above that). Recognizing a whole screen of text is no problem, but this is not meant for "a whole book".
14. **Only the primary screen's region is recognized (the same root as item 1)**: the frozen frame covers only the primary screen, so there is no cross-screen selection.
15. **Recognition and translation exist only in the independent panel (the scope of this round of t75)**: the in-DSH overlay (the fallback path in item 2) **does not have** these two buttons — it is the degraded channel for "no Edge/Chrome on the machine", and its image is still inside the DSH window. The main path on a real machine is the panel (Edge is installed as measured on this machine). To have them on the fallback path too, just say so; `lib/ocr.mjs` and the host's three routes are already one shared set for both sides, so wiring it up is mainly client work of adding two buttons and one card.

---

## Development and verification

```
cd E:\dshplugins\dsh-screenshot
npm test                                  # offline pure-logic unit tests (node --test)
node tests/overlay-e2e.mjs                # B1 end-to-end rerun (real host routes + real client orchestration, stand-in window)
node tests/overlay-browser-probe.mjs      # real-browser probe (headless Edge/Chrome + CDP: can the page get the frame canvas, can the heartbeat keep it alive)
node tests/ocr-browser-probe.mjs          # t75 end to end: real browser panel × real host × real Windows OCR (recognize→translate→copy)
node tests/negative-asset-order.mjs       # negative sample: put the static asset order back the way it was, to verify the gate really fails
npm run capture:probe                     # manually run the capture script once and print the JSON result
node --check index.js && node --check client.js   # syntax check for both halves
cd E:\dshplugins; node validate.mjs E:\dshplugins\dsh-screenshot   # deliverable contract self-check (A-1..A-6 / D-11 + X-1/X-2/X-3)
npm pack --dry-run                        # publish manifest (files whitelist: index/client/lib/overlay/locale/icon/patch/README)
```

The three in `npm test` related to t75 (34 cases in total):

- `tests/ocr.test.mjs`: the pure logic of `lib/ocr.mjs` — the language tag whitelist, script arguments, CJK line joining, result normalization, prompt delimiting, translation cleanup, truncation, error code mapping. 12 cases, fully offline.
- `tests/ocr-routes.test.mjs`: the contract of the three routes — the token gate/405/400, **real recognition** (hitting `tests/fixtures/ocr-sample.png`, running the real `Windows.Media.Ocr`), no leftover temporary files, a readable error for an uninstalled language, every failure code of translation, and **really writing the system clipboard and reading it back in another process to verify**. Machines without the OCR language pack installed automatically skip the real-recognition cases. 16 cases.
- `tests/ocr-panel.test.mjs`: the panel side's static contract — bypass requests must not broaden X-1's frozen action vocabulary, copying must go through the host (the browser clipboard API must not appear in the page source), results being invalidated by selection, the target language having only one definition, the order of `Esc`, plus negative samples. 6 cases.

The division of labor among the three scripts:

- `tests/overlay-e2e.mjs`: a stub capture script + a "panel window stand-in" (with a protocol identical to `overlay/overlay.js`: fetch frame → heartbeat → `POST {action, png}` → exit) attached to the **real host routes**, then driven by the **real client orchestration** cut out of `client.js`. Five scenarios: the full insert chain (the SHA256 of the result PNG must equal the bytes the panel submitted), cancel with no side effects, **panel static assets free of the token** (the css/js referenced by the page and the 5 lib modules are fetched one by one, while data routes must still 404), **mode pass-through** (with `-Through` on the capture script for through mode and without it for normal, and the page URL carrying `mode` in step), and an old host really returning 404 → visible hint + fallback.
- `tests/overlay-browser-probe.mjs`: a **real browser** (headless Edge/Chrome + DevTools protocol) loads the panel page served by the host, in four stages: ① read the page's `window.__overlayState`, the canvas's 2×2 four-color pixels (was the frame fetched, is the orientation right, is anything cropped), and the number of tool/action buttons; ② let the browser run for 8 s and confirm that `/overlay/status` is still `running` (the heartbeat window is 5 s, so if the page had not started it would long since be `aborted`); ③ create a selection so the toolbar appears, then click the tools one by one to verify **icon buttons have zero visible text**, mosaic→granularity appears, text→font size appears, move→both groups collapse, **the toolbar is exactly two rows and vertically offset**, and the output size is at the right of the first row, and use `Page.captureScreenshot` to keep a visual record (the working directory is kept when `DSH_KEEP=1`); ④ the hint line in normal mode (`mode=normal` must state that the image includes DSH, while `mode=through` must not have that sentence). Machines without a browser print `[SKIP]` and exit with 0.
- `tests/ocr-browser-probe.mjs`: **t75's end to end** (real browser panel × real host routes × real `Windows.Media.Ocr`, with only the model as a stand-in). The frozen frame is **composited by the script according to the viewport size** (white background + `tests/fixtures/ocr-sample.png` pasted as-is in the top-left corner) — so the frame and viewport are 1:1, exactly the situation of a real-machine full-screen kiosk; if the frame's aspect ratio does not match the viewport, the panel's single-ratio mapping squashes the selection (this was hit before, see the comments in the script). The assertions cover: recognizing the **complete text with no Chinese spaces**, the card landing inside the viewport, the model route used for translation, **changing the target language re-translating without re-recognizing** (exactly 2 model calls + only one "recognized text" log line on the host), the system clipboard read back in **another process matching character for character** after copying, pressing the pointer inside the card not moving the selection, the card collapsing automatically after the selection changes, a blank region reporting "no text found", and `Esc` closing the card first. Session progress is printed to `console` and also collected on the Node side through the CDP event channel, so **even if the page is closed you can locate which step it got stuck at**. Machines without a browser or without the OCR language pack installed print `[SKIP]` and exit with 0.
- `tests/negative-asset-order.mjs`: reverts the rule "the static asset branch comes before token validation" to its defective state, to confirm that `validate.mjs` X-1 and the e2e static asset scenario **both fail** (guarding against "whatever you write turns green").

Two points about the copy: the host card copy comes from `meta` in `locale/*.json` (the official DSH convention: read only `meta.title`/`meta.description`, with `en.json` as the language fallback); the UI copy's key set corresponds **one to one** with `TEXT` in `client.js` (the client renders the "Chinese / En" parallel labels directly, satisfying DoD B-1's 「截图 / Screenshot」), so when changing copy, change `client.js` and both locale files at the same time.

Directory structure:

```
dsh-screenshot/
├─ package.json          # type:module + exports + dsh.bundle.patch + dsh.client
├─ cordis.patch.yml      # inserts only its own single row
├─ index.js              # host half: apply(ctx, config) + capture route + overlay route family (session state machine / kiosk process management) + three bypass routes for recognition/translation/clipboard
├─ client.js             # client half: button + B1 orchestration (start→poll→fetch image→execute actions inside DSH) + the in-DSH overlay (fallback)
├─ overlay/              # independent full-screen panel page (runs in the system browser's kiosk window, importing the host's lib/*.mjs as pure logic)
├─ lib/                  # reusable pure logic (geometry/annotations/history/output/capture plan/recognition and translation) + four ASCII-only scripts:
│                        #   capture.ps1 (capture) · overlay-host.ps1 (browser/kiosk) · ocr.ps1 (Windows.Media.Ocr) · clipboard.ps1 (write the system clipboard)
├─ tests/                # offline unit tests + three rerun scripts (overlay-e2e / overlay-browser-probe / ocr-browser-probe) + negative-asset-order.mjs (negative-sample proof)
├─ locale/               # Plugin Manager card copy (meta) + bilingual UI copy corresponding one to one with client.js TEXT (ui)
├─ icon.svg              # plugin icon (≤256 KiB, no external references)
├─ README.md             # the Chinese README
└─ README.en.md          # the English README (this file)
```
