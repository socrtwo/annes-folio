# Anne's Folio

*Part of the Anne's Office suite: [Anne's Pen](https://github.com/socrtwo/QuillPen) (documents), [Anne's Grid](https://github.com/socrtwo/QuillGrid) (spreadsheets), [Anne's Post](https://github.com/socrtwo/QuillPost) (email), [Anne's Stage](https://github.com/socrtwo/QuillStage) (presentations), [Anne's Loom](https://github.com/socrtwo/QuillLoom) (web sites), [Anne's Press](https://github.com/socrtwo/QuillPress) (desktop publishing) and **Anne's Folio** (PDF).*

An original, open-source PDF app for Android, iOS, Windows, macOS, Linux, ChromeOS and the web, focused on viewing, editing, forms, signing, OCR and repair. Its goal is the same as the rest of the Anne's Office suite: **no missing commands**. Anne's Folio gives you a familiar workflow (tabs for Home, Edit, View, Comment, Forms, Protect, Sign, Organize Pages, Scan/OCR, Review, Tools, AI, Developer and Help) on top of its own PDF engine, which reads, repairs, edits and writes the files; pages are drawn by pdf.js. Every feature is a command, and every command can be put on the Quick Access Bar, on your own tab, on a keyboard shortcut, or in a macro, and found with command search. When a PDF is damaged, Anne's Folio rebuilds what it can and shows a repair report instead of refusing to open it.

> **Status: first working version (0.1.0, milestone M1 with much of M2 and M3).** The app builds for the web, Android, iOS and desktop with the same CI and release workflows as the sister apps. What works today:
>
> - **354 commands**; 359 of the 379 ids in the plan are implemented, and the rest are listed in [docs/COMMANDS.md](docs/COMMANDS.md). A command is registered only when it works.
> - **Engine:** a clean-room ISO 32000 object model with a tolerant parser, every standard filter except the image codecs, cross-reference tables and streams, object streams, RC4 and AES decryption, AES-256 encryption, incremental updates and full rewrites, and a reconstruction path for damaged files. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).
> - **Viewing:** continuous, single, facing and book layouts, zoom and fit modes, rotation, thumbnails with drag reordering, an Organize Pages grid, search with highlights, text selection, read, presentation and full-screen modes, night mode and grayscale, side-by-side windows, panes for bookmarks, attachments, layers, comments, signatures, fields, search and a structure inspector.
> - **Commenting:** highlight, underline, strikeout, squiggly, notes with replies and status, text boxes and callouts, pen, highlighter, shapes and clouds, stamps (text and picture), file and audio attachments, measurements with a drawing scale, properties, flatten, XFDF in and out.
> - **Editing:** replace text in simple fonts in place (other fonts are overlaid), add text and pictures, move and delete pictures, erase areas, crop, page labels, headers and footers, Bates numbers, watermarks, backgrounds, booklet and N-up.
> - **Forms:** fill text, check box, radio, drop-down and list fields; add every field type; properties, tab and calculation order, detection of blanks; XFDF, FDF, CSV and JSON data; flatten.
> - **Protect and sign:** AES-256 encryption with permissions; redaction by area, text, search and pattern with a log attached to the file; hidden-information report and sanitizing; drawn, typed or picture signatures and initials; signature fields and requests; byte-range checks of existing signatures.
> - **Scan/OCR:** PDFs from pictures and the camera; text recognition with tesseract.js writing an invisible, searchable text layer (language data downloads on demand); deskew, despeckle, auto-crop, compression and duplex reordering.
> - **Files:** any PDF (encrypted ones with a password; damaged ones through the repair pipeline), FDF/XFDF data, pictures, text, Markdown and HTML converted to PDF, ZIPs of PDFs; saving by incremental update, full rewrite, optimized, flattened or as a review package; export to images, text, Markdown, HTML, CSV tables and attachments. See [docs/FORMATS.md](docs/FORMATS.md) and [docs/REPAIR.md](docs/REPAIR.md).
> - **AI tab** with the suite's setup wizard, on-device model and several-AI modes: summaries, questions, key points, tables and entities, field labels, translation, comment help, OCR clean-up, alt text, redaction suggestions, bookmarks. See [docs/AI.md](docs/AI.md).
>
> Not yet: certificate-based signing and signature validation, linearization, conforming PDF/A output, JBIG2 and JPEG 2000 decoding in the engine (pdf.js still displays them), editing text in CID fonts in place, font embedding. See [docs/ROADMAP.md](docs/ROADMAP.md). Verified in Chromium and against files written by other producers; not yet tested on every reader.

