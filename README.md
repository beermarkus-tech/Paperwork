# Paperwork

A Progressive Web App for local PDF triage. See the full spec in the project notes; this repo currently implements through **Stage 4** of the development roadmap.

## Stage 1 — Foundational File System Access

Confirmed working on Android Chrome: `showDirectoryPicker()` opens the native folder picker and reads local files with no network round-trip.

- Serves a single page with a "Choose inbox folder…" button.
- On tap, calls `showDirectoryPicker()` and lists every `.pdf` file found directly inside the chosen folder.
- Registers a minimal service worker that caches the app shell for offline reload.
- Ships a web app manifest so it can be installed to the home screen.

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
- A small status indicator in the viewer toolbar spins while a save is pending or in flight, and shows a checkmark once written — it's a minimal placeholder for now (see note below) and will move once more toolbar buttons arrive.
- After a successful save, the thumbnail for that file is re-rendered and re-cached in the background, so the strip doesn't show a stale (unrotated) thumbnail after you rotate and back out.
- Known limitation: closing the app within the debounce window, before either trigger fires, loses that specific pending change — the same tradeoff most autosave systems make.

## Stage 4 — Folder Persistence, Rename & Filing

- On a successful folder pick, the `FileSystemDirectoryHandle` itself is stored in IndexedDB (`idb.js`) — handles are structured-cloneable and this is the documented pattern for persisting File System Access API access across page loads.
- On launch, if a handle is stored, the app calls `queryPermission()` on it (no user gesture needed for a *query*, only for a *request*): if permission is still `"granted"`, the folder loads automatically with no tap required. If Chrome has downgraded it back to `"prompt"` (typically after the browser fully restarts), the primary button changes to `Reconnect to "<folder>"…` — tapping it calls `requestPermission()`, which is allowed to show its native prompt because the tap itself is the required user gesture.
- A second, smaller "Choose a different folder…" button is always available once a folder has loaded, so switching to a different inbox never requires losing the persisted one first.

### Rename bar

A bar below the viewer stage, built and wired to a real on-disk rename together (same vertical-slice approach as rotation persistence):

