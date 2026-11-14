# Anne's Folio Command Reference

Anne's Folio ships **355 commands**. Every one can be placed on the Quick Access Bar, added to a custom tab, bound to a keyboard shortcut, recorded in a macro, or found with command search (Alt+Q).

77 of them are "Commands Not in the Tabs" — reachable through the Quick Access Bar chooser, Customize Tabs, the command search, or menus — so nothing the app can do is hidden.

Of the 379 command ids named in [COMMANDS-PLAN.md](COMMANDS-PLAN.md), 359 are implemented and 20 are not yet; they are listed at the end of this file.

This file is generated from the source by `npm run catalog`; a unit test fails when it is out of date.

## Default tab layout

- **Home**: Tools · Clipboard · Pages · Zoom · Rotate View · Find · Quick Comment · Undo
- **Edit**: Text · Images · Pages · Links · OCR Text · Document
- **View**: Page Layout · Panes · Zoom · Rotate View · Modes · Display · Window · Macros
- **Comment**: Text Markup · Notes · Drawing · Stamps · Attach · Measure · Style · Manage
- **Forms**: Add Fields · Edit · Fill · Form Data
- **Protect**: Security · Redact · Hidden Information · Final
- **Sign**: Fill & Sign · Signature Fields
- **Organize Pages**: View · Insert · Pages · Split and Merge · Rotate and Crop · Page Marks · Imposition · Select
- **Scan/OCR**: Create · Recognize Text · Enhance Scans · Pages
- **Review**: Proofing · Accessibility · Compare · Checks · Language · Comments
- **Tools**: Optimize · Extract · Inspect · Bookmarks · Attachments · Batch · Convert
- **AI**: Setup · Understand · Extract · Write · Review · More · Several AIs
- **Developer**: Code · Data
- **Help**: Help
- **Annotation** (contextual): Annotation · Style · Arrange
- **Form Field** (contextual): Field · Appearance
- **Selected Text** (contextual): Copy · Mark Up · Redact · Insight · Bookmark

## File (45)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Close | Close | Ctrl+w, Ctrl+F4 | `file.close` | not in tabs |
| Close All | Close |  | `file.closeAll` | not in tabs |
| Exit | Close |  | `file.exit` | not in tabs |
| Export HTML | Export |  | `file.export.html` |  |
| Export Markdown | Export |  | `file.export.markdown` |  |
| Export Pages as Images… | Export |  | `file.export.images` |  |
| Export Text | Export |  | `file.export.text` |  |
| Always Open Read-Only | Info |  | `file.alwaysReadOnly` |  |
| Properties… | Info |  | `file.properties` |  |
| Recover Unsaved Documents | Info |  | `file.recoverUnsaved` | not in tabs |
| Revert to Saved | Info |  | `file.revert` | not in tabs |
| Take Snapshot | Info | Ctrl+Alt+5 | `file.snapshot` | not in tabs |
| Version History | Info |  | `file.versions` | not in tabs |
| New | New | Ctrl+n | `file.new` | not in tabs |
| New from Clipboard | New |  | `file.newFromClipboard` | not in tabs |
| New from Template… | New |  | `file.newFromTemplate` | not in tabs |
| New from Text or Markdown… | New |  | `file.newFromText` | not in tabs |
| Clear Unpinned Recent Documents | Open |  | `file.clearRecent` | not in tabs |
| Manual Recovery Options | Open |  | `file.recoveryHelp` | not in tabs |
| Open | Open | Ctrl+o, Ctrl+F12 | `file.open` | not in tabs |
| Open and Repair… | Open |  | `file.openRepair` | not in tabs |
| Open Encrypted PDF… | Open |  | `file.openEncrypted` | not in tabs |
| Open Recent File | Open |  | `file.openRecent` | has options menu; not in tabs |
| Recover Data from Any File… | Open |  | `file.recoverAny` | not in tabs |
| Repair Report | Open |  | `file.recoveryReport` | not in tabs |
| Custom Dictionary… | Options |  | `file.customDictionary` | not in tabs |
| Customize Keyboard… | Options |  | `file.customizeKeyboard` | not in tabs |
| Customize Quick Access Bar… | Options |  | `file.customizeQat` | not in tabs |
| Customize Tabs… | Options |  | `file.customizeRibbon` | not in tabs |
| Export / Import Settings… | Options |  | `file.exportSettings` | not in tabs |
| Options… | Options |  | `file.options` | not in tabs |
| Reset All Customizations | Options |  | `file.resetCustomizations` | not in tabs |
| Print… | Print | Ctrl+p | `file.print` | not in tabs |
| Quick Print | Print |  | `file.quickPrint` | not in tabs |
| AutoSave | Save |  | `file.autosave` | not in tabs |
| Save | Save | Ctrl+s, Shift+F12 | `file.save` | not in tabs |
| Save a Copy… | Save |  | `file.saveCopy` | not in tabs |
| Save All | Save |  | `file.saveAll` | not in tabs |
| Save As | Save | F12, Ctrl+Shift+s | `file.saveAs` | not in tabs |
| Save As Rewritten PDF | Save |  | `file.saveRewrite` | not in tabs |
| Save Flattened Copy | Save |  | `file.saveFlat` | not in tabs |
| Save Review Package (.qfr) | Save |  | `file.saveReviewPackage` | not in tabs |
| Email | Share |  | `file.email` | not in tabs |
| Share | Share |  | `file.share` | not in tabs |
| Share Flattened Copy | Share |  | `file.shareFlat` | not in tabs |

