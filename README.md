# Paperwork

A Progressive Web App for local PDF triage. See the full spec in the project notes; this repo currently implements through **Stage 6** of the development roadmap, plus the error-handling/edge-case portion of **Stage 7** (batch operations beyond split/join are deferred).

## Stage 1 — Foundational File System Access

Confirmed working on Android Chrome: `showDirectoryPicker()` opens the native folder picker and reads local files with no network round-trip.

- Serves a single page with a "Choose inbox folder…" button.
- On tap, calls `showDirectoryPicker()` and lists every `.pdf` file found directly inside the chosen folder.
- Registers a minimal service worker that caches the app shell for offline reload.
- Ships a web app manifest so it can be installed to the home screen.
- `overscroll-behavior: none` on `html`/`body` (`app.css`) disables Android Chrome's pull-to-refresh — a stray pull-down gesture reloading the whole app and losing viewer state would be far more disruptive here than on a typical page.

## Stage 2 — Thumbnail Generation & Strip UI

- Integrates [PDF.js](https://mozilla.github.io/pdf.js/) (vendored under `vendor/pdfjs/`, Apache-2.0) to render each PDF's first page to a canvas and produce a JPEG thumbnail.
- Renders thumbnails into a horizontally scrollable strip (`#thumbnail-strip`), one item per PDF, with filename and size as caption.
- Caches thumbnails in IndexedDB (`idb.js`), keyed by folder name + filename. A cached entry is reused only if the file's size and `lastModified` still match — anything new or edited gets re-rendered.
- Shows a progress bar while thumbnails are being generated (cache hits are instant; only misses call into PDF.js).
- Tapping a thumbnail opens it in the Stage 3 full-page viewer.

## Stage 3 — Main Viewer

- Tapping a thumbnail opens a fullscreen viewer (`#viewer`) rendering the current page at high resolution (`pdf-viewer.js`), scaled for the device's pixel ratio.
- **Horizontal swipe**: next/previous page within the open document.
- **Vertical swipe**: next/previous document, in the same order as the thumbnail strip.
- **Pinch**: zoom 1x–5x; while zoomed, a single finger pans instead of swiping to navigate.
- **Rotate button**: rotates the current page 90° per tap and saves it back to the actual file (see below) — not just a view-time transform.
- Swipes and rotation are handled with raw Pointer Events (no gesture library), since this stays a plain HTML/CSS/JS app with no build step.
- Navigating to a different page or document resets zoom/pan; switching documents reloads the PDF (freeing the previous one) but stays on the same page-navigation session while flicking through one document's pages.
- Faint chevron indicators fade in on whichever edge(s) have a page to swipe to, and disappear at the start/end of a document, so a swipe that does nothing doesn't feel like it silently failed.

Rotation state persists in memory for the current session even after navigating away from a document and back — it's keyed by filename, not wiped every time a document is reopened. The first time a page is displayed, its starting rotation is read from the file itself (via PDF.js's `page.rotate`) rather than always assuming 0, so a file already rotated from a previous session opens correctly oriented.

### Rotation persistence (a Stage 5 feature, pulled forward)

Full page-editing (split, join, delete, undo) is Stage 5, but rotation-saving was built now as an early vertical slice — UI and its real file write together, rather than mocking the interaction first — since it's small and self-contained.

