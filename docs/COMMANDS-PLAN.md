# Anne's Folio command plan

Every feature is a command with an id (`area.name`), a label, a Material Symbols icon, a tab and a group. The ribbon, the Quick Access Bar, menus, shortcuts, macros and command search reference commands by id only. This file is the planned inventory, tab by tab; `npm run catalog` generates [COMMANDS.md](COMMANDS.md) from the live registry and lists which of these ids are implemented. A command is registered only when it works.

## File (backstage)

New documents (blank, templates, from text, from the clipboard), opening (any PDF, damaged PDFs through the repair pipeline, images and text converted to PDF, recent files, encrypted files), saving (incremental update by default, full rewrite, optimized, flattened, review package), export, print, share, properties, versions and snapshots, options and customization.

- `file.alwaysReadOnly` — Always Open Read-Only
- `file.autosave` — AutoSave
- `file.clearRecent` — Clear Unpinned Recent Documents
- `file.close` — Close
- `file.closeAll` — Close All
- `file.customDictionary` — Custom Dictionary…
- `file.customizeKeyboard` — Customize Keyboard…
- `file.customizeQat` — Customize Quick Access Bar…
- `file.customizeRibbon` — Customize Tabs…
- `file.email` — Email
- `file.exit` — Exit
- `file.export.html` — Export HTML
- `file.export.images` — Export Pages as Images…
- `file.export.markdown` — Export Markdown
- `file.export.text` — Export Text
- `file.exportSettings` — Export / Import Settings…
- `file.new` — New
- `file.newFromClipboard` — New from Clipboard
- `file.newFromTemplate` — New from Template…
- `file.newFromText` — New from Text or Markdown…
- `file.open` — Open
- `file.openEncrypted` — Open Encrypted PDF…
- `file.openRecent` — Open Recent File
- `file.openRepair` — Open and Repair…
- `file.options` — Options…
- `file.print` — Print…
- `file.properties` — Properties…
- `file.quickPrint` — Quick Print
- `file.recoverAny` — Recover Data from Any File…
- `file.recoverUnsaved` — Recover Unsaved Documents
- `file.recoveryHelp` — Manual Recovery Options
- `file.recoveryReport` — Repair Report
- `file.resetCustomizations` — Reset All Customizations
- `file.revert` — Revert to Saved
- `file.save` — Save
- `file.saveAll` — Save All
- `file.saveAs` — Save As
- `file.saveCopy` — Save a Copy…
- `file.saveFlat` — Save Flattened Copy
- `file.saveReviewPackage` — Save Review Package (.qfr)
- `file.saveRewrite` — Save As Rewritten PDF
- `file.share` — Share
- `file.shareFlat` — Share Flattened Copy
- `file.snapshot` — Take Snapshot
- `file.versions` — Version History

Planned, not yet implemented:

- `file.export.pdfa` — Export as PDF/A
- `file.export.svg` — Export Pages as SVG

## Home

Tools (select, hand, marquee zoom, snapshot), clipboard, page navigation, zoom, view rotation, find, quick comment tools, undo and redo.

- `edit.copy` — Copy
- `edit.copyAsMarkdown` — Copy as Markdown
- `edit.copyImage` — Copy as Picture
- `edit.find` — Find
- `edit.findNext` — Find Next
- `edit.findPrev` — Find Previous
- `edit.paste` — Paste
- `edit.redo` — Redo
- `edit.repeat` — Repeat Last Command
- `edit.selectAll` — Select All
- `edit.undo` — Undo
- `home.hand` — Hand
- `home.select` — Select
- `home.snapshot` — Snapshot
- `home.zoomTool` — Marquee Zoom
- `nav.back` — Back
- `nav.first` — First Page
- `nav.forward` — Forward
- `nav.goTo` — Go to Page…
- `nav.last` — Last Page
- `nav.next` — Next Page
- `nav.pageNumber` — Page Number
- `nav.prev` — Previous Page

## Edit

Page content editing: text runs (re-encoded in the same font when it can encode the new text, otherwise overlaid), new text, erasing, images (add, select, move, delete, extract), links.

