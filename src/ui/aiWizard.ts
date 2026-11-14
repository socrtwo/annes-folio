/**
 * AI setup wizard and provider manager.
 *
 * The wizard opens the provider's sign-up, key or billing page in the default browser. It
 * cannot read that browser: the key comes back by
 *   - OpenRouter sign-in (OAuth PKCE): fully automatic, no copy and paste;
 *   - the clipboard: when the user returns to Anne's Folio after copying a key, the wizard reads
 *     the clipboard once (if allowed), recognizes the key by its format, tests it, saves it and
 *     clears it from the clipboard;
 *   - pasting into the key field.
 */
import { h, icon, clear } from './dom';
import { openDialog, toast, confirmDialog } from './dialog';
import type { App } from '../app';
import { PROVIDERS, providerById, detectKey, FREE_LABEL, type ProviderDef } from '../ai/providers';
import { aiSettings, saveAiSettings, getApiKey, setApiKey, deleteApiKey, maskKey, resolveBaseUrl, keyStorage, type ProviderConfig, type KeyStorage } from '../ai/store';
import { signInAvailable, startOpenRouterSignIn } from '../ai/oauth';
import { listModels, pickModels, chat, AiError } from '../ai/client';
import { costNote, normalizeEnsemble, MAX_MEMBERS, type EnsembleMode, type EnsembleSettings } from '../ai/ensemble';
import { openExternal, readClipboardText, writeClipboardText, onAppResume, isNative, isCapacitor } from '../platform/native';
import { escHtml } from '../util/sanitize';

const SECTIONS: { title: string; help: string; ids: string[] }[] = [
  { title: 'Free, no account', help: 'Runs on this device. Nothing you write leaves it.', ids: ['device', 'builtin'] },
  { title: 'Free with a free account', help: 'Cloud models with a free tier. Sign up, create a key, and Anne\'s Folio picks it up.', ids: ['openrouter', 'gemini', 'groq', 'mistral', 'cerebras', 'sambanova', 'zai', 'nvidia', 'cloudflare', 'cohere'] },
  { title: 'On your own computer', help: 'Free open models served from a PC or Mac on your network.', ids: ['ollama', 'lmstudio'] },
  { title: 'Paid services', help: 'Pay-as-you-go keys from the major labs and clouds.', ids: ['openai', 'anthropic', 'deepseek', 'xai', 'perplexity', 'together', 'fireworks', 'huggingface', 'moonshot', 'qwen', 'azure', 'bedrock', 'custom'] },
];

const host = (u: string) => { try { return new URL(u).host; } catch { return u; } };