## Home (23)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Copy | Clipboard | Ctrl+c, Ctrl+Insert | `edit.copy` |  |
| Copy as Markdown | Clipboard |  | `edit.copyAsMarkdown` |  |
| Copy as Picture | Clipboard |  | `edit.copyImage` |  |
| Paste | Clipboard | Ctrl+v, Shift+Insert | `edit.paste` |  |
| Select All | Clipboard | Ctrl+a | `edit.selectAll` |  |
| Find | Find | Ctrl+f, F3 | `edit.find` |  |
| Find Next | Find | Ctrl+ArrowDown | `edit.findNext` |  |
| Find Previous | Find | Ctrl+ArrowUp | `edit.findPrev` |  |
| Back | Pages | Alt+ArrowUp | `nav.back` | not in tabs |
| First Page | Pages | Ctrl+Home | `nav.first` |  |
| Forward | Pages | Alt+ArrowDown | `nav.forward` | not in tabs |
| Go to Page… | Pages | Ctrl+g, Ctrl+Shift+n | `nav.goTo` |  |
| Last Page | Pages | Ctrl+End | `nav.last` |  |
| Next Page | Pages | Alt+ArrowRight | `nav.next` |  |
| Page Number | Pages |  | `nav.pageNumber` |  |
| Previous Page | Pages | Alt+ArrowLeft | `nav.prev` |  |
| Hand | Tools | h | `home.hand` |  |
| Marquee Zoom | Tools | z | `home.zoomTool` |  |
| Select | Tools | Escape, v | `home.select` |  |
| Snapshot | Tools |  | `home.snapshot` |  |
| Redo | Undo | Ctrl+y, Ctrl+Shift+z | `edit.redo` |  |
| Repeat Last Command | Undo | Ctrl+Shift+y | `edit.repeat` | not in tabs |
| Undo | Undo | Ctrl+z | `edit.undo` |  |

## Edit (10)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Add Image | Images |  | `edit.addImage` |  |
| Delete Image | Images |  | `edit.deleteImage` |  |
| Extract Image | Images |  | `edit.extractImage` |  |
| Move / Resize Image | Images |  | `edit.moveImage` |  |
| Select Image | Images |  | `edit.selectImage` |  |
| Remove Links | Links |  | `edit.removeLinks` |  |
| Add Text | Text |  | `edit.addText` |  |
| Edit Text | Text |  | `edit.editText` |  |
| Erase Area | Text |  | `edit.eraseArea` |  |
| Erase Page Area… | Text |  | `edit.eraseRange` | not in tabs |