- `edit.addImage` — Add Image
- `edit.addText` — Add Text
- `edit.deleteImage` — Delete Image
- `edit.editText` — Edit Text
- `edit.eraseArea` — Erase Area
- `edit.eraseRange` — Erase Page Area…
- `edit.extractImage` — Extract Image
- `edit.moveImage` — Move / Resize Image
- `edit.removeLinks` — Remove Links
- `edit.selectImage` — Select Image

Planned, not yet implemented:

- `edit.editCidText` — Edit Text in CID Fonts
- `edit.reflow` — Reflow Paragraph

## View

Page layouts, panes, zoom, rotation, read/presentation/full-screen/organize modes, display options, windows, and the shared Quick Access Bar, ribbon and theme commands.

- `view.actualSize` — Actual Size
- `view.attachments` — Attachments
- `view.book` — Book
- `view.bookmarks` — Bookmarks
- `view.cmdSearch` — Search Commands
- `view.collapseRibbon` — Collapse the Ribbon
- `view.comments` — Comments
- `view.compareSideBySide` — Side by Side
- `view.continuous` — Continuous
- `view.facing` — Facing Pages
- `view.fields` — Form Fields
- `view.fitPage` — Fit Page
- `view.fitWidth` — Fit Width
- `view.fullScreen` — Full Screen
- `view.grayscale` — Grayscale
- `view.inspector` — Structure Inspector
- `view.layers` — Layers
- `view.newWindow` — New Window
- `view.nightMode` — Night Mode
- `view.organize` — Organize Pages
- `view.presentation` — Presentation Mode
- `view.qatAddAll` — Add All Quick Access Choices (A–Z)
- `view.qatHide` — Hide Quick Access Bar
- `view.qatLabels` — Quick Access Bar Labels
- `view.qatPosition` — Quick Access Bar Position
- `view.qatShow` — Show Quick Access Bar
- `view.readMode` — Read Mode
- `view.rotateLeft` — Rotate View Left
- `view.rotateRight` — Rotate View Right
- `view.searchPane` — Search
- `view.signatures` — Signatures
- `view.single` — Single Page
- `view.smoothScroll` — Smooth Scrolling
- `view.switchWindow` — Switch Windows
- `view.theme` — Dark Mode
- `view.thumbnails` — Thumbnails
- `view.touchMode` — Touch/Mouse Mode
- `view.zoom` — Zoom…
- `view.zoomBox` — Zoom Level
- `view.zoomIn` — Zoom In
- `view.zoomOut` — Zoom Out

Planned, not yet implemented:

- `view.rulers` — Rulers
- `view.grid` — Grid

## Comment

Text markup, notes, text boxes and callouts, drawing tools, stamps, attachments and audio, measurements, style, and the management of annotations (properties, replies, status, flatten, XFDF).

- `comment.arrow` — Arrow
- `comment.attachFile` — Attach File
- `comment.audio` — Audio Comment
- `comment.author` — Author Name…
- `comment.callout` — Callout
- `comment.cloud` — Cloud
- `comment.color` — Color
- `comment.customStamp` — Custom Stamp…
- `comment.delete` — Delete
- `comment.deleteAll` — Delete All Comments
- `comment.duplicate` — Duplicate
- `comment.ellipse` — Ellipse
- `comment.eraser` — Ink Eraser
- `comment.exportXfdf` — Export Comments (XFDF)
- `comment.flatten` — Flatten Comments
- `comment.flattenOne` — Flatten This Annotation
- `comment.freetext` — Text Box
- `comment.hide` — Hide / Show
- `comment.highlight` — Highlight
- `comment.highlighterPen` — Highlighter Pen
- `comment.imageStamp` — Image Stamp…
- `comment.importXfdf` — Import Comments (XFDF)
- `comment.line` — Line
- `comment.lineWidth` — Line Width
- `comment.link` — Link
- `comment.markupFromText` — Mark Up Selected Text with a Note
- `comment.measure` — Measure Distance
- `comment.measureArea` — Measure Area
- `comment.measureScale` — Measurement Scale…
- `comment.nextComment` — Next Comment
- `comment.note` — Note
- `comment.opacity` — Opacity
- `comment.pen` — Pen
- `comment.polygon` — Polygon
- `comment.polyline` — Polyline
- `comment.prevComment` — Previous Comment
- `comment.properties` — Properties…
- `comment.rectangle` — Rectangle
- `comment.reply` — Reply…
- `comment.setStatus` — Set Status
- `comment.squiggly` — Squiggly Underline
- `comment.stamp` — Stamp
- `comment.strikeout` — Strikethrough
- `comment.summarize` — Summarize Comments
- `comment.toBack` — Send to Back
- `comment.toFront` — Bring to Front
- `comment.underline` — Underline

