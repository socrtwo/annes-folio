# Architecture (as built)

```
src/
  main.ts            entry: fonts, commands, App, Shell, launch files, drafts, service worker
  app.ts             App (prefs, tabs, exec, keys, autosave) and DocTab (engine document + bytes, undo snapshots)
  prefs.ts           preferences (localStorage key quillfolio.prefs.v1), Quick Access Bar choices
  csp.ts             Content-Security-Policy inserted at startup on the web and Capacitor builds
  commands/          one module per tab; registry.ts is the command registry; util.ts shared helpers
    file.ts edit.ts nav.ts home.ts view.ts comment.ts forms.ts protect.ts sign.ts organize.ts
    scan.ts review.ts tools.ts ai.ts dev.ts help.ts
    ocrlayer.ts      the recognized-text layer (placement, Unicode font, corrections) and scan image math
  pdf/               the engine (document of record)
    objects.ts       Name, Ref, PdfString (PDFDocEncoding/UTF-16), Dict, PdfStream, dates, helpers
    lexer.ts         tokens, object parser, streams with /Length recovery
    filters.ts       Flate (own inflate with damage tolerance; deflate with dynamic, fixed or stored blocks), LZW, ASCIIHex,
                     ASCII85, RunLength, PNG and TIFF predictors at every bit depth
    hash.ts          MD5, SHA-256/384/512, RC4, table-driven AES (pure JS, synchronous, no BigInt)
    crypt.ts         standard security handler: RC4 40/128, AES-128, AES-256 (R2–R6); AES-256 creation
    xref.ts          tables, xref streams, /Prev chains, free entries, hybrid files, object streams; reconstruction by
                     scanning in three passes (objects, security, object streams)
    document.ts      PdfDocument: load/create, resolve, overlay of changed objects, page tree, content, save
    writer.ts        serialization, full rewrite (renumber, object streams, encrypt), incremental update; raises the
                     header version to what the file uses
    content.ts       content-stream parser/serializer, matrices, fonts and encodings, text runs and image boxes
    stdfonts.ts      metrics of the standard 14 fonts, WinAnsi, wrapping
    build.ts         blank, text and image pages; fonts, XObjects, ExtGStates in resources
    structure.ts     outlines, page labels, attachments, layers, metadata/XMP, annotations, fields, signatures
    ops/pages.ts     reorder, delete, move, rotate, duplicate, insert, boxes, crop, scale, import/extract/split,
                     overlays (headers, Bates, watermark, background, image), N-up, booklet
    ops/annots.ts    annotations with generated appearance streams, replies, flatten, redaction, XFDF
    ops/redact.ts    content redaction (glyphs, images, vector paths, Form XObjects), hidden-layer removal
    ops/shared.ts    helpers shared by the operations (page-private resources, field and destination clean-up)
    ops/forms.ts     field values and appearances, add/delete/props, orders, flatten, XFDF/FDF/CSV/JSON, detection
    ops/textedit.ts  text runs, replace in place or overlay, erase, insert text and images, move/delete images
    ops/optimize.ts  images, fonts, statistics, hidden information, sanitize, archival and accessibility checks
    ops/extract.ts   positioned text, lines, Markdown, tables, image extraction
    repair/index.ts  the repair pipeline and report (see REPAIR.md)
  view/
    pdfjs.ts         pdf.js (legacy build, bundled worker, CMaps/fonts/wasm copied to public/pdfjs)
    viewer.ts        the TabView: pages, text layer, overlay, tools and gestures, search, thumbnails, grid
    viewutil.ts      pure helpers for the viewer: rotation, zoom steps, bitmap budget, page search, reload coalescing
  io/                formats table, sniffing, openAsPdf (PDF, images, text, ZIP, review packages), TIFF decoder
    recover/         file identification, ZIP salvage, ImmortalInflate (shared with the suite)
  ui/                shell, ribbon layout, backstage, panes, dialogs, customize, recovery report, wizards
  ai/                providers, client, ensemble, local model (local.ts and its worker, local.worker.ts), OAuth, store; folio.ts holds the prompts
  proof/             spelling worker and dictionaries; proofing.ts walks annotation and field text
  platform/          Capacitor/Electron bridge: open, save, write back, print, share, launch files
  templates/         new-document templates built in code
  export/print.ts    printing through rendered pages
electron/            desktop main and preload (app:// origin, file grants, permission and content policy)
android/, ios/       Capacitor projects (native plugin for files, print, share on Android)
scripts/             catalog generation, icons, notices, pdf.js and tesseract asset copying, desktop packaging,
                     the service worker's precache list (gen-sw-precache.mjs, run after every build)
tests/unit           engine, operations, repair, registry/catalog tests (vitest)
tests/e2e/smoke.mjs  Playwright smoke test against the build
```

