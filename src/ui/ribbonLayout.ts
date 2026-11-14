/**
 * Default tab and group arrangement. Groups reference command ids only, so users can rebuild any of it
 * with Customize Tabs. Contextual tabs appear when an annotation, a form field or text is selected.
 * Command ids follow docs/COMMANDS-PLAN.md.
 */
import type { App } from '../app';

export interface RibbonGroup { id: string; label: string; items: string[]; launcher?: string }
export interface RibbonTab { id: string; label: string; groups: RibbonGroup[]; contextual?: (app: App) => boolean; accent?: string; custom?: boolean }

const annotSelected = (app: App): boolean => { const v = app.tab?.ui; if (!v?.selectedAnnot) return false; const a = (app.viewer as any).annotsOf?.(v.selectedAnnot.page)?.find((x: any) => x.num === v.selectedAnnot!.num); return !!a && a.subtype !== 'Widget'; };
const fieldSelected = (app: App): boolean => { const v = app.tab?.ui; if (!v?.selectedAnnot) return false; const a = (app.viewer as any).annotsOf?.(v.selectedAnnot.page)?.find((x: any) => x.num === v.selectedAnnot!.num); return !!a && a.subtype === 'Widget'; };
const textSelected = (app: App): boolean => !!app.tab?.ui && !!app.tab.ui.selectedText;