## View (41)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Dark Mode | Appearance |  | `view.theme` | has options menu; not in tabs |
| Grayscale | Display |  | `view.grayscale` |  |
| Night Mode | Display |  | `view.nightMode` |  |
| Smooth Scrolling | Display |  | `view.smoothScroll` |  |
| Search Commands | Help | Alt+q | `view.cmdSearch` | not in tabs |
| Full Screen | Modes | F11 | `view.fullScreen` |  |
| Organize Pages | Modes |  | `view.organize` |  |
| Presentation Mode | Modes | F5 | `view.presentation` |  |
| Read Mode | Modes | Ctrl+Shift+r | `view.readMode` |  |
| Book | Page Layout |  | `view.book` |  |
| Continuous | Page Layout |  | `view.continuous` |  |
| Facing Pages | Page Layout |  | `view.facing` |  |
| Single Page | Page Layout |  | `view.single` |  |
| Attachments | Panes |  | `view.attachments` |  |
| Bookmarks | Panes | Ctrl+b | `view.bookmarks` |  |
| Comments | Panes | Ctrl+Shift+c | `view.comments` |  |
| Form Fields | Panes |  | `view.fields` |  |
| Layers | Panes |  | `view.layers` |  |
| Search | Panes | Ctrl+Shift+f | `view.searchPane` |  |
| Signatures | Panes |  | `view.signatures` |  |
| Structure Inspector | Panes |  | `view.inspector` |  |
| Thumbnails | Panes | F4 | `view.thumbnails` |  |
| Add All Quick Access Choices (A–Z) | Quick Access Bar |  | `view.qatAddAll` | not in tabs |
| Hide Quick Access Bar | Quick Access Bar |  | `view.qatHide` | not in tabs |
| Quick Access Bar Labels | Quick Access Bar |  | `view.qatLabels` | not in tabs |
| Quick Access Bar Position | Quick Access Bar |  | `view.qatPosition` | has options menu; not in tabs |
| Show Quick Access Bar | Quick Access Bar |  | `view.qatShow` | not in tabs |
| Collapse the Ribbon | Ribbon | Ctrl+F1 | `view.collapseRibbon` | not in tabs |
| Touch/Mouse Mode | Ribbon |  | `view.touchMode` | not in tabs |
| Rotate View Left | Rotate View | Ctrl+Shift+- | `view.rotateLeft` |  |
| Rotate View Right | Rotate View | Ctrl+Shift+= | `view.rotateRight` |  |
| New Window | Window |  | `view.newWindow` |  |
| Side by Side | Window |  | `view.compareSideBySide` |  |
| Switch Windows | Window | Ctrl+F6 | `view.switchWindow` | has options menu |
| Actual Size | Zoom | Ctrl+1 | `view.actualSize` |  |
| Fit Page | Zoom | Ctrl+0 | `view.fitPage` |  |
| Fit Width | Zoom | Ctrl+2 | `view.fitWidth` |  |
| Zoom In | Zoom | Ctrl+= | `view.zoomIn` |  |
| Zoom Level | Zoom |  | `view.zoomBox` |  |
| Zoom Out | Zoom | Ctrl+- | `view.zoomOut` |  |
| Zoom… | Zoom |  | `view.zoom` |  |