Planned, not yet implemented:

- `comment.caret` — Caret (insert text) Annotation
- `comment.compareAnnotate` — Annotate Differences

## Forms

Field tools, field properties and appearance, fill mode, data import and export, detection, tab and calculation order, reset and flatten.

- `forms.button` — Button
- `forms.calcOrder` — Calculation Order…
- `forms.checkbox` — Check Box
- `forms.clearField` — Clear Field
- `forms.combo` — Drop-down
- `forms.dateField` — Date Field
- `forms.deleteField` — Delete Field
- `forms.detect` — Detect Fields
- `forms.duplicateField` — Duplicate Field
- `forms.exportCsv` — Export CSV
- `forms.exportData` — Export Form Data…
- `forms.exportJson` — Export JSON
- `forms.fieldBorder` — Field Border…
- `forms.fieldFont` — Field Font Size
- `forms.fieldList` — Field List
- `forms.fillMode` — Fill Mode
- `forms.fillValue` — Fill Field…
- `forms.flatten` — Flatten Form
- `forms.highlightFields` — Highlight Fields
- `forms.importData` — Import Form Data…
- `forms.listbox` — List Box
- `forms.properties` — Field Properties…
- `forms.radio` — Radio Button
- `forms.reset` — Reset Form
- `forms.signatureField` — Signature Field
- `forms.tabOrder` — Tab Order
- `forms.textField` — Text Field
- `forms.widgetTooltips` — Add Missing Tooltips

Planned, not yet implemented:

- `forms.validate` — Field Validation Rules
- `forms.calculate` — Field Calculations

## Protect

Encryption and permissions (AES-256), redaction (areas, text, search, pages, apply with a log), hidden information and sanitizing, mark as final.

- `protect.applyRedactions` — Apply Redactions
- `protect.encrypt` — Encrypt…
- `protect.hiddenInfo` — Hidden Information
- `protect.markFinal` — Mark as Final
- `protect.permissions` — Permissions…
- `protect.redactArea` — Mark Area
- `protect.redactLog` — Redaction Log
- `protect.redactPages` — Mark Pages
- `protect.redactSearch` — Mark by Search…
- `protect.redactText` — Mark Text
- `protect.removeAttachments` — Remove Attachments
- `protect.removeJavaScript` — Remove JavaScript
- `protect.removeMetadata` — Remove Metadata
- `protect.removeSecurity` — Remove Security
- `protect.sanitize` — Sanitize…
- `protect.securityInfo` — Security Settings
- `protect.setOpenPassword` — Change Open Password…
- `protect.watermarkConfidential` — Confidential Watermark

## Sign

Fill & Sign (drawn, typed or picture signatures, initials, date, check marks), signature fields and requests, verification of existing signatures (byte ranges).

- `sign.checkmark` — Check Mark
- `sign.clearSignatureField` — Clear Signature Field
- `sign.cross` — Cross
- `sign.dateStamp` — Date
- `sign.initials` — Initials
- `sign.manageSignatures` — Saved Signatures…
- `sign.requestSignatures` — Request Signatures…
- `sign.signature` — Sign
- `sign.verify` — Signature Details (what a signature claims and covers; certificates are not validated)

Planned, not yet implemented:

- `sign.certificate` — Sign with Certificate (PKCS#7 / PAdES)
- `sign.timestamp` — Add Timestamp (RFC 3161)
- `sign.verifyCertificate` — Validate Signature Certificates

## Organize Pages

Insert, delete, replace, extract, duplicate, move, reverse, split and merge, rotate, crop, page boxes, resize, page labels, headers and footers, Bates numbers, watermarks, backgrounds, image overlays, booklet and N-up, selection.

- `organize.background` — Background…
- `organize.bates` — Bates Numbering…
- `organize.booklet` — Booklet…
- `organize.combineFiles` — Combine Files…
- `organize.crop` — Crop…
- `organize.delete` — Delete Pages
- `organize.duplicate` — Duplicate Pages
- `organize.extract` — Extract Pages…
- `organize.headerFooter` — Header and Footer…
- `organize.imageOverlay` — Image Overlay…
- `organize.insertBlank` — Insert Blank Page
- `organize.insertBlankPages` — Insert Blank Pages…
- `organize.insertFromClipboard` — Insert from Clipboard
- `organize.insertFromFile` — Insert from File…
- `organize.insertFromImages` — Insert from Images…
- `organize.insertFromText` — Insert from Text…
- `organize.interleave` — Interleave Two Documents…
- `organize.merge` — Merge Files…
- `organize.move` — Move Pages…
- `organize.nUp` — N-up…
- `organize.pageBoxes` — Page Boxes…
- `organize.pageLabels` — Page Labels…
- `organize.replace` — Replace Pages…
- `organize.reverse` — Reverse Page Order
- `organize.rotate180` — Rotate 180°
- `organize.rotateLeft` — Rotate Left
- `organize.rotateRight` — Rotate Right
- `organize.scale` — Resize Pages…
- `organize.selectAll` — Select All Pages
- `organize.selectEven` — Select Even Pages
- `organize.selectNone` — Clear Page Selection
- `organize.selectOdd` — Select Odd Pages
- `organize.selectRange` — Select Pages…
- `organize.split` — Split…
- `organize.watermark` — Watermark…

## Scan/OCR

PDFs from images and the camera, text recognition with an invisible text layer, language data on demand, OCR clean-up, deskew, despeckle, auto-crop, compression, duplex reordering.

- `scan.autoCrop` — Auto-Crop
- `scan.compressScans` — Compress Scans…
- `scan.deskew` — Deskew
- `scan.despeckle` — Despeckle
- `scan.exportText` — Export Recognized Text
- `scan.fromCamera` — Scan with Camera
- `scan.fromImages` — PDF from Images…
- `scan.languages` — OCR Languages…
- `scan.makeSearchableReport` — Searchable Pages Report
- `scan.ocrCleanup` — OCR Cleanup…
- `scan.recognize` — Recognize Text
- `scan.reorder` — Reorder Duplex Scan

Planned, not yet implemented:

- `scan.decodeJbig2` — Decode JBIG2 Images
- `scan.decodeJpx` — Decode JPEG 2000 Images

## Review

Spelling of comments and fields, dictionaries, statistics, fonts, accessibility check and fixer, read aloud, compare, archival and compatibility checks, language, look up.

- `review.accessibilityFixer` — Accessibility Fixer
- `review.archivalCheck` — Archival Check
- `review.checkAccessibility` — Check Accessibility
- `review.compare` — Compare…
- `review.compatibility` — Compatibility
- `review.dictionaries` — Spelling Dictionaries
- `review.exportComments` — Comments as Text
- `review.fonts` — Fonts
- `review.language` — Language…
- `review.lookUp` — Look Up
- `review.readAloud` — Read Aloud
- `review.readingRate` — Reading Speed
- `review.spelling` — Spelling
- `review.statistics` — Document Statistics
- `review.stopReading` — Stop Reading
- `review.translate` — Translate

## Tools

Optimize and reduce size, extract text, images, tables and attachments, page info, similarity, bookmarks, attachments, batch processing, archiving preparation, XMP.

- `tools.addAttachment` — Attach File…
- `tools.addBookmark` — Add Bookmark
- `tools.batch` — Batch Process…
- `tools.bookmarksFromHeadings` — Bookmarks from Headings
- `tools.compressImages` — Compress Images…
- `tools.deleteBookmark` — Delete Bookmark
- `tools.deleteBookmarks` — Delete All Bookmarks
- `tools.editBookmark` — Edit Bookmark…
- `tools.editXmp` — Edit XMP Metadata…
- `tools.extractAttachments` — Extract Attachments
- `tools.extractImages` — Extract Images
- `tools.extractTables` — Extract Tables
- `tools.extractText` — Extract Text…
- `tools.fontsReport` — Fonts Report (Text)
- `tools.goToBookmark` — Go to Bookmark
- `tools.openAttachment` — Open Attachment
- `tools.optimize` — Optimize…
- `tools.pageInfo` — Page Info
- `tools.reduceSize` — Reduce File Size
- `tools.removeAttachment` — Remove Attachment
- `tools.rewrite` — Rewrite File
- `tools.saveAttachment` — Save Attachment
- `tools.similar` — Similar Documents
- `tools.toArchival` — Prepare for Archiving

Planned, not yet implemented:

- `tools.linearize` — Linearize (fast web view)
- `tools.pdfa` — Convert to PDF/A (conforming)
- `tools.embedFonts` — Embed Fonts
- `tools.portfolio` — Create Portfolio

## AI

Shared provider setup and several-AIs modes, plus document features: summaries, questions, key points, tables and entities, field labels, translation, comment help, OCR clean-up, alt text, redaction suggestions, page descriptions, bookmarks, assistant and prompt library.

- `ai.active` — Active AI
- `ai.altText` — Alt Text for Images
- `ai.askDocument` — Ask the Document
- `ai.assistant` — AI Assistant
- `ai.classifyFields` — Label Form Fields
- `ai.cleanOcr` — Clean OCR Text
- `ai.deleteModels` — Delete Downloaded Models
- `ai.describePage` — Describe Page
- `ai.ensembleMembers` — Choose AIs
- `ai.ensembleMode` — Several AIs
- `ai.explain` — Explain Selection
- `ai.extractEntities` — Extract Entities
- `ai.extractTable` — Extract Table
- `ai.keyPoints` — Key Points
- `ai.privacy` — AI & Privacy
- `ai.prompts` — Prompt Library
- `ai.providers` — Providers & Models
- `ai.replyComment` — Draft Reply
- `ai.rewriteComment` — Rewrite Comment
- `ai.settings` — AI Settings
- `ai.setup` — Set Up AI
- `ai.showDeliberation` — Show AI Discussion
- `ai.stop` — Stop AI
- `ai.suggestBookmarks` — Suggest Bookmarks
- `ai.suggestRedactions` — Suggest Redactions
- `ai.summarize` — Summarize Document
- `ai.summarizePage` — Summarize Page
- `ai.translate` — Translate

## Developer

Macros (recorded command lists, editor, security), scripts report, structure export, tag structure, raw objects.

- `dev.exportStructure` — Export Structure JSON
- `dev.javaScriptInfo` — Scripts in This Document
- `dev.macroEditor` — Macro Editor
- `dev.macroSecurity` — Macro Security
- `dev.macros` — Macros
- `dev.rawObject` — Raw Object…
- `dev.recordMacro` — Record Macro
- `dev.stopRecording` — Stop Recording
- `dev.tags` — Tag Structure

## Help

Help, shortcuts, command reference, tour, releases, feedback, notices, about.

- `help.about` — About Anne's Folio
- `help.commandReference` — Command Reference
- `help.feedback` — Report a Problem / Feedback
- `help.help` — Help
- `help.notices` — Third-Party Notices
- `help.shortcuts` — Keyboard Shortcuts
- `help.tour` — Tour
- `help.updates` — Check for Updates
- `help.whatsNew` — What's New

## Conventions

- Ids shared with the other Anne's Office apps keep their meaning: `file.save`, `file.open`, `file.openRepair`, `edit.undo`, `edit.redo`, `edit.find`, `review.spelling`, `view.cmdSearch`, `view.qatAddAll`, `view.qatPosition`, `view.qatLabels`, `view.qatShow`, `view.qatHide`, `view.collapseRibbon`, `view.touchMode`, `view.theme`, `file.customizeQat`, `file.customizeRibbon`, `file.customizeKeyboard`, `file.options`, `file.exportSettings`, `help.*`, `dev.*`.
- Internal commands (`comment.toolDone`, `edit.pickAt`, `organize.moveTo`, `file.openDropped`, `dev.runMacro`) are hidden from choosers; the viewer and panes call them.