## Document of record and rendering

A tab holds a `PdfDocument` (the engine's object graph) and `bytes`, the PDF the viewer renders. After every edit the tab regenerates `bytes` with an incremental update and pdf.js reloads it. Two cases rewrite the whole file instead: the save preference "rewrite" (not for an encrypted document, whose edits are always appended as an incremental update), and any edit after a command that removed content (applying redactions, sanitizing), so that the removed bytes do not stay in the file. pdf.js never writes; it only rasterizes and extracts text. Saving writes the same bytes to disk and reloads the document from them, so the next save is again a small incremental update. A document that had to be rebuilt on opening (damaged cross-reference data) is always written in full.

## Undo

`DocTab.edit(label, fn)` snapshots the engine overlay (the map of changed objects, the trailer and the next object number), runs `fn`, and pushes the snapshot. Undo and redo swap snapshots, clear caches and re-render. Commands call `app.edit(...)`, or `app.editTab(tab, ...)` after an `await` so the change goes to the tab the command started on; both refuse when the tab is read-only.

- Snapshots share stream bytes with the live overlay instead of copying them, and the history is capped by the stream bytes only it still holds.
- Undo never lowers the next object number, so a reference kept from before an undo can only resolve to nothing, never to a different object.
- An edit that returns `NO_CHANGE` leaves no undo step and does not mark the tab dirty.
- The history survives an incremental save: after the save the snapshots are re-expressed against the new file. After a full rewrite, encryption or revert the history starts again and the user is told once.
- Image XObjects are created inside the edit that places them, so a cancelled or undone placement leaves nothing in the file.

## Read-only documents

`App.exec` refuses every command that is not marked `edits: false` while the tab is read-only; viewing, navigation, export and settings commands carry that mark. `DocTab.edit` and `replaceWithBytes` check again, so a command that reaches them some other way is still refused.

## Viewer

One pdf.js worker is shared by all tabs. Reload requests made while a load is running are folded into one trailing load. Pages far from the viewport release their bitmap and text layer, and a page bitmap is capped (16 megapixels on touch devices, 48 elsewhere) with CSS stretching the rest. Every viewport combines the page's own `/Rotate` with the view rotation. HTML that reaches a dialog through `Field.html` is rebuilt from an allow-list (`util/sanitize.ts`), so text from a document cannot become markup that runs.

## Commands and gestures

Tools are commands that call `viewer.setTool(tool, opts)`. The viewer reports a finished gesture as `comment.toolDone` with the page, rectangle, points and options; the dispatcher in `commands/comment.ts` turns it into an engine operation. Annotations are selected by hit-testing the engine's annotation rectangles; dragging them runs `comment.moveAnnotation`. Thumbnail drags run `organize.moveTo`.

## Assets copied at build time

`scripts/copy-pdfjs.mjs` (run before dev, test and build) copies pdf.js CMaps, standard fonts, WASM decoders and ICC profiles to `public/pdfjs/`, and the tesseract.js worker and LSTM cores to `public/tesseract/`. Both folders are ignored by git.

## Tests

`npm test` runs the engine tests (filters, hashes, round trips, encryption), the operation tests (structure, annotations, forms, pages, extraction, text editing, optimization, repair of eight kinds of damage) and the registry tests (every ribbon id exists, the catalog is current, the Quick Access Bar order). `npm run e2e` builds a PDF in the browser through the engine, opens it, annotates, fills a field, rotates, saves both ways, reopens, searches, switches views and repairs a damaged copy.