## Comment (47)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Bring to Front | Arrange |  | `comment.toFront` |  |
| Duplicate | Arrange | Ctrl+d | `comment.duplicate` |  |
| Flatten This Annotation | Arrange |  | `comment.flattenOne` |  |
| Send to Back | Arrange |  | `comment.toBack` |  |
| Attach File | Attach |  | `comment.attachFile` |  |
| Audio Comment | Attach |  | `comment.audio` |  |
| Arrow | Drawing |  | `comment.arrow` |  |
| Cloud | Drawing |  | `comment.cloud` |  |
| Ellipse | Drawing |  | `comment.ellipse` |  |
| Highlighter Pen | Drawing |  | `comment.highlighterPen` |  |
| Ink Eraser | Drawing |  | `comment.eraser` |  |
| Line | Drawing |  | `comment.line` |  |
| Pen | Drawing | Ctrl+Alt+p | `comment.pen` |  |
| Polygon | Drawing |  | `comment.polygon` |  |
| Polyline | Drawing |  | `comment.polyline` |  |
| Rectangle | Drawing |  | `comment.rectangle` |  |
| Link | Links |  | `comment.link` |  |
| Delete | Manage | Delete | `comment.delete` |  |
| Delete All Comments | Manage |  | `comment.deleteAll` |  |
| Export Comments (XFDF) | Manage |  | `comment.exportXfdf` |  |
| Flatten Comments | Manage |  | `comment.flatten` |  |
| Hide / Show | Manage |  | `comment.hide` |  |
| Import Comments (XFDF) | Manage |  | `comment.importXfdf` |  |
| Next Comment | Manage | Ctrl+Alt+ArrowRight | `comment.nextComment` | not in tabs |
| Previous Comment | Manage | Ctrl+Alt+ArrowLeft | `comment.prevComment` | not in tabs |
| Properties… | Manage | Ctrl+i | `comment.properties` |  |
| Reply… | Manage |  | `comment.reply` |  |
| Set Status | Manage |  | `comment.setStatus` | has options menu |
| Summarize Comments | Manage |  | `comment.summarize` |  |
| Measure Area | Measure |  | `comment.measureArea` |  |
| Measure Distance | Measure |  | `comment.measure` |  |
| Measurement Scale… | Measure |  | `comment.measureScale` |  |
| Callout | Notes |  | `comment.callout` |  |
| Note | Notes | Ctrl+Alt+n | `comment.note` |  |
| Text Box | Notes |  | `comment.freetext` |  |
| Custom Stamp… | Stamps |  | `comment.customStamp` |  |
| Image Stamp… | Stamps |  | `comment.imageStamp` |  |
| Stamp | Stamps |  | `comment.stamp` | has options menu |
| Author Name… | Style |  | `comment.author` |  |
| Color | Style |  | `comment.color` |  |
| Line Width | Style |  | `comment.lineWidth` | has options menu |
| Opacity | Style |  | `comment.opacity` | has options menu |
| Highlight | Text Markup | Ctrl+Alt+h | `comment.highlight` |  |
| Mark Up Selected Text with a Note | Text Markup |  | `comment.markupFromText` | not in tabs |
| Squiggly Underline | Text Markup |  | `comment.squiggly` |  |
| Strikethrough | Text Markup | Ctrl+Alt+s | `comment.strikeout` |  |
| Underline | Text Markup | Ctrl+Alt+u | `comment.underline` |  |

## Forms (28)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Button | Add Fields |  | `forms.button` |  |
| Check Box | Add Fields |  | `forms.checkbox` |  |
| Date Field | Add Fields |  | `forms.dateField` |  |
| Drop-down | Add Fields |  | `forms.combo` |  |
| List Box | Add Fields |  | `forms.listbox` |  |
| Radio Button | Add Fields |  | `forms.radio` |  |
| Signature Field | Add Fields |  | `forms.signatureField` |  |
| Text Field | Add Fields |  | `forms.textField` |  |
| Field Border… | Appearance |  | `forms.fieldBorder` |  |
| Field Font Size | Appearance |  | `forms.fieldFont` | has options menu |
| Add Missing Tooltips | Edit |  | `forms.widgetTooltips` | not in tabs |
| Calculation Order… | Edit |  | `forms.calcOrder` |  |
| Delete Field | Edit |  | `forms.deleteField` |  |
| Detect Fields | Edit |  | `forms.detect` |  |
| Duplicate Field | Edit |  | `forms.duplicateField` |  |
| Field List | Edit |  | `forms.fieldList` | not in tabs |
| Field Properties… | Edit |  | `forms.properties` |  |
| Tab Order | Edit |  | `forms.tabOrder` | has options menu |
| Clear Field | Fill |  | `forms.clearField` | not in tabs |
| Fill Field… | Fill |  | `forms.fillValue` |  |
| Fill Mode | Fill |  | `forms.fillMode` |  |
| Flatten Form | Fill |  | `forms.flatten` |  |
| Highlight Fields | Fill |  | `forms.highlightFields` |  |
| Reset Form | Fill |  | `forms.reset` |  |
| Export CSV | Form Data |  | `forms.exportCsv` |  |
| Export Form Data… | Form Data |  | `forms.exportData` |  |
| Export JSON | Form Data |  | `forms.exportJson` |  |
| Import Form Data… | Form Data |  | `forms.importData` |  |