/** Open the wizard. Resolves true when a provider was configured. */
export async function openAiSetup(app: App, opts: { provider?: string; reason?: string } = {}): Promise<boolean> {
  let configured = false;
  const root = h('div', { class: 'ql-ai-wizard' });
  let cleanup: (() => void)[] = [];
  const reset = () => { cleanup.forEach((f) => f()); cleanup = []; };

  const showChooser = () => {
    reset();
    clear(root);
    if (opts.reason) root.append(h('p', { class: 'ql-ai-reason' }, opts.reason));
    root.append(h('p', { class: 'ql-help' }, 'Pick where Anne\'s Folio\'s AI features should run. You can add several and switch at any time (AI ▸ Providers & Models).'));
    const s = aiSettings();
    for (const sec of SECTIONS) {
      root.append(h('h3', null, sec.title), h('p', { class: 'ql-help' }, sec.help));
      const grid = h('div', { class: 'ql-ai-cards' });
      for (const id of sec.ids) {
        const p = providerById(id)!;
        const have = !!s.providers[id];
        grid.append(h('button', { class: 'ql-ai-card' + (have ? ' ql-on' : ''), onclick: () => showProvider(p) },
          h('div', { class: 'ql-ai-card-head' }, h('b', null, p.name), h('span', { class: `ql-ai-badge ql-ai-${p.free}` }, FREE_LABEL[p.free])),
          h('div', { class: 'ql-help' }, p.freeNote),
          have ? h('div', { class: 'ql-ai-set' }, icon('check_circle'), s.active === id ? ' Active' : ' Set up') : null));
      }
      root.append(grid);
    }
  };

  const showProvider = (p: ProviderDef) => {
    reset();
    clear(root);
    root.append(h('button', { class: 'ql-link', onclick: showChooser }, '‹ All providers'));
    root.append(h('h3', null, p.name, ' ', h('span', { class: `ql-ai-badge ql-ai-${p.free}` }, FREE_LABEL[p.free])), h('p', { class: 'ql-help' }, p.freeNote));
    if (p.notes) root.append(h('p', { class: 'ql-warn' }, p.notes));
    if (p.cors === 'no' && !isNative() && !isCapacitor()) root.append(h('p', { class: 'ql-warn' }, 'This service blocks calls from web browsers. Set it up in the Android, iOS or desktop app, or choose another provider here.'));
    if (p.kind === 'local') return showDevice(p);
    if (p.kind === 'builtin') return showBuiltin(p);
    showKeyed(p);
  };

  // ---------------------------------------------------------------- key-based providers
  const showKeyed = (p: ProviderDef) => {
    const existing = aiSettings().providers[p.id];
    const status = h('div', { class: 'ql-ai-status', role: 'status' });
    const say = (msg: string, kind: 'info' | 'ok' | 'err' = 'info') => { status.className = `ql-ai-status ql-ai-${kind}`; status.textContent = msg; };
    const fieldEls: Record<string, HTMLInputElement> = {};
    let fromClipboard = false;
    let waiting = false;

    // Purpose buttons: each opens the right page in the default browser.
    const open = (url: string | undefined, msg: string) => {
      if (!url) return;
      waiting = true;
      openExternal(url);
      say(msg);
    };
    const actions = h('div', { class: 'ql-ai-actions' });
    // Sign-in comes back through the page address (browser) or the native plugin's local listener (Android,
    // desktop). In the Capacitor shell without that plugin (iOS) neither exists, so the button is not offered.
    if (p.oauth === 'openrouter' && signInAvailable()) {
      actions.append(h('button', { class: 'ql-btn ql-primary', onclick: () => void signInOpenRouter() }, icon('login'), ' Sign in with OpenRouter (no copying)'));
    }
    if (p.links.download) actions.append(h('button', { class: 'ql-btn', onclick: () => open(p.links.download, `Install ${p.name} on your computer, start it, then come back and press Test & Save.`) }, icon('download'), ' Download'));
    if (p.needsKey && p.links.keys) {
      if (p.free === 'free' || p.free === 'trial') {
        actions.append(h('button', { class: 'ql-btn', onclick: () => open(p.links.keys || p.links.signup, `Create a free account if asked, create an API key, and copy it. Then come back here${aiSettings().clipboardWatch ? ': Anne\'s Folio will pick the key up from the clipboard' : ' and paste it below'}.`) }, icon('key'), ' Create a free key'));
      }
      actions.append(h('button', { class: 'ql-btn', onclick: () => open(p.links.billing || p.links.keys, `Add a payment method or credits, then create an API key and copy it. Come back here when it is copied.`) }, icon('credit_card'), p.free === 'paid' ? ' Create a paid key' : ' Upgrade to paid'));
      actions.append(h('button', { class: 'ql-btn', onclick: () => open(p.links.keys, p.keyViewable ? 'Copy your existing key from the list, then come back here.' : `${p.name} shows each key only once, when it is created. If you no longer have it, create a new key (and delete the old one), copy it, and come back.`) }, icon('manage_search'), ' Find my existing key'));
    }
    actions.append(h('button', { class: 'ql-link', onclick: () => openExternal(p.links.docs) }, 'Documentation'));
    root.append(actions);

    // Extra fields
    for (const f of p.fields || []) {
      const input = h('input', { type: 'text', class: 'ql-input', placeholder: f.placeholder, value: (existing as any)?.[f.key] || (f.key === 'baseUrl' ? p.baseUrl : '') }) as HTMLInputElement;
      fieldEls[f.key] = input;
      root.append(h('label', { class: 'ql-field' }, h('span', null, f.label), input, f.help ? h('small', { class: 'ql-help' }, f.help) : null));
    }

    // Key field
    const keyInput = h('input', { type: 'password', class: 'ql-input', autocomplete: 'new-password', spellcheck: 'false', placeholder: p.needsKey ? 'Paste the API key here' : 'API key (optional)' }) as HTMLInputElement;
    const showBtn = h('button', { class: 'ql-iconbtn', title: 'Show or hide', onclick: () => { keyInput.type = keyInput.type === 'password' ? 'text' : 'password'; } }, icon('visibility'));
    const pasteBtn = h('button', { class: 'ql-btn', onclick: () => void fromClip(true) }, icon('content_paste'), ' Paste');
    if (p.needsKey || p.id === 'custom' || p.id === 'lmstudio' || p.id === 'ollama') {
      // Where the key will be kept on this device, said before it is entered; a warning when it is not encrypted or does not last.
      const where = h('small', { class: 'ql-help ql-ai-keynote' });
      root.append(h('label', { class: 'ql-field' }, h('span', null, p.keyLabel || 'API key'), h('div', { class: 'ql-row' }, keyInput, showBtn, pasteBtn)), where);
      void keyStorage().then((k) => { where.textContent = k.note; if (!k.encrypted || !k.persistent) where.className = 'ql-warn ql-ai-keynote'; }).catch(() => undefined);
      void getApiKey(p.id).then((k) => { if (k) { keyInput.placeholder = `Saved key ${maskKey(k)} (leave empty to keep)`; } });
    }
    const watch = h('input', { type: 'checkbox', checked: aiSettings().clipboardWatch, onchange: () => saveAiSettings((s) => { s.clipboardWatch = watch.checked; }) }) as HTMLInputElement;
    if (p.needsKey) root.append(h('label', { class: 'ql-check' }, watch, ' When I come back to Anne\'s Folio, look for the copied key in the clipboard'));
    const makeActive = h('input', { type: 'checkbox', checked: !aiSettings().active || aiSettings().active === p.id }) as HTMLInputElement;
    root.append(h('label', { class: 'ql-check' }, makeActive, ' Use this provider for AI commands'));
    root.append(h('div', { class: 'ql-row' }, h('button', { class: 'ql-btn ql-primary', onclick: () => void testAndSave() }, icon('verified'), ' Test & Save')), status);

    const fromClip = async (manual: boolean) => {
      const text = await readClipboardText();
      if (text == null) { if (manual) say('The clipboard could not be read here. Long-press the key field and choose Paste.', 'err'); return; }
      const hit = detectKey(text, p.id);
      if (hit && hit.provider === p.id) {
        keyInput.value = hit.key;
        fromClipboard = true;
        // A key with no distinctive prefix is only a guess (any 32- or 40-character token matches): it is put
        // in the field, but nothing from the clipboard is sent to the service until the user says so.
        if (p.weakKey) { say(`The clipboard holds text that could be a ${p.name} key (${maskKey(hit.key)}). It is in the key field; press Test & Save if it is the key.`); return; }
        say(`Found a ${p.name} key in the clipboard (${maskKey(hit.key)}). Testing…`);
        await testAndSave();
      } else if (hit) {
        const other = providerById(hit.provider)!;
        say(`The clipboard holds what looks like a ${other.name} key, not a ${p.name} key.`, 'err');
        status.append(' ', h('button', { class: 'ql-link', onclick: () => { showProvider(other); } }, `Set up ${other.name} instead`));
      } else if (manual && text.trim()) {
        keyInput.value = text.trim();
        say('Pasted. Press Test & Save.');
      } else if (manual) say('The clipboard is empty.', 'err');
    };

    // Returning from the browser: look for the key once.
    cleanup.push(onAppResume(() => {
      if (!waiting || !aiSettings().clipboardWatch) return;
      waiting = false;
      setTimeout(() => void fromClip(false), 450);
    }));

    const cfgFromFields = (): ProviderConfig => {
      const cfg: ProviderConfig = { ...(existing || { id: p.id, model: p.models.quality, fastModel: p.models.fast }) };
      for (const f of p.fields || []) (cfg as any)[f.key] = fieldEls[f.key].value.trim() || undefined;
      return cfg;
    };

    const testAndSave = async () => {
      const cfg = cfgFromFields();
      const key = keyInput.value.trim() || (await getApiKey(p.id));
      if (p.needsKey && !key && p.id !== 'custom') { say('Enter or paste the API key first.', 'err'); return; }
      if (p.id === 'custom' && !cfg.baseUrl) { say('Enter the base URL of the service.', 'err'); return; }
      say('Contacting ' + host(resolveBaseUrl(p, cfg)) + '…');
      try {
        const models = await listModels({ def: p, cfg, key, baseUrl: resolveBaseUrl(p, cfg) });
        const picked = pickModels(p, models);
        cfg.models = models.slice(0, 500);
        if (!existing || !models.includes(cfg.model)) cfg.model = picked.quality;
        if (!existing || !cfg.fastModel || !models.includes(cfg.fastModel)) cfg.fastModel = picked.fast;
        cfg.verified = Date.now();
        const stored = key ? await setApiKey(p.id, key) : null;
        saveAiSettings((s) => { s.providers[p.id] = cfg; if (makeActive.checked || !s.active) s.active = p.id; });
        configured = true;
        if (fromClipboard && aiSettings().clearClipboard) {
          if (await writeClipboardText('', true)) toast('Key saved and removed from the clipboard');
        }
        showDone(p, stored);
      } catch (e: any) {
        const msg = e instanceof AiError ? e.message : String(e?.message || e);
        say(msg, 'err');
      }
    };

    const signInOpenRouter = async () => {
      try {
        const session = await startOpenRouterSignIn();
        if (session.opened) say('Sign in on openrouter.ai in your browser. Anne\'s Folio receives the key automatically when you approve.');
        else {
          // A pop-up blocker stopped the tab: a link the user clicks is always allowed.
          say('The browser did not open the sign-in page. ', 'err');
          status.append(h('button', { class: 'ql-link', type: 'button', onclick: () => openExternal(session.url) }, 'Open the OpenRouter sign-in page'), ' and approve there; Anne\'s Folio then receives the key.');
        }
        const manual = h('input', { type: 'text', class: 'ql-input', placeholder: 'If nothing happens: paste the address from the browser (…?code=…) here' }) as HTMLInputElement;
        const go = h('button', { class: 'ql-btn', onclick: () => session.complete(manual.value).catch((err) => say(String(err.message || err), 'err')) }, 'Finish');
        root.querySelector('.ql-ai-manual')?.remove(); // one row, however often the button is pressed
        status.after(h('div', { class: 'ql-row ql-ai-manual' }, manual, go));
        cleanup.push(() => session.cancel());
        const key = await session.key;
        keyInput.value = key;
        say('Signed in. Testing the key…', 'ok');
        await testAndSave();
      } catch (e: any) {
        if (String(e?.message) !== 'Canceled') say(`Sign-in did not complete: ${e?.message || e}`, 'err');
      }
    };

    // Enter in the key field tests and saves the key (the dialog's own Enter would only close the wizard).
    keyInput.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); void testAndSave(); } });
    if (opts.provider === p.id) setTimeout(() => keyInput.focus(), 50);
  };

  // ---------------------------------------------------------------- on-device model
  const showDevice = (p: ProviderDef) => {
    void (async () => {
      const { LOCAL_MODELS, loadLocalModel, onLocalProgress } = await import('../ai/local');
      const cur = aiSettings().providers.device?.model || LOCAL_MODELS[0].id;
      let gpu = 'checking…';
      const gpuLine = h('p', { class: 'ql-help' }, `WebGPU: ${gpu}`);
      try {
        const a = await (navigator as any).gpu?.requestAdapter?.();
        gpu = a ? 'available (faster)' : 'not available — the model will run on the CPU (slower)';
      } catch { gpu = 'not available — the model will run on the CPU (slower)'; }
      gpuLine.textContent = `WebGPU: ${gpu}`;
      const list = h('div', { class: 'ql-ai-models' });
      for (const m of LOCAL_MODELS) {
        list.append(h('label', { class: 'ql-check' }, h('input', { type: 'radio', name: 'ql-local-model', value: m.id, checked: m.id === cur }), ' ', h('b', null, m.label), ` · ${m.size}`, h('div', { class: 'ql-help' }, m.note)));
      }
      const bar = h('progress', { max: 100, value: 0, class: 'ql-ai-progress', hidden: true }) as HTMLProgressElement;
      const status = h('div', { class: 'ql-ai-status', role: 'status' });
      const btn = h('button', { class: 'ql-btn ql-primary' }, icon('download'), ' Download and start');
      root.append(gpuLine, list, h('p', { class: 'ql-help' }, 'The first start downloads the AI library from cdn.jsdelivr.net and the model from huggingface.co. After that it works offline. Use Wi-Fi: the files are large.'), btn, bar, status);
      btn.onclick = async () => {
        const model = (list.querySelector('input:checked') as HTMLInputElement)?.value || LOCAL_MODELS[0].id;
        btn.setAttribute('disabled', '');
        bar.hidden = false;
        const files = new Map<string, { loaded: number; total: number }>();
        const off = onLocalProgress((pr) => {
          if (pr.file && pr.total) files.set(pr.file, { loaded: pr.loaded || 0, total: pr.total });
          let l = 0, t = 0;
          files.forEach((f) => { l += f.loaded; t += f.total; });
          if (t) { bar.value = Math.round((l / t) * 100); status.textContent = `Downloading ${(l / 1048576).toFixed(0)} of ${(t / 1048576).toFixed(0)} MB…`; }
          if (pr.status === 'ready') status.textContent = 'Starting the model…';
        });
        cleanup.push(off);
        try {
          const info = await loadLocalModel(model);
          saveAiSettings((s) => { s.providers.device = { id: 'device', model, fastModel: model, verified: Date.now() }; s.active = 'device'; });
          configured = true;
          status.textContent = `Ready (running with ${info.device === 'webgpu' ? 'WebGPU' : 'WebAssembly on the CPU'}, ${info.dtype}).`;
          showDone(p);
        } catch (e: any) {
          status.className = 'ql-ai-status ql-ai-err';
          status.textContent = String(e?.message || e);
          btn.removeAttribute('disabled');
        } finally { off(); }
      };
    })();
  };

  // ---------------------------------------------------------------- browser built-in model
  const showBuiltin = (p: ProviderDef) => {
    const status = h('div', { class: 'ql-ai-status', role: 'status' });
    const btn = h('button', { class: 'ql-btn ql-primary' }, icon('memory'), ' Check and enable');
    root.append(btn, status);
    btn.onclick = async () => {
      const LM = (globalThis as any).LanguageModel;
      if (!LM) { status.textContent = 'Not available in this browser. It requires desktop Chrome 148 or later (Windows, macOS, Linux, Chromebook Plus) with about 22 GB free disk and 16 GB of memory. Choose another option.'; return; }
      try {
        const a = await LM.availability();
        if (a === 'unavailable') { status.textContent = 'This device does not meet the requirements for the built-in model.'; return; }
        if (a !== 'available') {
          status.textContent = 'Downloading the browser\'s model…';
          const s = await LM.create({ monitor: (m: any) => m.addEventListener('downloadprogress', (e: any) => { status.textContent = `Downloading the browser's model… ${Math.round((e.loaded || 0) * 100)}%`; }) });
          s.destroy?.();
        }
        saveAiSettings((s) => { s.providers.builtin = { id: 'builtin', model: 'default', verified: Date.now() }; s.active = 'builtin'; });
        configured = true;
        showDone(p);
      } catch (e: any) { status.textContent = String(e?.message || e); }
    };
  };

  // ---------------------------------------------------------------- finished
  const showDone = (p: ProviderDef, stored: KeyStorage | null = null) => {
    reset();
    clear(root);
    const cfg = aiSettings().providers[p.id];
    root.append(h('h3', null, icon('check_circle'), ` ${p.name} is ready`));
    // Where the key went, said loudly when it is not encrypted or will be gone when the tab closes.
    if (stored) root.append(h('p', { class: stored.encrypted && stored.persistent ? 'ql-help' : 'ql-warn' }, stored.note));
    if (cfg?.models?.length && p.kind !== 'local' && p.kind !== 'builtin') {
      const sel = (val: string, onch: (v: string) => void) => {
        const s = h('select', { class: 'ql-input', onchange: (e: Event) => onch((e.target as HTMLSelectElement).value) }) as HTMLSelectElement;
        for (const m of cfg.models!) s.append(h('option', { value: m, selected: m === val }, m));
        if (!cfg.models!.includes(val)) s.prepend(h('option', { value: val, selected: true }, val));
        return s;
      };
      root.append(
        h('label', { class: 'ql-field' }, h('span', null, 'Model for writing and analysis'), sel(cfg.model, (v) => saveAiSettings((s) => { s.providers[p.id].model = v; }))),
        h('label', { class: 'ql-field' }, h('span', null, 'Model for quick tasks'), sel(cfg.fastModel || cfg.model, (v) => saveAiSettings((s) => { s.providers[p.id].fastModel = v; }))));
    }
    const out = h('div', { class: 'ql-ai-try' });
    root.append(
      h('p', { class: 'ql-help' }, p.kind === 'local' || p.kind === 'builtin'
        ? 'Text you send to AI commands is processed on this device.'
        : `When you use an AI command, Anne's Folio sends the text it needs directly from this device to ${host(resolveBaseUrl(p, cfg || {}))}. Anne's Folio has no server of its own. ${p.name}'s terms and privacy policy apply${p.free === 'free' ? '; free tiers may use prompts to improve their models' : ''}.`),
      h('div', { class: 'ql-row' },
        h('button', { class: 'ql-btn', onclick: async () => {
          out.textContent = '…';
          try { await chat({ provider: p.id, tier: 'fast', messages: [{ role: 'user', content: 'Reply with one short friendly sentence confirming you are working.' }], maxTokens: 60, onToken: (_d, full) => { out.textContent = full; } }); }
          catch (e: any) { out.textContent = String(e?.message || e); }
        } }, icon('play_arrow'), ' Try it'),
        h('button', { class: 'ql-btn', onclick: showChooser }, 'Add another provider')),
      out);
  };

  if (opts.provider && providerById(opts.provider)) showProvider(providerById(opts.provider)!);
  else showChooser();
  await openDialog({ title: 'Set Up AI', content: root, wide: true, ok: 'Done', cancel: false });
  reset();
  app.ui.refresh?.();
  return configured || !!aiSettings().active;
}

