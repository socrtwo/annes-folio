/** Keyboard shortcut names: Mod = Ctrl (Cmd on macOS), canonical order Mod-Ctrl-Alt-Shift-key. */
export function isMac(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
}

export function keyName(e: KeyboardEvent): string | null {
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return null;
  let base = e.key;
  if (base === ' ') base = 'Space';
  if (base.length === 1) base = base.toLowerCase();
  // Use the physical key for Shift+digit/symbol combinations so bindings stay layout-stable.
  if (e.shiftKey && e.code && /^Digit\d$/.test(e.code)) base = e.code.slice(5);
  if (e.code === 'Period') base = '.';
  if (e.code === 'Comma') base = ',';
  if (e.code === 'Equal') base = '=';
  if (e.code === 'Minus') base = '-';
  // With Alt/Option held the key reports the character that modifier types (macOS Cmd+Option+H is "˙", Option+Space
  // a no-break space, AltGr+Q "@"): name the binding by the physical key when the key is not a plain letter or digit.
  if (e.altKey && e.code && (e.key === 'Dead' || (e.key.length === 1 && !/^[a-z0-9 ]$/i.test(e.key)))) {
    if (/^Key[A-Z]$/.test(e.code)) base = e.code.slice(3).toLowerCase();
    else if (/^Digit\d$/.test(e.code)) base = e.code.slice(5);
    else if (e.code === 'Space') base = 'Space';
  }
  const mac = isMac();
  // AltGr (reported as Ctrl+Alt on Windows) and macOS Option type characters such as \ ] } @ ≠:
  // when the key produced something other than its layout-stable base, it is text, not a shortcut.
  const ch = e.key;
  const altGr = !!e.getModifierState?.('AltGraph') || (!e.shiftKey && !e.metaKey && e.altKey && (mac ? !e.ctrlKey : e.ctrlKey));
  if (altGr && ch.length === 1 && ch !== ' ' && ch !== base) return null;
  const parts: string[] = [];
  // On macOS Cmd is Mod and Ctrl stays a separate modifier (Ctrl+A/E/K are native line-editing keys).
  if (e.metaKey && mac) parts.push('Mod');
  if (e.ctrlKey) parts.push(mac ? 'Ctrl' : 'Mod');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(base);
  // Canonical order used by bindings: Mod-Alt-Shift-key
  return parts.join('-');
}

export function canonicalKey(k: string): string {
  const parts = k.split('-');
  const base = parts.pop()!;
  // Ctrl means Mod everywhere except macOS, where it is its own modifier.
  const mac = isMac();
  const mods = new Set(parts.map((p) => (p === 'Cmd' || p === 'Meta' || (p === 'Ctrl' && !mac) ? 'Mod' : p)));
  const out: string[] = [];
  for (const m of ['Mod', 'Ctrl', 'Alt', 'Shift']) if (mods.has(m)) out.push(m);
  out.push(base.length === 1 ? base.toLowerCase() : base);
  return out.join('-');
}

export function prettyKey(k: string): string {
  const mac = isMac();
  return k.split('-').map((p) => (p === 'Mod' ? (mac ? '⌘' : 'Ctrl') : p === 'Ctrl' && mac ? '⌃' : p === 'Alt' ? (mac ? '⌥' : 'Alt') : p === 'Shift' ? (mac ? '⇧' : 'Shift') : p.length === 1 ? p.toUpperCase() : p)).join(mac ? '' : '+');
}