## Protect (18)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Confidential Watermark | Final |  | `protect.watermarkConfidential` | not in tabs |
| Mark as Final | Final |  | `protect.markFinal` |  |
| Hidden Information | Hidden Information |  | `protect.hiddenInfo` |  |
| Remove Attachments | Hidden Information |  | `protect.removeAttachments` |  |
| Remove JavaScript | Hidden Information |  | `protect.removeJavaScript` |  |
| Remove Metadata | Hidden Information |  | `protect.removeMetadata` |  |
| Sanitize… | Hidden Information |  | `protect.sanitize` |  |
| Apply Redactions | Redact |  | `protect.applyRedactions` |  |
| Mark Area | Redact |  | `protect.redactArea` |  |
| Mark by Search… | Redact |  | `protect.redactSearch` |  |
| Mark Pages | Redact |  | `protect.redactPages` |  |
| Mark Text | Redact |  | `protect.redactText` |  |
| Redaction Log | Redact |  | `protect.redactLog` |  |
| Change Open Password… | Security |  | `protect.setOpenPassword` | not in tabs |
| Encrypt… | Security |  | `protect.encrypt` |  |
| Permissions… | Security |  | `protect.permissions` |  |
| Remove Security | Security |  | `protect.removeSecurity` |  |
| Security Settings | Security |  | `protect.securityInfo` |  |

## Sign (9)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Check Mark | Fill & Sign |  | `sign.checkmark` |  |
| Cross | Fill & Sign |  | `sign.cross` |  |
| Date | Fill & Sign |  | `sign.dateStamp` |  |
| Initials | Fill & Sign |  | `sign.initials` |  |
| Saved Signatures… | Fill & Sign |  | `sign.manageSignatures` |  |
| Sign | Fill & Sign | Ctrl+Alt+g | `sign.signature` |  |
| Clear Signature Field | Signature Fields |  | `sign.clearSignatureField` | not in tabs |
| Request Signatures… | Signature Fields |  | `sign.requestSignatures` |  |
| Signature Details | Signature Fields |  | `sign.verify` |  |

## Organize Pages (35)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Booklet… | Imposition |  | `organize.booklet` |  |
| N-up… | Imposition |  | `organize.nUp` |  |
| Insert Blank Page | Insert | Ctrl+Shift+b | `organize.insertBlank` |  |
| Insert Blank Pages… | Insert |  | `organize.insertBlankPages` | not in tabs |
| Insert from Clipboard | Insert |  | `organize.insertFromClipboard` |  |
| Insert from File… | Insert |  | `organize.insertFromFile` |  |
| Insert from Images… | Insert |  | `organize.insertFromImages` |  |
| Insert from Text… | Insert |  | `organize.insertFromText` |  |
| Background… | Page Marks |  | `organize.background` |  |
| Bates Numbering… | Page Marks |  | `organize.bates` |  |
| Header and Footer… | Page Marks |  | `organize.headerFooter` |  |
| Image Overlay… | Page Marks |  | `organize.imageOverlay` |  |
| Page Labels… | Page Marks |  | `organize.pageLabels` |  |
| Watermark… | Page Marks |  | `organize.watermark` |  |
| Delete Pages | Pages |  | `organize.delete` |  |
| Duplicate Pages | Pages |  | `organize.duplicate` |  |
| Extract Pages… | Pages |  | `organize.extract` |  |
| Move Pages… | Pages |  | `organize.move` |  |
| Replace Pages… | Pages |  | `organize.replace` |  |
| Reverse Page Order | Pages |  | `organize.reverse` |  |
| Crop… | Rotate and Crop |  | `organize.crop` |  |
| Page Boxes… | Rotate and Crop |  | `organize.pageBoxes` |  |
| Resize Pages… | Rotate and Crop |  | `organize.scale` |  |
| Rotate 180° | Rotate and Crop |  | `organize.rotate180` |  |
| Rotate Left | Rotate and Crop | Ctrl+Shift+ArrowLeft | `organize.rotateLeft` |  |
| Rotate Right | Rotate and Crop | Ctrl+Shift+ArrowRight | `organize.rotateRight` |  |
| Clear Page Selection | Select |  | `organize.selectNone` | not in tabs |
| Select All Pages | Select |  | `organize.selectAll` |  |
| Select Even Pages | Select |  | `organize.selectEven` |  |
| Select Odd Pages | Select |  | `organize.selectOdd` |  |
| Select Pages… | Select |  | `organize.selectRange` |  |
| Combine Files… | Split and Merge |  | `organize.combineFiles` |  |
| Interleave Two Documents… | Split and Merge |  | `organize.interleave` | not in tabs |
| Merge Files… | Split and Merge |  | `organize.merge` |  |
| Split… | Split and Merge |  | `organize.split` |  |