/** Providers & Models: switch, test, change keys, remove; and AI options. */
export async function openAiProviders(app: App): Promise<void> {
  const root = h('div', { class: 'ql-ai-wizard' });
  const draw = async () => {
    clear(root);
    const s = aiSettings();
    const ids = Object.keys(s.providers);
    if (!ids.length) root.append(h('p', null, 'No AI provider is set up yet.'));
    for (const id of ids) {
      const p = providerById(id);
      if (!p) continue;
      const cfg = s.providers[id];
      const key = p.needsKey ? await getApiKey(id) : '';
      const status = h('span', { class: 'ql-help' });
      root.append(h('div', { class: 'ql-ai-prov' + (s.active === id ? ' ql-on' : '') },
        h('label', { class: 'ql-check' }, h('input', { type: 'radio', name: 'ql-ai-active', checked: s.active === id, onchange: () => { saveAiSettings((x) => { x.active = id; }); void draw(); } }), ' ', h('b', null, p.name)),
        h('div', { class: 'ql-help' }, `Model: ${cfg.model}${cfg.fastModel && cfg.fastModel !== cfg.model ? ` · quick tasks: ${cfg.fastModel}` : ''}${key ? ` · key ${maskKey(key)}` : ''}`),
        h('div', { class: 'ql-row' },
          h('button', { class: 'ql-btn ql-sm', onclick: async () => { status.textContent = 'Testing…'; try { const r = await chat({ provider: id, tier: 'fast', messages: [{ role: 'user', content: 'Reply with OK.' }], maxTokens: 10 }); status.textContent = `Working (${r.model}): ${r.text.slice(0, 40)}`; } catch (e: any) { status.textContent = String(e?.message || e); } } }, 'Test'),
          h('button', { class: 'ql-btn ql-sm', onclick: async () => { await openAiSetup(app, { provider: id }); void draw(); } }, 'Change'),
          h('button', { class: 'ql-btn ql-sm', onclick: async () => {
            if (!(await confirmDialog('Remove Provider', `Remove ${p.name} and delete its saved key from this device?`, 'Remove'))) return;
            await deleteApiKey(id);
            saveAiSettings((x) => { delete x.providers[id]; if (x.active === id) x.active = Object.keys(x.providers)[0] || null; });
            void draw();
          } }, 'Remove'),
          status)));
    }
    root.append(h('div', { class: 'ql-row' }, h('button', { class: 'ql-btn ql-primary', onclick: async () => { await openAiSetup(app); void draw(); } }, icon('add'), ' Add a provider')));
  };
  await draw();
  await openDialog({ title: 'AI Providers & Models', content: root, wide: true, ok: 'Close', cancel: false });
  app.ui.refresh?.();
}