- Uses [pdf-lib](https://pdf-lib.js.org/) (vendored under `vendor/pdf-lib/`, MIT) to actually set the page's `/Rotate` value and write the file back out.
- **Debounced + flush-on-navigate**: each rotate tap resets a ~2.5s timer; if you swipe to a different page/document or close the viewer before it fires, the pending rotation saves immediately instead of waiting. Rapid repeated taps only trigger one write, not one per tap.
- The rotate button itself is the save-progress indicator (same pattern the rename checkmark button uses): it spins in place while a save is pending or in flight, then tints green once written, until you navigate away.
- After a successful save, the thumbnail for that file is re-rendered and re-cached in the background, so the strip doesn't show a stale (unrotated) thumbnail after you rotate and back out.
- Known limitation: closing the app within the debounce window, before either trigger fires, loses that specific pending change — the same tradeoff most autosave systems make.

## Stage 4 — Folder Persistence, Rename & Filing

- On a successful folder pick, the `FileSystemDirectoryHandle` itself is stored in IndexedDB (`idb.js`) — handles are structured-cloneable and this is the documented pattern for persisting File System Access API access across page loads.
- On launch, if a handle is stored, the app calls `queryPermission()` on it (no user gesture needed for a *query*, only for a *request*): if permission is still `"granted"`, the folder loads automatically with no tap required. If Chrome has downgraded it back to `"prompt"` (typically after the browser fully restarts), the primary button changes to `Reconnect to "<folder>"…` — tapping it calls `requestPermission()`, which is allowed to show its native prompt because the tap itself is the required user gesture. The button text alone carries that state now; there's no separate status-line message repeating it.
- That primary button (`#pick-folder-btn`) only has a job before a folder is connected: it's the first thing on screen on a fresh load or while a stored folder needs reconfirming, and disappears entirely the moment a folder finishes loading. It reappears if a reconnect attempt gets denied.
- From then on, a small folder icon pinned to the top-right of the header (`#change-folder-btn`) is the only way to switch to a different folder — it always opens the picker directly, with no reconnect logic of its own. The header is `position: sticky`, so that icon (and, once a folder with PDFs is loaded, the split/join icons beside it — see Stage 6) stays reachable while scrolling a long thumbnail grid.

### Rename bar

A bar below the viewer stage, built and wired to a real on-disk rename together (same vertical-slice approach as rotation persistence):

- Text field pre-filled with the current filename (extension hidden while editing, re-appended on save); tapping into it selects the whole value so typing or a chip tap replaces it outright. Flanked by two icon buttons in the same style: a calendar button to its left, a checkmark ("Rename", confirm) button to its right.
- While the on-screen keyboard is actually up, `#viewer-toolbar` (close/rotate/page-indicator) and `#viewer-stage` — the PDF preview, along with the delete-page button and undo toast that live inside it — are both hidden entirely (`#viewer.keyboard-open`), rather than being squeezed into a sliver above the keyboard; the chip labels swap in to take that freed space instead (destination buttons stay visible either way). Detected via the `VisualViewport` `resize` event (comparing its height against `window.innerHeight`) rather than focus/blur on the filename field: dismissing the keyboard via the system back gesture or the keyboard's own close control doesn't reliably blur the input on Android, which left the preview stuck hidden when it was blur-driven. Comparing actual viewport height reflects the keyboard's real on-screen state regardless of how it closes.
- Calendar button opens a small custom calendar popup (`#date-modal`) — a hand-built month grid with its own prev/next-month navigation and Cancel/OK, not the native `<input type="date">` picker. That's deliberate: Android Chrome's native date picker only reports a value when the user taps a specific day in its grid, so confirming the shown default/current selection without touching anything fires no event at all and would make a plain OK tap silently do nothing. Owning the grid ourselves means whatever day is highlighted — defaulted to the filename's existing date prefix, or today otherwise — is exactly what OK applies, replacing an existing date prefix rather than stacking another one in front of it (e.g. picking a date on `2026-08-10 Tax Statement` gives `2026-08-11 Tax Statement`, not two dates); Cancel or tapping the backdrop discards the pick with no effect on the filename. The date and the rest of the name are always joined with a single space, never a dash — the prefix match itself is loose about the separator (any whitespace, an optional single dash, any whitespace) so it still recognizes a dash-separated prefix from an older version or manual editing and replaces it in the same plain-space style.
- Template chips append a word to the filename with one tap. The set (defaults to `Invoice`, `Receipt`, `Statement`, `Contract`, `Insurance`, `Medical`, `Tax`) is fully user-editable: a pencil button next to the chip row opens a small screen (`#chips-screen`) for adding or removing labels, persisted in IndexedDB (`idb.js`) and shared across all folders — this is plain text, not tied to the filesystem, so unlike destinations there's nothing to create on disk.
- The checkmark button commits the rename immediately via `FileSystemFileHandle.move()` (`file-ops.js`), with a copy-then-delete fallback both for browsers without it and for platforms where it's present but throws at call time (seen on Android Chrome — likely a Storage Access Framework provider that doesn't support atomic rename). Blocks on an empty name, characters illegal in filenames (`\ / : * ? " < > |`), or a name collision with another file already in the folder — those cases show an error message next to the button rather than touching its icon.
- The checkmark button itself is the progress/success indicator (mirroring the rotation-save spinner/checkmark pattern): it swaps to a spinner while the move is in flight, then turns green once it succeeds, and stays green until you switch to a different document (or page-flip back to this one later), at which point it resets to its normal white checkmark.
- On success, updates everything keyed by the old filename in place: the in-session rotation map, the cached thumbnail (re-keyed without a wasted re-render, since the file content didn't change), and the thumbnail strip's caption. (The viewer toolbar itself just shows "Page X of Y" — no filename — so there's nothing there to update.)
- Known simplification: the thumbnail strip doesn't re-sort after a rename within the same session (it re-sorts fresh on the next folder scan) — re-sorting live would mean relocating DOM nodes and remapping indices used for document-to-document swipe navigation, and didn't seem worth the complexity yet.

### Destination folders & tap-to-file

- Each destination appears as a button in a row below the rename bar (`#destination-bar`) whenever a document is open, with a pencil button (`#edit-destinations-btn`, same style as the chip labels' pencil) at the end of that row. Tapping it opens a small screen (`#destinations-screen`) for managing the personal list of subfolder names — each one is created inside the current inbox folder (`getDirectoryHandle(name, { create: true })`) the moment you add it, and re-created if missing every time a folder loads, so switching to a different inbox folder gets the same set of category folders too. Removing a destination from the list only stops offering it as a filing target — it does not delete the folder or anything already filed into it. Living in the viewer rather than the setup screen means it's only ever reachable with a folder already open, so there's no separate "no folder yet" state to guard against.
- The sync runs both directions (`syncDestinationsWithFolder`): any subfolder already sitting inside the inbox — created by hand in a file manager, or left over from before this feature existed — is imported into the destinations list and shows up as a button automatically the moment that folder is opened, no manual re-adding needed.
- Tapping a destination button takes whatever filename is currently showing — untouched is fine, there's no requirement to have edited it or pressed the rename checkmark first — and moves the file straight into that subfolder under that name, in one motion, via a generalized `moveFileHandle()` (`file-ops.js`) that handles both same-directory renames and cross-directory moves through the same `FileSystemFileHandle.move()`-with-copy+delete-fallback logic as the rename bar. Blocked the same way rename is on an empty name, illegal characters, or a name collision — this time checked against the destination folder rather than the current one.
- After a successful move, that file disappears from the current session's document stack and thumbnail strip immediately (no folder rescan needed), and the viewer auto-advances to what's now at the same position — letting a stack of scans be filed one after another as: adjust name → tap destination → repeat.
- A brief "Filed to…" toast with an **Undo** button appears for 5 seconds after each move (see the shared undo mechanism under Stage 5 below). Undo moves the file straight back to its original name and folder; if the viewer is still open it closes back to the (freshly rescanned) thumbnail grid, since the viewer's in-session document list doesn't attempt to splice the restored file back into its old position live.

## Stage 5 — Page Editing & Undo

### Page deletion

A trash icon floats over the top-right of the page, inside `#viewer-stage` (so it sits over the PDF rather than taking toolbar space), grouped in `#page-toolbar` next to the rotate button — moved there from the top toolbar so both controls visibly belong to the page they act on rather than a separate global bar:

- **Armed, two-tap delete**: the first tap turns the icon red and pulsing (`.armed`) instead of deleting immediately; a second tap on the *same page* within 3 seconds confirms and actually deletes it. Any navigation — a different page, a different document, closing the viewer — disarms it immediately, so a later unrelated tap can never land as an accidental confirm, and it also auto-disarms after 3 seconds of no second tap.
- Deleting removes the page via [pdf-lib](https://pdf-lib.js.org/) (`pdf-pages.js`) and writes the file back, the same real-file-write-first approach used throughout. If it was the document's only remaining page, the whole file is deleted instead (`dirHandle.removeEntry`) and the viewer advances to the next document — a zero-page PDF isn't a meaningful thing to leave behind.
- Rotation state (kept in memory, keyed by page number) is renumbered on a normal page delete: entries for pages after the deleted one shift down by one, and the deleted page's own entry is dropped. The document reloads in place afterward so the page count and current page both reflect the edit immediately, landing on whatever page is now at the same number (clamped to the new last page if the deleted page was also the last one).

### Undo

A single "last action, one step back" mechanism (`createToast` in `app.js`, a small factory rather than one-off toast code) backs filing, page/document deletion, and — see Stage 6 below — split and join, rather than each action having its own bespoke undo:

- Each undoable action supplies its own restore closure when it shows a toast, so the toast itself doesn't need to know what kind of action it's undoing — filing hands it a closure that moves the file back; page deletion hands it one that rewrites the file's original bytes (captured as a full backup immediately before the destructive write) and reloads the page if it's still open; whole-document deletion hands it one that recreates the file and rescans the folder.
- Two toast instances exist, one per screen, since they're never both visible at once: `viewerToast` lives inside `#viewer-stage` (bottom-center, overlaying the PDF, positioned there rather than fixed to the viewport so it never blocks the destination buttons during its 5-second window) and backs viewer-scoped actions; `gridToast` is fixed to the viewport and backs split/join on the thumbnail grid, which the viewer's toast can't reach since it's hidden whenever the grid is showing.
- Performing a second undoable action on the same toast while it's still showing replaces the pending undo — there's no history to step back through, just the one most recent action per screen.

## Stage 6 — Split & Join

Both live as two icon buttons in the header (`#split-btn`, `#join-btn`), to the right of the folder icon (see Stage 4) — hidden until the current folder has at least one PDF, then shown in the order folder / split / join. Each is an armed two-tap toggle mirroring the trash icon's pattern: first tap arms selection mode (icon swaps to a checkmark, red background), tapping thumbnails selects them instead of opening the viewer, second tap on the button confirms whatever's selected. Confirming with nothing selected just exits selection mode rather than erroring. The two modes are mutually exclusive — the other button disables itself while one is armed.

### Split

- Tap a PDF to select it (only one at a time — tapping a different one moves the selection rather than adding to it), then tap the split button again to confirm.
- Splitting a single-page PDF is rejected with a brief info toast (no Undo button, since nothing happened) — but only at confirm time, not the moment you select it, so selecting one doesn't accuse you of a mistake before you've actually tried anything.
- Each page becomes its own file, `<name> <NN>.pdf`, zero-padded to the page count's digit width (`Invoice 01.pdf` … `Invoice 12.pdf`) so the thumbnail grid's alphabetical sort keeps them in page order — unpadded numbers would put `Invoice 10.pdf` before `Invoice 2.pdf`. If any target name already exists in the folder, the whole split is refused up front rather than partially completing.
- Implemented as `splitPdfIntoPages` (`pdf-pages.js`): one page per output PDF via pdf-lib's `copyPages`, which carries that page's own already-persisted rotation along with it — nothing extra to handle there. The original file is only removed after every page file has been written successfully; if a write fails partway through, the pages already written are cleaned back up and the original is left untouched.

### Join

- Tap PDFs in the order you want them joined — each gets a numbered badge (1, 2, 3…) showing that order; tapping an already-selected one again deselects it and renumbers the rest to stay contiguous. Tap the join button again (with at least 2 selected) to confirm.
- The joined file is named after the first-tapped PDF plus a `joined` suffix (`Invoice joined.pdf`), refused up front the same way as split if that name already exists.
- Implemented as `joinPdfFiles` (`pdf-pages.js`): a fresh `PDFDocument` that copies every page, in order, from each source file in turn — rotations again carry over for free. The joined file is written and verified before any of the originals are removed.

### Shared with page deletion

- Both reuse `gridToast` for a 5-second "Undo" after a successful split or join: undoing a split deletes the new page files and restores the original from a full backup of its bytes taken before the split ran; undoing a join deletes the joined file and recreates every original the same way. Both then rescan the folder (`loadFolder`) rather than trying to splice the grid back to its exact prior state — the same simplification the filing and page-deletion undo already make.

## Stage 7 — Error Handling & Edge Cases (in progress)

The batch-mode-beyond-split/join portion of this stage is deferred; what's landed so far is a pass over places where an error either crashed the scan/viewer outright or failed silently:

- **A single unreadable PDF no longer takes down the whole folder scan.** `collectPdfEntries` used to call `getFile()` on every match with no per-file try/catch, so one file a Storage Access Framework provider couldn't read (permission hiccup, removed mid-scan) aborted the entire listing — nothing loaded, not even the PDFs that were fine. It now skips just that file and keeps going; if anything was skipped, the status line says how many.
- **Viewer-scoped errors were being written to an element the viewer hides.** Rotation-save failures, page-delete failures, and viewer-side undo failures all set `#status`'s text — but `#status` lives in the setup section, and the viewer is a full-screen overlay (`position: fixed; inset: 0`) sitting on top of it. All three states are only reachable with the viewer open, so the error was always invisible. They now write to `#rename-status` instead, the element viewer errors (rename, filing) already used correctly, since it stays visible in every viewer state including while the keyboard is up.
- **A failed swipe no longer leaves the page frozen mid-animation with no explanation.** Page/document swipe navigation fades the canvas out, runs the navigation, then fades it back in; if the navigation step itself failed (a corrupt neighboring page or document, a transient render error), the canvas was left faded out and translated off-screen indefinitely, since the code that fades it back in never ran. It now resets the canvas back to visible on any navigation failure and shows the error.
- **A document that fails to open no longer leaves a stale, different document's page on screen next to the error.** Opening a document (from the grid, or automatically after filing/deleting one) already showed an error message on failure, but the canvas itself kept whatever was last rendered — which could be a completely different document from earlier in the session. The canvas is now cleared alongside the error.
- **Auto-advancing to the next document after filing or deleting one used to fail silently** (console-only) if that next document couldn't be opened, leaving the UI stuck on "Loading…" with nothing telling the user why. It now shows the same visible error as opening a document normally does.
- **Opening the IndexedDB database could hang forever** if another open tab running an older schema version blocked the upgrade — there was no `onblocked` handler, so every thumbnail-cache or settings read/write waiting on it would just never resolve. It now rejects with a clear message instead, so it fails the same way any other IndexedDB error already does rather than hanging.

## Running locally

No build step. Serve the directory over HTTP(S) (the File System Access API and service workers require a secure context — `http://localhost` counts):

```sh
python3 -m http.server 8000
```

Then open `http://localhost:8000/`.

## Deploying

A GitHub Actions workflow (`.github/workflows/deploy.yml`) deploys this repo's contents to GitHub Pages on every push to `main`.

**One-time manual step**: in the repo's Settings → Pages, set **Source** to **GitHub Actions**. After that, pushes to `main` deploy automatically.

The setup screen's subtitle shows a version number (`APP_VERSION` in `app.js`), bumped by one alongside `sw.js`'s `CACHE_NAME` on every deploy, so it's always obvious which build is currently loaded.

## Testing on Android

1. Push to `main` (or merge into it) and wait for the Pages deployment to finish.
2. Open the deployed URL in Chrome on Android.
3. Tap "Choose inbox folder…" and confirm the folder picker, file listing, and thumbnails all work.
4. Pick the same folder again and confirm thumbnails appear instantly (cache hit) instead of re-rendering.
5. Tap a thumbnail and confirm the fullscreen viewer opens; try horizontal swipe (pages), vertical swipe (documents), pinch-zoom, and the rotate button.
6. Close the tab (or fully quit/reopen the installed app) and relaunch: the folder should either load automatically (large button stays hidden) or show a "Reconnect to…" button — it shouldn't silently fall back to the empty "Choose inbox folder…" state while a folder is still stored.
7. With a folder loaded, confirm the large "Choose inbox folder…" button is gone. Scroll the thumbnail grid and confirm the header — with its folder/split/join icons — stays pinned to the top. Tap the folder icon in the top-right and confirm you can switch to a different folder without anything getting stuck.
8. Rotate a page a couple of times, then either wait ~2.5s or swipe away — the rotate button itself should spin in place, then briefly tint green. Reopen that same document later (or fully reload the app) and confirm the rotation actually stuck, and that the thumbnail strip reflects the new orientation too.
9. In the rename bar, tap the calendar button and pick a date, tap a couple of template chips, edit the text, then tap **Rename**. Confirm the thumbnail strip's caption updates, back out and reopen the document to confirm the filename actually changed on disk, and check the actual file in your device's file manager if you want to be extra sure. Also try renaming to a name that already exists in the folder — it should refuse with a message rather than silently overwriting the other file.
10. Open a document, tap the pencil button at the end of the destination row, and add a couple of subfolder names; confirm they actually appear as real folders in your inbox via a file manager. Confirm the same names now show as buttons below the rename bar, and tap one — the document should disappear from the grid, the viewer should move to the next one, and the file should now be sitting in that subfolder under the name that was showing. Tap **Undo** on the toast that appears and confirm it lands back in the inbox with its original name. Also try filing to a destination that already has a same-named file in it — it should refuse rather than overwrite.
11. In the rename bar, tap the pencil button next to the template chips and add or remove a label or two; confirm the chip row updates immediately and the change survives a full app reload. Pick a date via the calendar button on a filename with no other text — confirm it inserts as just the date, with no trailing dash — then pick a date on a filename that already has text, and confirm the two are joined with a plain space (`2026-08-10 Tax Statement`), not a dash.
12. Using a file manager (outside Paperwork), create a subfolder inside your inbox that Paperwork has never seen — then open that folder in Paperwork. Open a document and confirm the new subfolder shows up automatically both as a button below the rename bar and in the destinations screen's list (via the pencil button), with no manual adding required.
13. Open a multi-page document and tap the trash icon once — it should turn red/pulsing without deleting anything. Wait 3+ seconds without tapping again and confirm it reverts on its own; then tap once, swipe to a different page, and confirm it's back to the plain icon (not still armed). Finally tap once and tap again to confirm — the page should actually be gone, the page count should drop by one, and an "Undo" toast should appear over the PDF, above the rename bar. Tap **Undo** and confirm the page comes back exactly as it was (including its rotation, if you'd rotated it). Then open a single-page document, delete its only page, and confirm the whole file disappears from the grid rather than leaving an empty document behind — Undo should bring the file back too.
14. Open a document. Confirm the chip labels are not visible while the PDF preview is showing, and that the toolbar (close/page-indicator), the floating rotate/trash pair over the page, and the destination buttons are all visible. Tap into the filename field to bring up the keyboard — confirm the toolbar and PDF preview (rotate/trash included, since they float over it) both disappear entirely, the chip labels appear, and the filename field/destination buttons shift up into the freed space. Dismiss the keyboard three different ways — tap the checkmark, tap a destination button, and use the phone's back gesture/button — and confirm the toolbar and preview reliably come back and the chips disappear again every time, including via the back gesture (that's the one that used to get stuck).
15. On the thumbnail grid, tap the scissors button in the header — it should turn into a checkmark. Tap a single-page PDF, then tap the checkmark: confirm you get a quick "only has one page" toast rather than anything actually happening, and that you're still in split mode afterward. Now tap a multi-page PDF and confirm it, and check the folder in a file manager: the original should be gone, replaced by zero-padded numbered files (`Name 01.pdf`, `Name 02.pdf`, …) that sort correctly. Tap **Undo** on the toast and confirm the original comes back and the split files are gone. Then tap the link button, tap three PDFs in a specific order (watch for the 1/2/3 badges — tap one again and confirm it deselects and the remaining badges renumber), and confirm: the joined file appears named after the first one you tapped plus "joined", the three originals are gone, and page order in the result matches your tap order. Tap **Undo** and confirm all three originals reappear and the joined file is gone.
16. On the thumbnail grid, pull down from the very top of the screen (as if to pull-to-refresh) — confirm nothing happens: no refresh icon, no page reload, no loss of the loaded folder/thumbnails. Also relaunch after Chrome has downgraded stored permission back to `"prompt"` (or just force-stop and reopen after a while) and confirm the primary button reads `Reconnect to "<folder>"…` with no separate "Tap to reconfirm…" line underneath it.

If you've already installed Paperwork to your home screen from an earlier stage and an update doesn't seem to take effect, the installed app (a WebAPK) can get stuck on stale cached files. Uninstalling and reinstalling via "Add to Home screen" is the most reliable fix — more reliable than in-place "Clear cache"/"Clear storage" from Android's App Info screen, which has been inconsistent in testing.

If `showDirectoryPicker` is unsupported, the page disables the button and shows an explicit message instead of failing silently.

## Icons

`icons/*.png` are generated by `scripts/gen_icons.py` (Pillow) — two overlapping dog-eared pages in the app's navy/paper palette, reading as "documents to triage" at everything from a 512px install prompt down to a browser-tab favicon. `icon-maskable-512.png` shrinks the same glyph toward the center (`content_scale=0.72`) so it survives whatever shape an OS crops adaptive icons into (circle, squircle, …) without clipping. Re-run the script after any tweak: `python3 scripts/gen_icons.py`.

## Vendored dependencies

`vendor/pdfjs/` contains the minified PDF.js browser build (`pdf.min.js` + `pdf.worker.min.js`), vendored rather than CDN-loaded so the app keeps working fully offline once installed. See `vendor/pdfjs/LICENSE` (Apache-2.0). Named `.js` rather than pdf.js's usual `.mjs` to avoid depending on the host correctly mapping that extension to a JavaScript MIME type — module-ness comes from how a script is loaded (`type="module"`, `import`, worker `{type:"module"}`), not the file extension, so this rename is purely defensive.

`vendor/pdf-lib/` contains the minified ESM build of [pdf-lib](https://pdf-lib.js.org/) (`pdf-lib.esm.min.js`), used for actually rewriting page rotation into a PDF file. See `vendor/pdf-lib/LICENSE.md` (MIT).