## Scan/OCR (12)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| PDF from Images… | Create |  | `scan.fromImages` |  |
| Scan with Camera | Create |  | `scan.fromCamera` |  |
| Auto-Crop | Enhance Scans |  | `scan.autoCrop` |  |
| Compress Scans… | Enhance Scans |  | `scan.compressScans` |  |
| Deskew | Enhance Scans |  | `scan.deskew` |  |
| Despeckle | Enhance Scans |  | `scan.despeckle` |  |
| Reorder Duplex Scan | Pages |  | `scan.reorder` |  |
| Export Recognized Text | Recognize Text |  | `scan.exportText` |  |
| OCR Cleanup… | Recognize Text |  | `scan.ocrCleanup` |  |
| OCR Languages… | Recognize Text |  | `scan.languages` |  |
| Recognize Text | Recognize Text |  | `scan.recognize` |  |
| Searchable Pages Report | Recognize Text |  | `scan.makeSearchableReport` | not in tabs |

## Review (16)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Accessibility Fixer | Accessibility |  | `review.accessibilityFixer` |  |
| Check Accessibility | Accessibility |  | `review.checkAccessibility` |  |
| Read Aloud | Accessibility | Ctrl+Alt+Space | `review.readAloud` |  |
| Reading Speed | Accessibility |  | `review.readingRate` | has options menu; not in tabs |
| Stop Reading | Accessibility |  | `review.stopReading` |  |
| Archival Check | Checks |  | `review.archivalCheck` |  |
| Compatibility | Checks |  | `review.compatibility` |  |
| Comments as Text | Comments |  | `review.exportComments` | not in tabs |
| Compare… | Compare |  | `review.compare` |  |
| Language… | Language |  | `review.language` |  |
| Look Up | Language | Ctrl+Shift+l | `review.lookUp` |  |
| Translate | Language |  | `review.translate` |  |
| Document Statistics | Proofing |  | `review.statistics` |  |
| Fonts | Proofing |  | `review.fonts` |  |
| Spelling | Proofing | F7 | `review.spelling` |  |
| Spelling Dictionaries | Proofing |  | `review.dictionaries` |  |

## Tools (24)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Attach File… | Attachments |  | `tools.addAttachment` |  |
| Open Attachment | Attachments |  | `tools.openAttachment` | not in tabs |
| Remove Attachment | Attachments |  | `tools.removeAttachment` | not in tabs |
| Save Attachment | Attachments |  | `tools.saveAttachment` | not in tabs |
| Batch Process… | Batch |  | `tools.batch` |  |
| Add Bookmark | Bookmarks | Ctrl+Shift+d | `tools.addBookmark` |  |
| Bookmarks from Headings | Bookmarks |  | `tools.bookmarksFromHeadings` |  |
| Delete All Bookmarks | Bookmarks |  | `tools.deleteBookmarks` |  |
| Delete Bookmark | Bookmarks |  | `tools.deleteBookmark` | not in tabs |
| Edit Bookmark… | Bookmarks |  | `tools.editBookmark` | not in tabs |
| Go to Bookmark | Bookmarks |  | `tools.goToBookmark` | has options menu; not in tabs |
| Edit XMP Metadata… | Convert |  | `tools.editXmp` |  |
| Prepare for Archiving | Convert |  | `tools.toArchival` |  |
| Extract Attachments | Extract |  | `tools.extractAttachments` |  |
| Extract Images | Extract |  | `tools.extractImages` |  |
| Extract Tables | Extract |  | `tools.extractTables` |  |
| Extract Text… | Extract |  | `tools.extractText` |  |
| Fonts Report (Text) | Inspect |  | `tools.fontsReport` | not in tabs |
| Page Info | Inspect |  | `tools.pageInfo` |  |
| Similar Documents | Inspect |  | `tools.similar` |  |
| Compress Images… | Optimize |  | `tools.compressImages` |  |
| Optimize… | Optimize |  | `tools.optimize` |  |
| Reduce File Size | Optimize |  | `tools.reduceSize` | has options menu |
| Rewrite File | Optimize |  | `tools.rewrite` |  |