## Features and plan

- **A complete command set.** Every command a desktop PDF program offers, tab by tab, plus commands adopted from other PDF tools, command-line utilities and viewers. See [docs/COMMANDS-PLAN.md](docs/COMMANDS-PLAN.md) and the generated [docs/COMMANDS.md](docs/COMMANDS.md).
- **No missing commands.** Commands are data. The ribbon, the Quick Access Bar, custom tabs, context menus, keyboard shortcuts, macros and command search (Alt+Q) all refer to command ids, so anything Anne's Folio can do can be placed anywhere.
- **Quick Access Bar** with the full desktop drop-down checklist (AutoSave, New, Open, Save, Email, Quick Print, Print, Spelling, Undo, Redo, Read Mode, Touch/Mouse Mode, Open Recent) and **Add All Choices**, which puts Save and Print first and everything else in alphabetical order. The bar can sit above or below the ribbon or at the bottom near the keyboard. See [docs/QAT.md](docs/QAT.md).
- **Customize Tabs and Keyboard:** create tabs and groups, put any command in them, rename, reorder or hide built-in tabs, and rebind any command with conflict display. Layouts can be exported and imported.
- **Its own engine, plus pdf.js for pixels.** Anne's Folio's engine (src/pdf) is the document of record: it parses, repairs, edits and writes PDFs from the ISO 32000 specification. pdf.js (Apache 2.0) only rasterizes pages and extracts positioned text for display, selection and search. Saves append an incremental update by default, so the original bytes and any signatures stay intact; a full rewrite is one option away.
- **Innovations from other PDF software,** credited in [docs/INNOVATIONS.md](docs/INNOVATIONS.md): a repair report with a diff of what was rebuilt and lost, a structure inspector with raw object view, a redaction log that travels with the file, review packages, a plain-language accessibility fixer, document similarity, batch processing, and more.
- **AI tab (optional).** Summaries, questions over the pages that match them best, key points, tables and entities, labels for form fields, translation, comment rewriting and replies, OCR clean-up, alt text, redaction suggestions, bookmarks and an assistant. The setup wizard covers free and paid providers, local servers, and a **free on-device model** that works offline after one download of its model files (the program that runs it is part of the app). Several AIs can work on one request. Nothing is sent anywhere until you run an AI command.
- **Spelling in many languages** for comments and form field values: offline dictionaries for every variety of English, and a **Spelling Dictionaries** wizard that downloads freely licensed dictionaries for 90+ other languages.
- **Corrupt-file repair.** Damaged PDFs go through a pipeline descended from the author's [Immortal Zip](https://socrtwo.github.io/Immortal-Zip/), [XML Truncator-Fixer](https://socrtwo.github.io/xmltrncatorfixr-SF/app/) and [Word Recovery](https://github.com/socrtwo/wordrecovery-SF) tools: identification from the bytes, header and end-of-file repair, cross-reference reconstruction, catalog and page-tree recovery, stream length recovery, partial inflation of damaged streams, salvage of PDFs fused with other data or inside damaged ZIPs, and text scans as a last resort. The recovered document opens as a new, unsaved file with a report.

## File formats

| Format | Open | Save | Notes |
|---|---|---|---|
| PDF (.pdf), PDF 1.0–2.0 | Yes | Yes | Incremental update (default) or full rewrite; optimized, flattened, encrypted (AES-256); damaged files repaired on open |
| Encrypted PDF (RC4 40/128, AES-128, AES-256) | Yes | Yes (AES-256) | Password prompt; permissions shown and set |
| Form data: XFDF, FDF, CSV, JSON | Yes | Yes | Applied to the open form |
| Comments: XFDF | Yes | Yes | Import another reviewer's annotations |
| Pictures: PNG, JPEG, GIF, WebP, BMP, TIFF, SVG | As pages | PNG, JPEG | One page per picture; pages exported at any resolution |
| Text, Markdown, HTML | As pages | Yes | Simple typesetter with the standard fonts; export the text of every page |
| CSV tables | No | Yes | Tables detected from text positions |
| ZIP of PDFs | Yes | Yes | Combined on open; split and batch results are ZIPs |
| Anne's Folio review package (.qfr) | Yes | Yes | ZIP of the PDF, its XFDF comments, audit log and report |
| PDF portfolios (collections) | Yes | No | The embedded files are listed and extracted |

See [docs/FORMATS.md](docs/FORMATS.md).

## Platforms