export const DEFAULT_TABS: RibbonTab[] = [
  {
    id: 'home', label: 'Home', groups: [
      { id: 'tools', label: 'Tools', items: ['home.select', 'home.hand', 'home.zoomTool', 'home.snapshot'] },
      { id: 'clipboard', label: 'Clipboard', items: ['edit.copy', 'edit.copyImage', 'edit.paste', 'edit.selectAll'] },
      { id: 'navigation', label: 'Pages', items: ['nav.first', 'nav.prev', 'nav.pageNumber', 'nav.next', 'nav.last', 'nav.goTo'] },
      { id: 'zoom', label: 'Zoom', items: ['view.zoomOut', 'view.zoomBox', 'view.zoomIn', 'view.fitWidth', 'view.fitPage', 'view.actualSize'] },
      { id: 'rotate', label: 'Rotate View', items: ['view.rotateLeft', 'view.rotateRight'] },
      { id: 'find', label: 'Find', items: ['edit.find', 'edit.findNext', 'edit.findPrev', 'view.searchPane'] },
      { id: 'quick', label: 'Quick Comment', items: ['comment.highlight', 'comment.note', 'comment.freetext', 'comment.pen'] },
      { id: 'undo', label: 'Undo', items: ['edit.undo', 'edit.redo'] },
    ],
  },
  {
    id: 'edit', label: 'Edit', groups: [
      { id: 'text', label: 'Text', items: ['edit.editText', 'edit.addText', 'edit.eraseArea'] },
      { id: 'images', label: 'Images', items: ['edit.addImage', 'edit.selectImage', 'edit.moveImage', 'edit.deleteImage', 'edit.extractImage'] },
      { id: 'pages', label: 'Pages', items: ['organize.crop', 'organize.rotateRight', 'organize.insertBlank'] },
      { id: 'links', label: 'Links', items: ['comment.link', 'edit.removeLinks'] },
      { id: 'cleanup', label: 'OCR Text', items: ['scan.ocrCleanup'] },
      { id: 'props', label: 'Document', items: ['file.properties', 'tools.editXmp'] },
    ],
  },
  {
    id: 'view', label: 'View', groups: [
      { id: 'layout', label: 'Page Layout', items: ['view.continuous', 'view.single', 'view.facing', 'view.book'] },
      { id: 'panes', label: 'Panes', items: ['view.thumbnails', 'view.bookmarks', 'view.attachments', 'view.layers', 'view.comments', 'view.signatures', 'view.fields', 'view.searchPane', 'view.inspector'] },
      { id: 'zoom', label: 'Zoom', items: ['view.zoom', 'view.fitWidth', 'view.fitPage', 'view.actualSize', 'view.zoomIn', 'view.zoomOut', 'home.zoomTool'] },
      { id: 'rotate', label: 'Rotate View', items: ['view.rotateLeft', 'view.rotateRight'] },
      { id: 'modes', label: 'Modes', items: ['view.readMode', 'view.presentation', 'view.fullScreen', 'view.organize'] },
      { id: 'display', label: 'Display', items: ['view.nightMode', 'view.grayscale', 'forms.highlightFields', 'view.smoothScroll'] },
      { id: 'window', label: 'Window', items: ['view.newWindow', 'view.switchWindow', 'view.compareSideBySide'] },
      { id: 'macros', label: 'Macros', items: ['dev.macros'] },
    ],
  },
  {
    id: 'comment', label: 'Comment', groups: [
      { id: 'markup', label: 'Text Markup', items: ['comment.highlight', 'comment.underline', 'comment.strikeout', 'comment.squiggly'] },
      { id: 'notes', label: 'Notes', items: ['comment.note', 'comment.freetext', 'comment.callout'] },
      { id: 'drawing', label: 'Drawing', items: ['comment.pen', 'comment.highlighterPen', 'comment.eraser', 'comment.line', 'comment.arrow', 'comment.rectangle', 'comment.ellipse', 'comment.polygon', 'comment.polyline', 'comment.cloud'] },
      { id: 'stamps', label: 'Stamps', items: ['comment.stamp', 'comment.customStamp', 'comment.imageStamp'] },
      { id: 'attach', label: 'Attach', items: ['comment.attachFile', 'comment.audio'] },
      { id: 'measure', label: 'Measure', items: ['comment.measure', 'comment.measureArea', 'comment.measureScale'] },
      { id: 'style', label: 'Style', items: ['comment.color', 'comment.opacity', 'comment.lineWidth', 'comment.author'] },
      { id: 'manage', label: 'Manage', items: ['view.comments', 'comment.properties', 'comment.reply', 'comment.setStatus', 'comment.delete', 'comment.deleteAll', 'comment.summarize', 'comment.importXfdf', 'comment.exportXfdf', 'comment.flatten'] },
    ],
  },
  {
    id: 'forms', label: 'Forms', groups: [
      { id: 'fields', label: 'Add Fields', items: ['forms.textField', 'forms.checkbox', 'forms.radio', 'forms.combo', 'forms.listbox', 'forms.button', 'forms.signatureField', 'forms.dateField'] },
      { id: 'edit', label: 'Edit', items: ['forms.properties', 'forms.deleteField', 'view.fields', 'forms.detect', 'forms.tabOrder', 'forms.calcOrder'] },
      { id: 'fill', label: 'Fill', items: ['forms.fillMode', 'forms.fillValue', 'forms.highlightFields', 'forms.reset', 'forms.flatten'] },
      { id: 'data', label: 'Form Data', items: ['forms.exportData', 'forms.importData', 'forms.exportCsv', 'forms.exportJson'] },
    ],
  },
  {
    id: 'protect', label: 'Protect', groups: [
      { id: 'security', label: 'Security', items: ['protect.encrypt', 'protect.permissions', 'protect.removeSecurity', 'protect.securityInfo'] },
      { id: 'redact', label: 'Redact', items: ['protect.redactArea', 'protect.redactText', 'protect.redactSearch', 'protect.redactPages', 'protect.applyRedactions', 'protect.redactLog'] },
      { id: 'sanitize', label: 'Hidden Information', items: ['protect.hiddenInfo', 'protect.sanitize', 'protect.removeMetadata', 'protect.removeAttachments', 'protect.removeJavaScript'] },
      { id: 'final', label: 'Final', items: ['protect.markFinal', 'file.alwaysReadOnly'] },
    ],
  },
  {
    id: 'sign', label: 'Sign', groups: [
      { id: 'fill', label: 'Fill & Sign', items: ['sign.signature', 'sign.initials', 'sign.dateStamp', 'sign.checkmark', 'sign.cross', 'sign.manageSignatures'] },
      { id: 'fields', label: 'Signature Fields', items: ['forms.signatureField', 'sign.requestSignatures', 'view.signatures', 'sign.verify'] },
    ],
  },
  {
    id: 'organize', label: 'Organize Pages', groups: [
      { id: 'view', label: 'View', items: ['view.organize', 'view.thumbnails'] },
      { id: 'insert', label: 'Insert', items: ['organize.insertBlank', 'organize.insertFromFile', 'organize.insertFromImages', 'organize.insertFromClipboard', 'organize.insertFromText'] },
      { id: 'pages', label: 'Pages', items: ['organize.delete', 'organize.replace', 'organize.extract', 'organize.duplicate', 'organize.move', 'organize.reverse'] },
      { id: 'split', label: 'Split and Merge', items: ['organize.split', 'organize.merge', 'organize.combineFiles'] },
      { id: 'rotate', label: 'Rotate and Crop', items: ['organize.rotateLeft', 'organize.rotateRight', 'organize.rotate180', 'organize.crop', 'organize.pageBoxes', 'organize.scale'] },
      { id: 'marks', label: 'Page Marks', items: ['organize.pageLabels', 'organize.headerFooter', 'organize.bates', 'organize.watermark', 'organize.background', 'organize.imageOverlay'] },
      { id: 'imposition', label: 'Imposition', items: ['organize.booklet', 'organize.nUp'] },
      { id: 'select', label: 'Select', items: ['organize.selectAll', 'organize.selectOdd', 'organize.selectEven', 'organize.selectRange'] },
    ],
  },
  {
    id: 'scan', label: 'Scan/OCR', groups: [
      { id: 'create', label: 'Create', items: ['scan.fromImages', 'scan.fromCamera'] },
      { id: 'ocr', label: 'Recognize Text', items: ['scan.recognize', 'scan.languages', 'scan.exportText', 'scan.ocrCleanup'] },
      { id: 'enhance', label: 'Enhance Scans', items: ['scan.deskew', 'scan.despeckle', 'scan.autoCrop', 'scan.compressScans'] },
      { id: 'pages', label: 'Pages', items: ['scan.reorder', 'organize.rotateRight'] },
    ],
  },
  {
    id: 'review', label: 'Review', groups: [
      { id: 'proofing', label: 'Proofing', items: ['review.spelling', 'review.dictionaries', 'review.statistics', 'review.fonts'] },
      { id: 'accessibility', label: 'Accessibility', items: ['review.checkAccessibility', 'review.accessibilityFixer', 'review.readAloud', 'review.stopReading'] },
      { id: 'compare', label: 'Compare', items: ['review.compare', 'view.compareSideBySide'] },
      { id: 'checks', label: 'Checks', items: ['review.archivalCheck', 'review.compatibility'] },
      { id: 'language', label: 'Language', items: ['review.translate', 'review.lookUp', 'review.language'] },
      { id: 'comments', label: 'Comments', items: ['view.comments', 'comment.note', 'comment.summarize'] },
    ],
  },
  {
    id: 'tools', label: 'Tools', groups: [
      { id: 'optimize', label: 'Optimize', items: ['tools.optimize', 'tools.reduceSize', 'tools.compressImages', 'tools.rewrite'] },
      { id: 'extract', label: 'Extract', items: ['tools.extractText', 'tools.extractImages', 'tools.extractTables', 'tools.extractAttachments', 'file.export.images'] },
      { id: 'inspect', label: 'Inspect', items: ['view.inspector', 'tools.pageInfo', 'review.fonts', 'tools.similar'] },
      { id: 'bookmarks', label: 'Bookmarks', items: ['view.bookmarks', 'tools.addBookmark', 'tools.bookmarksFromHeadings', 'tools.deleteBookmarks'] },
      { id: 'attachments', label: 'Attachments', items: ['view.attachments', 'tools.addAttachment'] },
      { id: 'batch', label: 'Batch', items: ['tools.batch'] },
      { id: 'convert', label: 'Convert', items: ['tools.toArchival', 'file.export.text', 'file.export.markdown', 'file.export.html'] },
    ],
  },
  {
    id: 'ai', label: 'AI', groups: [
      { id: 'setup', label: 'Setup', items: ['ai.setup', 'ai.active', 'ai.providers', 'ai.privacy', 'ai.stop'] },
      { id: 'understand', label: 'Understand', items: ['ai.summarize', 'ai.summarizePage', 'ai.explain', 'ai.askDocument', 'ai.keyPoints'] },
      { id: 'extract', label: 'Extract', items: ['ai.extractTable', 'ai.extractEntities', 'ai.classifyFields'] },
      { id: 'write', label: 'Write', items: ['ai.translate', 'ai.rewriteComment', 'ai.replyComment', 'ai.cleanOcr', 'ai.altText'] },
      { id: 'review', label: 'Review', items: ['ai.suggestRedactions', 'ai.describePage', 'ai.suggestBookmarks'] },
      { id: 'more', label: 'More', items: ['ai.assistant', 'ai.prompts'] },
      { id: 'several', label: 'Several AIs', items: ['ai.ensembleMode', 'ai.ensembleMembers', 'ai.showDeliberation'] },
    ],
  },
  {
    id: 'developer', label: 'Developer', groups: [
      { id: 'code', label: 'Code', items: ['dev.macros', 'dev.recordMacro', 'dev.pauseRecording', 'dev.stopRecording', 'dev.macroEditor', 'dev.macroSecurity', 'dev.javaScriptInfo'] },
      { id: 'data', label: 'Data', items: ['dev.exportStructure', 'view.inspector', 'dev.tags', 'dev.rawObject'] },
    ],
  },
  {
    id: 'help', label: 'Help', groups: [
      { id: 'help', label: 'Help', items: ['help.help', 'help.shortcuts', 'help.commandReference', 'help.tour', 'help.whatsNew', 'help.feedback', 'help.notices', 'help.about'] },
    ],
  },
  // Contextual tabs
  {
    id: 'annotation', label: 'Annotation', contextual: annotSelected, accent: '#A6303B', groups: [
      { id: 'edit', label: 'Annotation', items: ['comment.properties', 'comment.reply', 'comment.setStatus', 'comment.hide', 'comment.delete'] },
      { id: 'style', label: 'Style', items: ['comment.color', 'comment.opacity', 'comment.lineWidth'] },
      { id: 'arrange', label: 'Arrange', items: ['comment.duplicate', 'comment.toFront', 'comment.toBack', 'comment.flattenOne'] },
    ],
  },
  {
    id: 'fieldFormat', label: 'Form Field', contextual: fieldSelected, accent: '#2F6F8F', groups: [
      { id: 'field', label: 'Field', items: ['forms.properties', 'forms.fillValue', 'forms.deleteField', 'forms.duplicateField'] },
      { id: 'appearance', label: 'Appearance', items: ['forms.fieldFont', 'forms.fieldBorder'] },
    ],
  },
  {
    id: 'textSelection', label: 'Selected Text', contextual: textSelected, accent: '#3F8F7A', groups: [
      { id: 'copy', label: 'Copy', items: ['edit.copy', 'edit.copyAsMarkdown'] },
      { id: 'markup', label: 'Mark Up', items: ['comment.highlight', 'comment.underline', 'comment.strikeout', 'comment.squiggly', 'comment.link'] },
      { id: 'redact', label: 'Redact', items: ['protect.redactText'] },
      { id: 'insight', label: 'Insight', items: ['review.lookUp', 'review.translate', 'ai.explain', 'review.readAloud'] },
      { id: 'bookmark', label: 'Bookmark', items: ['tools.addBookmark'] },
    ],
  },
];

export const BACKSTAGE_ITEMS = ['file.new', 'file.open', 'file.save', 'file.saveAs', 'file.print', 'file.share', 'file.export.images', 'file.properties', 'file.versions', 'file.close', 'file.options'];

export function tabsFor(app: App): RibbonTab[] {
  const p = app.prefs;
  const order = p.tabOrder.length ? p.tabOrder : [];
  const builtIn = DEFAULT_TABS.filter((t) => !p.hiddenTabs.includes(t.id));
  const custom: RibbonTab[] = p.customTabs.filter((t) => !t.hidden).map((t) => ({ id: t.id, label: t.label, groups: t.groups, custom: true }));
  const all = [...builtIn, ...custom];
  if (!order.length) return all;
  return [...all].sort((a, b) => {
    const ia = order.indexOf(a.id), ib = order.indexOf(b.id);
    return (ia < 0 ? 999 : ia) - (ib < 0 ? 999 : ib);
  });
}

export function idsInTabs(): Set<string> {
  const s = new Set<string>();
  for (const t of DEFAULT_TABS) for (const g of t.groups) for (const id of g.items) s.add(id);
  return s;
}