## AI (28)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Extract Entities | Extract |  | `ai.extractEntities` |  |
| Extract Table | Extract |  | `ai.extractTable` |  |
| Label Form Fields | Extract |  | `ai.classifyFields` |  |
| AI Assistant | More |  | `ai.assistant` |  |
| Prompt Library | More |  | `ai.prompts` | has options menu |
| Describe Page | Review |  | `ai.describePage` |  |
| Suggest Bookmarks | Review |  | `ai.suggestBookmarks` |  |
| Suggest Redactions | Review |  | `ai.suggestRedactions` |  |
| Active AI | Setup |  | `ai.active` | has options menu |
| AI & Privacy | Setup |  | `ai.privacy` |  |
| AI Settings | Setup |  | `ai.settings` | not in tabs |
| Delete Downloaded Models | Setup |  | `ai.deleteModels` | not in tabs |
| Providers & Models | Setup |  | `ai.providers` |  |
| Set Up AI | Setup |  | `ai.setup` |  |
| Stop AI | Setup |  | `ai.stop` |  |
| Choose AIs | Several AIs |  | `ai.ensembleMembers` |  |
| Several AIs | Several AIs |  | `ai.ensembleMode` | has options menu |
| Show AI Discussion | Several AIs |  | `ai.showDeliberation` |  |
| Ask the Document | Understand |  | `ai.askDocument` |  |
| Explain Selection | Understand |  | `ai.explain` |  |
| Key Points | Understand |  | `ai.keyPoints` |  |
| Summarize Document | Understand |  | `ai.summarize` |  |
| Summarize Page | Understand |  | `ai.summarizePage` |  |
| Alt Text for Images | Write |  | `ai.altText` |  |
| Clean OCR Text | Write |  | `ai.cleanOcr` |  |
| Draft Reply | Write |  | `ai.replyComment` |  |
| Rewrite Comment | Write |  | `ai.rewriteComment` |  |
| Translate | Write |  | `ai.translate` |  |

## Developer (10)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| Macro Editor | Code |  | `dev.macroEditor` |  |
| Macro Security | Code |  | `dev.macroSecurity` |  |
| Macros | Code | Alt+F8 | `dev.macros` |  |
| Pause Recording | Code |  | `dev.pauseRecording` |  |
| Record Macro | Code |  | `dev.recordMacro` |  |
| Scripts in This Document | Code |  | `dev.javaScriptInfo` |  |
| Stop Recording | Code |  | `dev.stopRecording` |  |
| Export Structure JSON | Data |  | `dev.exportStructure` |  |
| Raw Object… | Data |  | `dev.rawObject` |  |
| Tag Structure | Data |  | `dev.tags` |  |

## Help (9)

| Command | Group | Shortcut | ID | Notes |
|---|---|---|---|---|
| About Anne's Folio | Help |  | `help.about` |  |
| Check for Updates | Help |  | `help.updates` | not in tabs |
| Command Reference | Help |  | `help.commandReference` |  |
| Help | Help | F1 | `help.help` |  |
| Keyboard Shortcuts | Help |  | `help.shortcuts` |  |
| Report a Problem / Feedback | Help |  | `help.feedback` |  |
| Third-Party Notices | Help |  | `help.notices` |  |
| Tour | Help |  | `help.tour` |  |
| What's New | Help |  | `help.whatsNew` |  |

## Planned, not yet implemented (20)

These ids are in the plan but have no command yet. A command is only registered when it works; nothing below is a placeholder in the app.

- **area**: `area.name`
- **comment**: `comment.caret`, `comment.compareAnnotate`
- **edit**: `edit.editCidText`, `edit.reflow`
- **file**: `file.export.pdfa`, `file.export.svg`
- **forms**: `forms.calculate`, `forms.validate`
- **scan**: `scan.decodeJbig2`, `scan.decodeJpx`
- **sign**: `sign.certificate`, `sign.timestamp`, `sign.verifyCertificate`
- **tools**: `tools.embedFonts`, `tools.linearize`, `tools.pdfa`, `tools.portfolio`
- **view**: `view.grid`, `view.rulers`
