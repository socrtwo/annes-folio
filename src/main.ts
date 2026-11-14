/** Anne's Folio entry point. */
import './csp';
import 'material-symbols/outlined.css';
import './styles/app.css';
import './styles/folio.css';
import './ui/scrollcue.css';
import { installFonts } from './fonts';
import './commands';
import { App, recoverableDraftKeys } from './app';
import { Shell } from './ui/shell';
import { launchFile, onFileOpened, onBackButton, isNative, isDesktop, isCapacitor, type OpenedFile } from './platform/native';
import { closeMenus, inDialog, toast } from './ui/dialog';
import { allCommands, getCommand } from './commands/registry';
import { installScrollCues } from './ui/scrollcue';

installFonts();

const host = document.getElementById('app')!;

installScrollCues({
  selector: [
    '.ql-menu', '.ql-dialog-body', '.ql-cmdlist', '.ql-listbox', '.ql-pane-body', '.ql-bs-nav', '.ql-bs-body',
    '.ql-palette-list', '.ql-symbol-grid', '.ql-notices', '.ql-dialog-preview', '.ql-ai-out', '.ql-dict-list', '.qf-rail', '.qf-grid',
  ].join(', '),
});

const app = new App(host);
app.ui = new Shell(app);
app.rebuildKeyIndex();
app.createTab();
app.tab.dirty = false;
app.ui.tabsChanged();

// Hooks for the development console and the end-to-end test. Off in released builds unless switched on by hand:
// localStorage['quillfolio.debugHooks'] = '1'.
const debugHooks = (() => { try { return import.meta.env.DEV || localStorage.getItem('quillfolio.debugHooks') === '1'; } catch { return false; } })();
if (debugHooks) {
  (window as any).qf = app;
  (window as any).__qfAllIds = allCommands().map((c) => c.id);
  (window as any).__qfGetCommand = getCommand;
  (window as any).__qfEngine = () => import('./pdf/document');
  (window as any).__qfBuild = () => import('./pdf/build');
  (window as any).__qfIO = () => import('./io');
  (window as any).__qfStructure = () => import('./pdf/structure');
}

/** Runs fn once no dialog is open: a document opened behind a dialog would change the active document under it. */
function afterDialogs(fn: () => void): void {
  if (!inDialog()) { fn(); return; }
  toast('The file opens when this dialog is closed.', { ms: 4000 });
  const t = setInterval(() => { if (!inDialog()) { clearInterval(t); fn(); } }, 250);
}

// Files dropped on the window open as documents (or insert pages when dropped on the thumbnail rail).
window.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  const files = [...(e.dataTransfer?.files || [])];
  if (!files.length) return;
  e.preventDefault();
  const onRail = !!(e.target as HTMLElement)?.closest?.('.qf-rail, .qf-grid');
  afterDialogs(() => { app.exec(onRail ? 'organize.insertFiles' : 'file.openDropped', files); });
});

async function start() {
  if (!isNative() && /[?&]ql-oauth=/.test(location.search)) {
    try {
      const { handleOAuthRedirect } = await import('./ai/oauth');
      const { setApiKey, saveAiSettings } = await import('./ai/store');
      const ok = await handleOAuthRedirect(async (key) => {
        await setApiKey('openrouter', key);
        saveAiSettings((s) => {
          s.providers.openrouter = s.providers.openrouter || { id: 'openrouter', model: 'openrouter/free', fastModel: 'openrouter/free' };
          if (!s.active) s.active = 'openrouter';
        });
      });
      if (ok) toast('Signed in to OpenRouter and saved the key. You can close this tab and return to Anne\'s Folio.', { ms: 15000 });
    } catch (e: any) {
      toast(`OpenRouter sign-in did not complete: ${e?.message || e}`, { ms: 10000 });
    }
  }
  const { openBuffer } = await import('./commands/file');
  let ready = false;
  const queued: OpenedFile[] = [];
  onFileOpened((f) => { if (ready) afterDialogs(() => { void openBuffer(app, f.data, f.name, f.uri); }); else queued.push(f); });
  const lf = await launchFile();
  if (lf) await openBuffer(app, lf.data, lf.name, lf.uri);
  let openedAny = !!lf || queued.length > 0;
  for (const f of queued.splice(0)) await openBuffer(app, f.data, f.name, f.uri);
  ready = true;
  // Installed web app: files opened with it from the system (manifest file_handlers) arrive on the launch queue.
  const launchQueue = (window as any).launchQueue as { setConsumer(fn: (p: { files?: { getFile(): Promise<File> }[] }) => void): void } | undefined;
  launchQueue?.setConsumer((p) => {
    const handles = [...(p?.files || [])];
    if (!handles.length) return;
    openedAny = true;
    afterDialogs(() => {
      void (async () => {
        for (const h of handles) {
          try { const f = await h.getFile(); await openBuffer(app, await f.arrayBuffer(), f.name, null); }
          catch (e: any) { toast(`Could not open the file: ${e?.message || e}`, { ms: 6000 }); }
        }
      })();
    });
  });
  let drafts: string[] = [];
  try { drafts = await recoverableDraftKeys(app); } catch { /* storage unavailable */ }
  if (drafts.length) toast(`${drafts.length} unsaved document(s) can be recovered.`, { action: 'Recover', onAction: () => app.exec('file.recoverUnsaved'), ms: 8000 });
  if (app.prefs.firstRun && !openedAny) setTimeout(() => { if (!openedAny) void app.ui.tour(); }, 600);
  app.focus();
}
void start();

if (!isNative() && !isCapacitor() && 'serviceWorker' in navigator && /^https?:$/.test(location.protocol) && !import.meta.env.DEV) {
  window.addEventListener('load', () => { navigator.serviceWorker.register('./sw.js').catch(() => undefined); });
}

onBackButton(() => {
  if (document.querySelector('.ql-menu')) { closeMenus(); return true; }
  if (inDialog()) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); return true; }
  if (host.classList.contains('ql-backstage-open')) { app.ui.hideBackstage(); return true; }
  if (app.ui.pane) { app.ui.closePane(); return true; }
  if (app.viewer.presenting) { app.exec('view.presentation'); return true; }
  if (app.viewer.gridMode) { app.exec('view.organize'); return true; }
  if (document.body.classList.contains('ql-fullscreen')) { document.body.classList.remove('ql-fullscreen'); return true; }
  void app.saveDrafts();
  return false;
});

window.addEventListener('beforeunload', (e) => {
  void app.saveDrafts();
  if ((!isNative() || isDesktop()) && app.docs.some((d) => d.dirty)) { e.preventDefault(); e.returnValue = ''; }
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') void app.saveDrafts(); });
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => app.ui.applyPrefs());
