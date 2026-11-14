# Clean-room, trademark and licensing notes

This file records how Anne's Folio provides a complete PDF command set while avoiding other vendors' trademarks and copyrights. It summarizes the project's practice, the same practice the rest of the Anne's Office suite follows; it is not legal advice.

## What is reproduced, and why it is safe

- **The file format.** PDF is an open standard, ISO 32000-1 (PDF 1.7) and ISO 32000-2 (PDF 2.0); the earlier versions were published by Adobe as open specifications. XFDF and FDF are published formats. The engine was written from those specifications and from the behavior of files produced by many programs, never from another product's code.
- **Functionality and command names.** Operations such as Highlight, Sticky Note, Stamp, Redact, Fill & Sign, Organize Pages, Bates Numbering, Recognize Text and Flatten are functional ideas described with ordinary words used across the industry. Functionality is not protected by copyright, and descriptive terms are not trademarks for those functions.
- **Tab and group organization.** Grouping commands under Home, Edit, View, Comment, Forms, Protect, Sign, Organize Pages, Scan/OCR, Review and Tools is a common, functional arrangement. Anne's Folio's grouping, labels, tooltips and descriptions are written for this project.
- **Keyboard shortcuts.** Long-standing conventions (Ctrl+F to find, Ctrl+P to print, Ctrl+Shift+D to add a bookmark); all can be rebound.
- **Rendering.** pdf.js (Mozilla, Apache 2.0) rasterizes pages. Its license permits this use and is reproduced in the third-party notices.

## What is deliberately not reproduced

- No vendor logos, icons, splash screens, color schemes or trade dress. Command icons are Google's Material Symbols (Apache 2.0). The app icon and visual design are original.
- No vendor product names in the app's own name or interface. Brand-specific feature names are replaced with generic terms:

| Vendor term | Anne's Folio term |
|---|---|
| Acrobat, Reader (as feature names) | not used; "PDF" names the format |
| Fill & Sign (also used generically by several products) | Fill & Sign (descriptive) |
| Document Cloud, Send for Signature, Adobe Sign | Share, Request Signatures |
| Sanitize Document, Remove Hidden Information | Sanitize, Hidden Information (descriptive) |
| Preflight (print production) | Archival Check, Compatibility |
| Compare Files | Compare |
| Enhance Scans | Enhance Scans (descriptive) |
| Bates Numbering | Bates Numbering (a legal-industry term, not a product name) |
| Smart Lookup, Tell Me | Look Up, Search Commands |
| Copilot and other assistant brand names | AI tab |
| Portfolio | Portfolio (the ISO 32000 term is "collection"; both appear) |

- No copied help text, tooltips, templates, stamps, sample documents or dictionaries. Stamp texts are ordinary words (Approved, Draft, Confidential); templates are built in code.
- No proprietary fonts are bundled; new text uses the standard 14 fonts by name, which readers substitute with metric-compatible fonts, and the signature pad renders typed names with the bundled open font.
- Document JavaScript is never executed; it is listed and can be removed.

## Nominative use

Anne's Folio's documentation names other products (Adobe Acrobat and Reader, Foxit, Nitro, PDF-XChange, Apple Preview, Sumatra PDF, Okular, Evince, MuPDF, Ghostscript, qpdf, pdftk, PDFsam, poppler, Bluebeam, pdf.js, Chromium, Microsoft Office, LibreOffice and others) only to identify file formats or to credit where an idea came from. This is nominative use; it does not imply affiliation, sponsorship or endorsement. The names are trademarks of their respective owners, including:

- Adobe, Acrobat, Acrobat Reader and Document Cloud are trademarks of Adobe Inc. PDF is also a registered trademark of Adobe for its software; the file format is an open ISO standard.
- Foxit is a trademark of Foxit Software Inc.; Nitro of Nitro Software; PDF-XChange of Tracker Software; Bluebeam of Bluebeam, Inc.
- Preview, iOS, iPadOS and macOS are trademarks of Apple Inc.; Windows and Microsoft Office of Microsoft Corporation; Android and Chrome of Google LLC; Linux of Linus Torvalds.
- LibreOffice is a trademark of The Document Foundation; Mozilla and Firefox of the Mozilla Foundation.

## Third-party components

Generated into `third-party-notices.txt` at build time from `package.json`. Only permissive licenses are accepted:

| Component | Use | License |
|---|---|---|
| pdf.js (pdfjs-dist) | Rendering and text extraction | Apache 2.0 |
| tesseract.js and tesseract.js-core | Text recognition (bundled worker and WASM cores) | Apache 2.0 |
| tessdata language files | Downloaded on demand from the tessdata mirror the library uses | Apache 2.0 |
| JSZip | ZIP packages (review packages, split and batch output) | MIT |
| Material Symbols | Command icons | Apache 2.0 |
| Capacitor and plugins | Android and iOS shells | MIT |
| Electron, electron-builder | Desktop shells | MIT |
| Vite, TypeScript, vitest, Playwright | Build and test tooling (not shipped) | MIT, Apache 2.0 |
| nspell and the SCOWL dictionaries; downloaded Hunspell dictionaries | Spelling | MIT; various permissive licenses listed in the dictionary catalog |
| Transformers.js, ONNX Runtime Web and the on-device model | Optional on-device AI. The library and the runtime are part of the app; the model is downloaded | Apache 2.0 (Transformers.js), MIT (ONNX Runtime); model licenses shown in the setup wizard |

## Online services

Anne's Folio has no server. It reaches the network only when you ask it to:

- **AI providers** you set up (your own key), and the on-device model's files, downloaded from huggingface.co on first use (the program that runs the model is part of the app; nothing is loaded from a code CDN);
- **Spelling dictionaries** downloaded from the catalog's sources;
- **OCR language data** downloaded from the tessdata mirror on first use of each language, after a consent dialog;
- **Look Up** opens the dictionary, encyclopedia or search page you choose in the browser;
- links in documents open in the browser only after a safety check and your click.

## License

MIT. Copyright (c) 2026 Paul D Pruitt. Contributions are accepted under the same license.