Each release has builds for:
- **Android** (APK and AAB);
- **iOS/iPadOS** (an unsigned .ipa you sign with your Apple ID);
- **Windows** 10 or later (installer for x64 or ARM, or portable);
- **macOS** 12 or later (universal);
- **Linux** (AppImage or .deb for x64, arm64 and armv7l, which covers **Raspberry Pi OS**);
- **ChromeOS** (Android app, Linux app or web app);
- the **web** (static files; offline-capable and installable).

On Android, Anne's Folio registers for *Open with* and *Share to* on PDFs, pictures and text files and uses the system file picker, so files on the device, SD card and cloud providers all work. **Save** writes back to the same file.

CI type-checks, runs the unit tests and a browser smoke test, and builds the web app and an APK on every push. The **Release** workflow runs the same checks, then builds every platform and publishes them together from a tag `v*`, a manual run, or a `[release]` commit, as in the sister apps. See [docs/BUILD.md](docs/BUILD.md), [docs/INSTALL.md](docs/INSTALL.md) and [docs/ANDROID.md](docs/ANDROID.md).

## The Anne's Office suite

| App | What it is | Repository |
|---|---|---|
| **Anne's Pen** | Word processor | https://github.com/socrtwo/QuillPen |
| **Anne's Grid** | Spreadsheet | https://github.com/socrtwo/QuillGrid |
| **Anne's Post** | Email | https://github.com/socrtwo/QuillPost |
| **Anne's Stage** | Presentations | https://github.com/socrtwo/QuillStage |
| **Anne's Loom** | Web sites | https://github.com/socrtwo/QuillLoom |
| **Anne's Press** | Desktop publishing | https://github.com/socrtwo/QuillPress |
| **Anne's Folio** | PDF (this project) | https://github.com/socrtwo/annes-folio |

The apps share one application shell: the command registry, Quick Access Bar, customizable tabs and keyboard, command search, macro recorder, AI setup wizard and providers, spelling dictionaries, recovery engine and platform layer. The other apps export PDFs that Anne's Folio opens, and Anne's Folio hands documents to them through the share sheet.

## Documentation

| File | Contents |
|---|---|
| [docs/INNOVATIONS.md](docs/INNOVATIONS.md) | Survey of PDF software, past and present, and what Anne's Folio adopts from each |
| [docs/QAT.md](docs/QAT.md) | The Quick Access Bar, the drop-down choices and the Add All order |
| [docs/COMMANDS-PLAN.md](docs/COMMANDS-PLAN.md) | The planned command inventory, tab by tab, with command ids |
| [docs/COMMANDS.md](docs/COMMANDS.md) | Every implemented command (generated) |
| [docs/ARCHITECTURE-PLAN.md](docs/ARCHITECTURE-PLAN.md) | Intended architecture: shell, engine, viewer, commands, AI, repair, builds |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | The source layout as built |
| [docs/FORMATS-PLAN.md](docs/FORMATS-PLAN.md) | Every format to open or save, with planned fidelity |
| [docs/FORMATS.md](docs/FORMATS.md) | What opens and saves today |
| [docs/REPAIR.md](docs/REPAIR.md) | The repair pipeline for damaged PDFs |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Milestones |
| [docs/AI.md](docs/AI.md) | The AI tab, providers and privacy |
| [docs/ENSEMBLE.md](docs/ENSEMBLE.md) | Several AIs on one request: master synthesis or Quaker consensus |
| [docs/BUILD.md](docs/BUILD.md), [docs/INSTALL.md](docs/INSTALL.md), [docs/ANDROID.md](docs/ANDROID.md) | Building, installing, the Android plugin |
| [docs/LEGAL.md](docs/LEGAL.md) | Clean-room, trademark and licensing notes |

## Project language

The interface, code comments and documentation use American English. Spelling checks accept every variety of English by default.

## License

[MIT](LICENSE). Copyright (c) 2026 Paul D Pruitt.

## Legal

Anne's Folio is an independent, clean-room project released under the MIT License. It is not affiliated with, endorsed by, or sponsored by Adobe, Foxit, Nitro, Apple, Google, Microsoft, any AI provider, or any other vendor. Product names appear only to describe file-format compatibility or the origin of an idea (nominative use). Adobe, Acrobat and PDF are trademarks of Adobe Inc.; other names belong to their owners. The PDF format itself is an open ISO standard (ISO 32000). The interface, icons, templates and text are original or openly licensed. See [docs/LEGAL.md](docs/LEGAL.md).