// ------------------------------------------------------------------------------------------
// AI Settings ▸ Use several AIs

/** The "Use several AIs" section. Edits `draft` in place; the caller saves it when the dialog is confirmed. */
function ensembleSection(app: App, draft: EnsembleSettings, preferMode?: EnsembleMode): HTMLElement {
  const s = aiSettings();
  const ids = Object.keys(s.providers).filter((id) => providerById(id));
  const name = (id: string) => providerById(id)?.name || id;
  const onDevice = (id: string) => { const k = providerById(id)?.kind; return k === 'local' || k === 'builtin'; };
  const root = h('section', { class: 'ql-ai-wizard ql-ai-ens', 'aria-label': 'Use several AIs', style: 'display:flex;flex-direction:column;gap:8px;margin-top:6px;border-top:1px solid var(--border, #ddd)' });
  root.append(h('h3', null, icon('groups'), ' Use several AIs'),
    h('p', { class: 'ql-help' }, 'Send each AI command to more than one AI. Either one AI (the master) reads all the answers and writes the best one, or the AIs discuss the answer like a Quaker business meeting: a clerk words the answer, each AI unites with it, stands aside, or blocks it, and the clerk revises until no one blocks.'));
  if (ids.length < 2) {
    draft.mode = 'single';
    root.append(h('p', { class: 'ql-help' }, ids.length ? `Only ${name(ids[0])} is set up. Set up at least one more provider to use several AIs at once.` : 'Set up at least two AI providers to use several AIs at once.'),
      h('button', { class: 'ql-btn', type: 'button', onclick: () => void openAiSetup(app) }, icon('add'), ' Add a provider'));
    return root;
  }
  let lastMode: Exclude<EnsembleMode, 'single'> = draft.mode !== 'single' ? draft.mode : preferMode && preferMode !== 'single' ? preferMode : 'master';
  if (preferMode && preferMode !== 'single') draft.mode = preferMode;
  if (!draft.master || !s.providers[draft.master]) draft.master = draft.members.find((m) => s.providers[m.provider])?.provider || s.active || ids[0];
  draft.members = draft.members.filter((m) => s.providers[m.provider]);

  const enable = h('input', { type: 'checkbox', checked: draft.mode !== 'single' }) as HTMLInputElement;
  const boxes = new Map<string, HTMLInputElement>();
  const modelSel = new Map<string, HTMLSelectElement>();
  const list = h('div', { class: 'ql-ai-ens-members' });
  for (const id of ids) {
    const cfg = s.providers[id];
    const m = draft.members.find((x) => x.provider === id);
    const cb = h('input', { type: 'checkbox', checked: !!m, 'aria-label': `Use ${name(id)}` }) as HTMLInputElement;
    const sel = h('select', { class: 'ql-input ql-sm', 'aria-label': `Model for ${name(id)}` }) as HTMLSelectElement;
    sel.append(h('option', { value: '' }, `Default (${cfg.model})`));
    for (const x of [...new Set([cfg.model, cfg.fastModel, ...(cfg.models || [])].filter(Boolean) as string[])].slice(0, 400)) sel.append(h('option', { value: x }, x));
    if (m?.model && ![...sel.options].some((o) => o.value === m.model)) sel.append(h('option', { value: m.model }, m.model));
    sel.value = m?.model || '';
    boxes.set(id, cb);
    modelSel.set(id, sel);
    cb.addEventListener('change', () => update());
    sel.addEventListener('change', () => update());
    list.append(h('div', { class: 'ql-row', style: 'align-items:center;gap:8px;flex-wrap:wrap;margin:4px 0' }, h('label', { class: 'ql-check', style: 'flex:1;min-width:180px' }, cb, ' ', name(id)), sel));
  }
  const modeRadios = (['master', 'consensus'] as const).map((v) => h('input', { type: 'radio', name: 'ql-ai-ens-mode', value: v, checked: lastMode === v }) as HTMLInputElement);
  const master = h('select', { class: 'ql-input', 'aria-label': 'Master / clerk' }) as HTMLSelectElement;
  for (const id of ids) master.append(h('option', { value: id, selected: id === draft.master }, name(id)));
  const rounds = h('input', { type: 'number', class: 'ql-input', min: '1', max: '5', step: '1', value: String(draft.maxRounds), 'aria-label': 'Rounds of discussion' }) as HTMLInputElement;
  const show = h('input', { type: 'checkbox', checked: draft.showDeliberation }) as HTMLInputElement;
  const wait = h('input', { type: 'number', class: 'ql-input', min: '5', max: '600', step: '5', value: String(Math.round(draft.memberTimeoutMs / 1000)), 'aria-label': 'Seconds to wait for each AI' }) as HTMLInputElement;
  const roundsRow = h('label', { class: 'ql-field' }, h('span', { class: 'ql-label' }, 'Rounds of discussion'), rounds);
  const cost = h('p', { class: 'ql-help ql-ai-ens-cost' });
  const privacy = h('p', { class: 'ql-help ql-ai-ens-privacy' });
  const need = h('p', { class: 'ql-warn ql-ai-ens-need' });
  for (const el of [...modeRadios, master, rounds, show, wait, enable]) el.addEventListener('change', () => update());

  const update = () => {
    draft.members = ids.filter((id) => boxes.get(id)!.checked).map((id) => (modelSel.get(id)!.value ? { provider: id, model: modelSel.get(id)!.value } : { provider: id }));
    const n = draft.members.length;
    for (const [id, cb] of boxes) cb.disabled = !cb.checked && n >= MAX_MEMBERS;
    for (const [id, sel] of modelSel) sel.disabled = !boxes.get(id)!.checked;
    lastMode = (modeRadios.find((r) => r.checked)?.value as 'master' | 'consensus') || lastMode;
    enable.disabled = n < 2;
    if (n < 2) enable.checked = false;
    draft.mode = enable.checked ? lastMode : 'single';
    draft.master = master.value;
    draft.maxRounds = Math.min(5, Math.max(1, Math.round(Number(rounds.value) || 3)));
    draft.showDeliberation = show.checked;
    draft.memberTimeoutMs = Math.min(600, Math.max(5, Math.round(Number(wait.value) || 90))) * 1000;
    roundsRow.style.display = lastMode === 'consensus' ? '' : 'none';
    need.textContent = n < 2 ? 'Tick at least two AIs to use several AIs.' : '';
    need.style.display = n < 2 ? '' : 'none';
    cost.textContent = n >= 2 ? costNote(n, draft.maxRounds) : '';
    const to = draft.mode === 'single' ? [s.active || ids[0]] : [...new Set([...draft.members.map((m) => m.provider), draft.master])];
    const cloud = to.filter((id) => !onDevice(id));
    privacy.textContent = draft.mode === 'single'
      ? `Privacy: only the active provider (${name(to[0])}) receives the text an AI command sends.`
      : `Privacy: the text an AI command sends goes to every one of these services: ${to.map((id) => `${name(id)}${onDevice(id) ? ' (on this device)' : ''}`).join(', ')}.${cloud.length ? ' Each cloud service\'s terms and privacy policy apply.' : ''}`;
  };

  root.append(
    h('div', { class: 'ql-field' }, h('span', { class: 'ql-label' }, 'AIs that answer'), list),
    need,
    h('label', { class: 'ql-check' }, enable, ' Use several AIs for AI commands'),
    h('div', { class: 'ql-field', role: 'radiogroup', 'aria-label': 'When several AIs answer' }, h('span', { class: 'ql-label' }, 'When several AIs answer'),
      h('label', { class: 'ql-check' }, modeRadios[0], ' One AI combines the answers (master)'),
      h('label', { class: 'ql-check' }, modeRadios[1], ' The AIs deliberate until they agree (Quaker consensus)')),
    h('div', { class: 'ql-row2' }, h('label', { class: 'ql-field' }, h('span', { class: 'ql-label' }, 'Master / clerk'), master), roundsRow),
    h('label', { class: 'ql-field' }, h('span', { class: 'ql-label' }, 'Seconds to wait for each AI (one that does not answer is left out)'), wait),
    h('label', { class: 'ql-check' }, show, ' Show the discussion'),
    cost, privacy);
  update();
  return root;
}