- Text field pre-filled with the current filename (extension hidden while editing, re-appended on save); tapping into it selects the whole value so typing or a chip tap replaces it outright. Flanked by two icon buttons in the same style: a calendar button to its left, a checkmark ("Rename", confirm) button to its right.
- Calendar button opens a small custom calendar popup (`#date-modal`) — a hand-built month grid with its own prev/next-month navigation and Cancel/OK, not the native `<input type="date">` picker. That's deliberate: Android Chrome's native date picker only reports a value when the user taps a specific day in its grid, so confirming the shown default/current selection without touching anything fires no event at all and would make a plain OK tap silently do nothing. Owning the grid ourselves means whatever day is highlighted — defaulted to the filename's existing date prefix, or today otherwise — is exactly what OK applies, replacing an existing date prefix rather than stacking another one in front of it; Cancel or tapping the backdrop discards the pick with no effect on the filename.
- Template chips append a word to the filename with one tap. The set is a fixed default for now (`Invoice`, `Receipt`, `Statement`, `Contract`, `Insurance`, `Medical`, `Tax`) — making these user-editable is deferred to the destination-folder settings screen, the next Stage 4 slice.
- The checkmark button commits the rename immediately via `FileSystemFileHandle.move()` (`file-ops.js`), with a copy-then-delete fallback both for browsers without it and for platforms where it's present but throws at call time (seen on Android Chrome — likely a Storage Access Framework provider that doesn't support atomic rename). Blocks on an empty name, characters illegal in filenames (`\ / : * ? " < > |`), or a name collision with another file already in the folder — those cases show an error message next to the button rather than touching its icon.
- The checkmark button itself is the progress/success indicator (mirroring the rotation-save spinner/checkmark pattern): it swaps to a spinner while the move is in flight, then turns green once it succeeds, and stays green until you switch to a different document (or page-flip back to this one later), at which point it resets to its normal white checkmark.
- On success, updates everything keyed by the old filename in place: the in-session rotation map, the cached thumbnail (re-keyed without a wasted re-render, since the file content didn't change), and the thumbnail strip's caption. (The viewer toolbar itself just shows "Page X of Y" — no filename — so there's nothing there to update.)
- Known simplification: the thumbnail strip doesn't re-sort after a rename within the same session (it re-sorts fresh on the next folder scan) — re-sorting live would mean relocating DOM nodes and remapping indices used for document-to-document swipe navigation, and didn't seem worth the complexity yet.

### Destination folders & tap-to-file

- A "Destinations…" link appears on the setup screen once a folder is loaded. It opens a small screen (`#destinations-screen`) for managing a personal list of subfolder names — each one is created inside the current inbox folder (`getDirectoryHandle(name, { create: true })`) the moment you add it, and re-created if missing every time a folder loads (`ensureDestinationFoldersExist`), so switching to a different inbox folder gets the same set of category folders too. Removing a destination from the list only stops offering it as a filing target — it does not delete the folder or anything already filed into it.
- Each destination appears as a button in a row below the rename bar (`#destination-bar`) whenever a document is open. Tapping one takes whatever filename is currently showing — untouched is fine, there's no requirement to have edited it or pressed the rename checkmark first — and moves the file straight into that subfolder under that name, in one motion, via a generalized `moveFileHandle()` (`file-ops.js`) that handles both same-directory renames and cross-directory moves through the same `FileSystemFileHandle.move()`-with-copy+delete-fallback logic as the rename bar. Blocked the same way rename is on an empty name, illegal characters, or a name collision — this time checked against the destination folder rather than the current one.
- After a successful move, that file disappears from the current session's document stack and thumbnail strip immediately (no folder rescan needed), and the viewer auto-advances to what's now at the same position — letting a stack of scans be filed one after another as: adjust name → tap destination → repeat.
- A brief "Filed to…" toast with an **Undo** button appears at the bottom for 5 seconds after each move. Undo moves the file straight back to its original name and folder; if the viewer is still open it closes back to the (freshly rescanned) thumbnail grid, since the viewer's in-session document list doesn't attempt to splice the restored file back into its old position live.

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
6. Close the tab (or fully quit/reopen the installed app) and relaunch: the folder should either load automatically or show a "Reconnect to…" button — it shouldn't silently fall back to the empty "Choose inbox folder…" state while a folder is still stored.
7. Tap "Choose a different folder…" and confirm you can switch to a different folder without anything getting stuck.
8. Rotate a page a couple of times, then either wait ~2.5s or swipe away — the status indicator should spin, then show a checkmark. Reopen that same document later (or fully reload the app) and confirm the rotation actually stuck, and that the thumbnail strip reflects the new orientation too.
9. In the rename bar, tap the calendar button and pick a date, tap a couple of template chips, edit the text, then tap **Rename**. Confirm the thumbnail strip's caption updates, back out and reopen the document to confirm the filename actually changed on disk, and check the actual file in your device's file manager if you want to be extra sure. Also try renaming to a name that already exists in the folder — it should refuse with a message rather than silently overwriting the other file.
10. On the setup screen, tap "Destinations…" and add a couple of subfolder names; confirm they actually appear as real folders in your inbox via a file manager. Open a document, confirm the same names now show as buttons below the rename bar, and tap one — the document should disappear from the grid, the viewer should move to the next one, and the file should now be sitting in that subfolder under the name that was showing. Tap **Undo** on the toast that appears and confirm it lands back in the inbox with its original name. Also try filing to a destination that already has a same-named file in it — it should refuse rather than overwrite.

If you've already installed Paperwork to your home screen from an earlier stage and an update doesn't seem to take effect, the installed app (a WebAPK) can get stuck on stale cached files. Uninstalling and reinstalling via "Add to Home screen" is the most reliable fix — more reliable than in-place "Clear cache"/"Clear storage" from Android's App Info screen, which has been inconsistent in testing.

If `showDirectoryPicker` is unsupported, the page disables the button and shows an explicit message instead of failing silently.

## Icons

`icons/*.png` are placeholder icons generated by `scripts/gen_icons.py` (pure Python, no dependencies). Replace them with real artwork whenever.

## Vendored dependencies

`vendor/pdfjs/` contains the minified PDF.js browser build (`pdf.min.js` + `pdf.worker.min.js`), vendored rather than CDN-loaded so the app keeps working fully offline once installed. See `vendor/pdfjs/LICENSE` (Apache-2.0). Named `.js` rather than pdf.js's usual `.mjs` to avoid depending on the host correctly mapping that extension to a JavaScript MIME type — module-ness comes from how a script is loaded (`type="module"`, `import`, worker `{type:"module"}`), not the file extension, so this rename is purely defensive.

`vendor/pdf-lib/` contains the minified ESM build of [pdf-lib](https://pdf-lib.js.org/) (`pdf-lib.esm.min.js`), used for actually rewriting page rotation into a PDF file. See `vendor/pdf-lib/LICENSE.md` (MIT).
