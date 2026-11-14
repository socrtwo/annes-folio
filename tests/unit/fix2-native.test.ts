/**
 * Platform bridge, second round: Android files cross as cache copies (not base64 strings), large saves
 * are staged in a file, and the iOS plugin (Keychain, export to Files, print) is used when present.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';

const st = vi.hoisted(() => ({
  platform: 'android',
  plugins: new Set<string>(),
  impl: {} as Record<string, Record<string, (...a: any[]) => any>>,
  files: new Map<string, string>(),
  calls: [] as string[],
  toasts: [] as string[],
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: () => st.platform !== 'web',
    isPluginAvailable: (n: string) => st.plugins.has(n),
    getPlatform: () => st.platform,
    convertFileSrc: (p: string) => 'http://localhost/_capacitor_file_' + p,
  },
  registerPlugin: (name: string) => new Proxy({}, { get: (_t, m: string) => (...a: any[]) => { st.calls.push(`${name}.${m}`); return st.impl[name]?.[m]?.(...a); } }),
}));
vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE', Documents: 'DOCUMENTS' },
  Filesystem: {
    writeFile: async (o: any) => { st.calls.push(`fs.writeFile ${o.directory}/${o.path}`); st.files.set(`${o.directory}/${o.path}`, o.data); return { uri: `file:///cache/${o.path}` }; },
    appendFile: async (o: any) => { st.calls.push(`fs.appendFile ${o.directory}/${o.path}`); st.files.set(`${o.directory}/${o.path}`, st.files.get(`${o.directory}/${o.path}`)! + '|' + o.data); },
    stat: async () => { throw new Error('missing'); },
    deleteFile: async () => undefined,
  },
}));
vi.mock('../../src/ui/dialog', () => ({ toast: (t: string) => { st.toasts.push(t); } }));

import * as native from '../../src/platform/native';

const enc = (s: string) => new TextEncoder().encode(s);
const text = (b: ArrayBuffer) => new TextDecoder().decode(b);
const fetched: string[] = [];

beforeEach(() => {
  st.platform = 'android';
  st.plugins = new Set(['QuillNative', 'Filesystem']);
  st.impl = {};
  st.files.clear();
  st.calls = [];
  st.toasts = [];
  fetched.length = 0;
  vi.stubGlobal('fetch', async (url: string) => { fetched.push(url); return { ok: true, status: 200, arrayBuffer: async () => enc('%PDF-big').buffer }; });
});

describe('Android: opened files arrive as cache copies', () => {
  it('open, recent file and launch file are fetched from the cache copy, which is then released', async () => {
    const released: string[] = [];
    const file = { uri: 'content://p/1', name: 'a.pdf', mime: 'application/pdf', path: '/data/cache/opened/x.bin', size: 8 };
    st.impl.QuillNative = {
      openDocument: async () => file, readUri: async () => file, getLaunchFile: async () => file,
      releaseFile: async (o: any) => { released.push(o.path); },
    };
    const f = await native.openDocument('.pdf', ['application/pdf']);
    expect(f).toMatchObject({ name: 'a.pdf', uri: 'content://p/1', mime: 'application/pdf' });
    expect(text(f!.data)).toBe('%PDF-big');
    expect(text((await native.readUri('content://p/1'))!.data)).toBe('%PDF-big');
    expect(text((await native.launchFile())!.data)).toBe('%PDF-big');
    expect(fetched).toEqual(Array(3).fill('http://localhost/_capacitor_file_/data/cache/opened/x.bin'));
    expect(released).toEqual(Array(3).fill('/data/cache/opened/x.bin'));
  });

  it('files opened while running (fileOpened) are fetched too', async () => {
    let listener: ((r: any) => void) | null = null;
    st.impl.QuillNative = { addListener: async (_e: string, cb: any) => { listener = cb; return { remove() {} }; }, releaseFile: async () => undefined };
    const got: string[] = [];
    native.onFileOpened((f) => got.push(text(f.data)));
    listener!({ name: 'b.pdf', path: '/data/cache/opened/y.bin' });
    await vi.waitFor(() => expect(got).toEqual(['%PDF-big']));
  });

  it('shared text still comes as base64', async () => {
    st.impl.QuillNative = { getLaunchFile: async () => ({ name: 'Shared text.txt', data: btoa('hello') }) };
    expect(text((await native.launchFile())!.data)).toBe('hello');
    expect(fetched).toEqual([]);
  });

  it('a large save is staged in chunks with the Filesystem plugin and handed over by path', async () => {
    const sent: any[] = [];
    st.impl.QuillNative = { writeUri: async (o: any) => { sent.push(o); return { ok: true }; } };
    const big = new Blob([new Uint8Array(native.STAGE_MIN + 7 * 1024 * 1024)]);
    expect(await native.writeBack('content://p/1', big)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0].data).toBeUndefined();
    expect(sent[0].path).toMatch(/^file:\/\/\/cache\/outgoing\/[\w-]+\.bin$/);
    const fsCalls = st.calls.filter((c) => c.startsWith('fs.'));
    expect(fsCalls[0]).toMatch(/^fs\.writeFile CACHE\/outgoing\//);
    expect(fsCalls.slice(1).every((c) => c.startsWith('fs.appendFile CACHE/outgoing/'))).toBe(true);
    expect(fsCalls).toHaveLength(4); // 11 MB in 3 MB chunks
    // Every chunk is complete base64 on its own (3 MB is a multiple of 3 bytes).
    const total = [...st.files.values()][0].split('|').reduce((n, c) => n + atob(c).length, 0);
    expect(total).toBe(big.size);
  });

  it('a small save is one base64 message, as before', async () => {
    const sent: any[] = [];
    st.impl.QuillNative = { writeUri: async (o: any) => { sent.push(o); return { ok: true }; } };
    await native.writeBack('content://p/1', new Blob(['two']));
    expect(sent).toEqual([{ uri: 'content://p/1', data: btoa('two') }]);
  });
});

describe('iOS plugin', () => {
  beforeEach(() => { st.platform = 'ios'; st.plugins = new Set(['QuillIOS', 'Filesystem', 'App', 'Share']); });

  it('keys go to the Keychain and are reported as encrypted', async () => {
    const kc = new Map<string, string>();
    st.impl.QuillIOS = {
      secureSet: async (o: any) => { kc.set(o.key, o.value); },
      secureGet: async (o: any) => (kc.has(o.key) ? { value: kc.get(o.key) } : {}),
      secureRemove: async (o: any) => { kc.delete(o.key); },
      secureInfo: async () => ({ encrypted: true, available: true, backend: 'ios-keychain' }),
    };
    expect(native.isNative()).toBe(false); // no file dialogs on iOS: the other code paths are unchanged
    expect(native.hasSecureStorage()).toBe(true);
    await native.secureSet('ai.key.x', 'sk-1');
    expect(await native.secureGet('ai.key.x')).toBe('sk-1');
    await native.secureRemove('ai.key.x');
    expect(await native.secureGet('ai.key.x')).toBeNull();
    expect(await native.secureStorageInfo()).toEqual({ encrypted: true, backend: 'ios-keychain' });
    expect(st.calls.filter((c) => c.startsWith('QuillNative.'))).toEqual([]);
  });

  it('an iOS build without the plugin has no secure storage', () => {
    st.plugins.delete('QuillIOS');
    expect(native.hasSecureStorage()).toBe(false);
  });

  it('Save As offers the export picker; cancelling saves nothing', async () => {
    const exported: any[] = [];
    st.impl.QuillIOS = { exportFile: async (o: any) => { exported.push(o); return { canceled: true }; } };
    expect(await native.saveAs(new Blob(['%PDF']), 'Report.pdf')).toBeNull();
    expect(exported).toEqual([{ name: 'Report.pdf', data: btoa('%PDF') }]);
    expect(st.calls.some((c) => c.startsWith('fs.writeFile'))).toBe(false);
  });

  it('Save As to Files also keeps the app copy, and says so', async () => {
    st.impl.QuillIOS = { exportFile: async () => ({ canceled: false, name: 'Report.pdf' }) };
    const r = await native.saveAs(new Blob(['%PDF']), 'Report.pdf');
    expect(r).toEqual({ uri: 'ios-doc:Report.pdf', name: 'Report.pdf' });
    expect(st.files.get('DOCUMENTS/Report.pdf')).toBe(btoa('%PDF'));
    await vi.waitFor(() => expect(st.toasts[0]).toMatch(/copy of "Report\.pdf" where you chose.*kept one in Anne's Folio/));
  });

  it('without the plugin, Save As keeps the old behaviour (app folder, Share)', async () => {
    st.plugins.delete('QuillIOS');
    expect(await native.saveAs(new Blob(['%PDF']), 'Report.pdf')).toEqual({ uri: 'ios-doc:Report.pdf', name: 'Report.pdf' });
    await vi.waitFor(() => expect(st.toasts[0]).toMatch(/use Share/));
  });

  it('prints PDF bytes through the plugin; elsewhere printPdf declines', async () => {
    const jobs: any[] = [];
    st.impl.QuillIOS = { printPdf: async (o: any) => { jobs.push(o); return { completed: true }; } };
    expect(await native.printPdf(new Blob(['%PDF']), 'Report')).toBe(true);
    expect(jobs).toEqual([{ data: btoa('%PDF'), jobName: 'Report' }]);
    st.plugins.delete('QuillIOS');
    expect(await native.printPdf(new Blob(['%PDF']), 'Report')).toBe(false);
    st.platform = 'android';
    expect(await native.printPdf(new Blob(['%PDF']), 'Report')).toBe(false);
  });
});

describe('native sources', () => {
  const java = readFileSync('android/app/src/main/java/io/github/socrtwo/quillfolio/QuillNativePlugin.java', 'utf8');
  const manifest = readFileSync('android/app/src/main/AndroidManifest.xml', 'utf8');

  it('Android streams opened files to the cache instead of one base64 string', () => {
    expect(java).not.toMatch(/MAX_READ_BYTES = 64L/);
    expect(java).toMatch(/MAX_READ_BYTES = 1024L \* 1024L \* 1024L/);
    expect(java).not.toMatch(/readAll\(/);
    expect(java.split('private JSObject readDocument')[1].split('\n    }\n')[0]).toMatch(/ret\.put\("path"/);
    expect(java).toMatch(/public void releaseFile\(PluginCall call\)/);
    expect(java).toMatch(/public void load\(\)[\s\S]*deleteFilesIn\(new File\(cache, OPENED_DIR\)\)/);
  });

  it('Android keeps the sign-in listener in a short foreground service', () => {
    const svc = readFileSync('android/app/src/main/java/io/github/socrtwo/quillfolio/LoopbackService.java', 'utf8');
    expect(manifest).toMatch(/<service\s+android:name="\.LoopbackService"\s+android:exported="false"\s+android:foregroundServiceType="shortService" \/>/);
    expect(manifest).toContain('<uses-permission android:name="android.permission.FOREGROUND_SERVICE" />');
    expect(svc).toContain('FOREGROUND_SERVICE_TYPE_SHORT_SERVICE');
    expect(svc).toMatch(/public void onTimeout\(int startId\) \{\s+finish\(\);/);
    expect(java).toMatch(/LoopbackService\.start\(getContext\(\)\)/);
    expect(java.match(/LoopbackService\.stop\(\)/g)!.length).toBeGreaterThanOrEqual(4); // callback, thread end, stopLoopback, destroy
    expect(existsSync('android/app/src/main/res/drawable/ic_stat_signin.xml')).toBe(true);
  });

  it('the iOS plugin is compiled into the app, registered, and offers what native.ts calls', () => {
    const pbx = readFileSync('ios/App/App.xcodeproj/project.pbxproj', 'utf8');
    for (const f of ['QuillIOSPlugin.swift', 'QuillBridgeViewController.swift']) {
      expect(pbx).toMatch(new RegExp(`\\/\\* ${f} in Sources \\*\\/,`));
      expect(existsSync(`ios/App/App/${f}`)).toBe(true);
    }
    expect(readFileSync('ios/App/App/Base.lproj/Main.storyboard', 'utf8')).toContain('customClass="QuillBridgeViewController" customModule="App"');
    expect(readFileSync('ios/App/App/SceneDelegate.swift', 'utf8')).toContain('rootViewController = QuillBridgeViewController()');
    expect(readFileSync('ios/App/App/QuillBridgeViewController.swift', 'utf8')).toContain('bridge?.registerPluginInstance(QuillIOSPlugin())');
    const swift = readFileSync('ios/App/App/QuillIOSPlugin.swift', 'utf8');
    expect(swift).toContain('public let jsName = "QuillIOS"');
    const methods = [...swift.matchAll(/CAPPluginMethod\(name: "(\w+)"/g)].map((m) => m[1]).sort();
    const ts = readFileSync('src/platform/native.ts', 'utf8').split('interface QuillIOSPlugin {')[1].split('\n}')[0];
    expect(methods).toEqual([...ts.matchAll(/^  (\w+)\(/gm)].map((m) => m[1]).sort());
    for (const m of methods) expect(swift).toContain(`@objc func ${m}(_ call: CAPPluginCall)`);
    expect(swift).toContain('kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly');
    expect(readFileSync('ios/App/App/Info.plist', 'utf8')).toMatch(/<key>LSSupportsOpeningDocumentsInPlace<\/key>\s*<false\/>/);
  });

  it('a workflow compiles the iOS app when its sources change, read-only', () => {
    const wf = readFileSync('.github/workflows/ios.yml', 'utf8');
    expect(wf).toMatch(/^permissions:\n  contents: read$/m);
    expect(wf).toMatch(/uses: actions\/checkout@v4\n\s+with:\n\s+persist-credentials: false/);
    for (const p of ['ios/**', 'src/platform/native.ts', 'package.json', 'capacitor.config.json', '.github/workflows/ios.yml']) expect(wf).toContain(`- '${p}'`);
    expect(wf).toContain('npx cap sync ios');
    expect(wf).toMatch(/xcodebuild -project ios\/App\/App\.xcodeproj -scheme App -configuration Release/);
    expect(wf).toContain('CODE_SIGNING_ALLOWED=NO');
    expect(wf).not.toMatch(/upload-artifact|contents: write|secrets\./);
  });
});