/** AI options. `section: 'ensemble'` scrolls to "Use several AIs"; `mode` preselects how several AIs answer. */
export async function openAiSettings(app: App, opts: { section?: 'ensemble'; mode?: EnsembleMode } = {}): Promise<void> {
  const s = aiSettings();
  const s0 = normalizeEnsemble(s.ensemble);
  const draft = normalizeEnsemble(s.ensemble);
  // Stored settings are numbers, but they come from localStorage: shown as numbers and escaped, whatever is there.
  const count = (v: unknown) => escHtml((Number(v) || 0).toLocaleString());
  const section = ensembleSection(app, draft, opts.mode);
  const r = await openDialog({
    onOpen: (ctl) => {
      ctl.body.appendChild(section);
      if (opts.section === 'ensemble') setTimeout(() => { section.scrollIntoView({ block: 'start' }); section.querySelector<HTMLElement>('input')?.focus(); }, 40);
    },
    title: 'AI Settings', wide: true, fields: [
      { key: 'enabled', label: 'AI features are on', type: 'checkbox', value: s.enabled },
      { key: 'info', type: 'info', html: '<p class="ql-help">AI output that changes the document is always previewed first and applied as one step you can undo.</p>' },
      { key: 'language', label: 'Language for generated text', type: 'combo', options: ['auto', 'English', 'English (American)', 'English (British)', 'English (Canadian)', 'English (Australian)', 'English (Indian)', 'Spanish', 'French', 'German', 'Italian', 'Portuguese', 'Dutch', 'Chinese (Simplified)', 'Japanese', 'Korean'], value: s.language, half: true },
      { key: 'clipboardWatch', label: 'During setup, look for a copied API key when I return to the app', type: 'checkbox', value: s.clipboardWatch },
      { key: 'clearClipboard', label: 'Remove a recognized key from the clipboard after saving it', type: 'checkbox', value: s.clearClipboard },
      { key: 'usage', type: 'info', html: `<p class="ql-help">Requests this device has sent: ${count(s.usage?.requests)} · tokens in/out (where reported): ${count(s.usage?.tokensIn)} / ${count(s.usage?.tokensOut)} · since ${escHtml(new Date(Number(s.usage?.since) || Date.now()).toLocaleDateString())}</p>` },
    ],
  });
  if (!r) return;
  saveAiSettings((x) => {
    x.enabled = !!r.enabled;
    x.language = String(r.language || 'auto');
    x.clipboardWatch = !!r.clipboardWatch; x.clearClipboard = !!r.clearClipboard;
    x.ensemble = normalizeEnsemble(draft);
  });
  if (JSON.stringify(normalizeEnsemble(draft)) !== JSON.stringify(s0) && draft.mode !== 'single' && draft.members.length >= 2) {
    const ids = [...new Set([...draft.members.map((m) => m.provider), draft.master])];
    toast(`Several AIs: ${draft.mode === 'master' ? 'master' : 'Quaker consensus'} with ${ids.map((id) => providerById(id)?.name || id).join(', ')}`);
  }
  app.ui.refresh?.();
}

export { PROVIDERS };
