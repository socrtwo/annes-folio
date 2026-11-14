/**
 * Command registry.
 *
 * Every user-facing action in Anne's Folio is a Command. The ribbon tabs, the Quick Access
 * Bar, context menus, keyboard shortcuts, the command search palette, macros and the
 * customization dialogs all reference commands by id, so anything that exists in the app
 * can be placed anywhere the user wants.
 */
import type { App } from '../app';

export type CommandKind = 'button' | 'toggle' | 'menu' | 'split' | 'font' | 'size' | 'color' | 'gallery' | 'style' | 'combo';

export interface MenuEntry {
  id?: string;           // command id to run
  arg?: any;             // argument passed to the command
  label?: string;        // override label
  icon?: string;
  separator?: boolean;
  checked?: boolean;
  swatch?: string;       // color swatch preview
  preview?: string;      // inline CSS for a preview label
  submenu?: MenuEntry[];
  heading?: string;      // section heading inside a menu
}

export interface Command {
  id: string;
  label: string;
  icon?: string;
  /** Primary tab (category) used by the chooser: "Home", "Insert", ... or "Backstage". */
  tab: string;
  group?: string;
  keys?: string[];
  tip?: string;
  kind?: CommandKind;
  run: (app: App, arg?: any) => unknown;
  isActive?: (app: App) => boolean;
  isEnabled?: (app: App) => boolean;
  /** Menu entries for menu/split/gallery commands. */
  menu?: (app: App) => MenuEntry[];
  /** Do not record while recording a macro (navigation, UI toggles). */
  noRecord?: boolean;
  /**
   * Whether the command changes the document. Anything not marked `edits: false` is refused on a read-only
   * document (App.exec), so viewing, navigation, export, copy, pane and settings commands must say `false`.
   */
  edits?: boolean;
  /** Feature heritage note shown in the command reference (e.g. "WordPerfect Reveal Codes"). */
  origin?: string;
  /** Popular commands appear in the default chooser list. */
  popular?: boolean;
  /** Internal commands are hidden from choosers. */
  internal?: boolean;
  /** Free-text search keywords. */
  keywords?: string;
  /** Current value shown by combo/size boxes (e.g. the zoom level). */
  value?: (app: App) => string | number | null;
}

const registry = new Map<string, Command>();

export function def(c: Command | Command[]): void {
  const list = Array.isArray(c) ? c : [c];
  for (const cmd of list) {
    if (registry.has(cmd.id)) console.warn(`Duplicate command id ${cmd.id}`);
    registry.set(cmd.id, cmd);
  }
}

export function getCommand(id: string): Command | undefined {
  const c = registry.get(id);
  if (c) return c;
  if (id.startsWith('macro:')) {
    const name = id.slice(6);
    // Each step of the macro passes the read-only gate itself.
    return { id, label: name, icon: 'smart_button', tab: 'Macros', group: 'Macros', noRecord: true, edits: false, run: (app) => app.exec('dev.runMacro', name) };
  }
  return undefined;
}

/** Every registered command, internal ones included. */
export function registeredCommands(): Command[] {
  return [...registry.values()];
}

export function allCommands(): Command[] {
  return [...registry.values()].filter((c) => !c.internal);
}

export function commandCount(): number {
  return allCommands().length;
}

export function searchCommands(q: string, limit = 60): Command[] {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return [];
  const scored: { c: Command; s: number }[] = [];
  for (const c of allCommands()) {
    const hay = `${c.label} ${c.tab} ${c.group || ''} ${c.keywords || ''} ${c.tip || ''} ${c.id}`.toLowerCase();
    let s = 0;
    let ok = true;
    for (const t of terms) {
      const i = hay.indexOf(t);
      if (i < 0) { ok = false; break; }
      s += i === 0 ? 10 : c.label.toLowerCase().startsWith(t) ? 8 : c.label.toLowerCase().includes(t) ? 5 : 1;
    }
    if (ok) scored.push({ c, s });
  }
  scored.sort((a, b) => b.s - a.s || a.c.label.localeCompare(b.c.label));
  return scored.slice(0, limit).map((x) => x.c);
}
