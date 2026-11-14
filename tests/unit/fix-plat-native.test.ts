/** Platform bridge: the desktop passes bytes (not base64), and there is no hand-off of files to other programs. */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';

afterEach(() => { delete (window as any).quillDesktop; vi.resetModules(); });

async function withDesktop(bridge: Record<string, unknown>) {
  (window as any).quillDesktop = { platform: 'linux', ...bridge };
  vi.resetModules();
  return import('../../src/platform/native');
}
const bytes = (s: string) => new TextEncoder().encode(s);
const text = (b: ArrayBuffer) => new TextDecoder().decode(b);

describe('desktop bridge', () => {
  it('opens a file handed over as bytes', async () => {
    const native = await withDesktop({ openDocument: async () => ({ uri: 'file:///a.pdf', name: 'a.pdf', mime: 'application/pdf', bytes: bytes('%PDF-1.7') }) });
    const f = await native.openDocument('.pdf', ['application/pdf']);
    expect(f).toMatchObject({ name: 'a.pdf', uri: 'file:///a.pdf', mime: 'application/pdf' });
    expect(text(f!.data)).toBe('%PDF-1.7');
  });

  it('copies bytes that are a view into a larger buffer', async () => {
    const big = bytes('xx%PDFyy');
    const native = await withDesktop({ readUri: async () => ({ name: 'a.pdf', bytes: big.subarray(2, 6) }) });
    expect(text((await native.readUri('file:///a.pdf'))!.data)).toBe('%PDF');
  });

  it('still accepts base64 (the Android bridge, an older desktop shell)', async () => {
    const native = await withDesktop({ getLaunchFile: async () => ({ name: 'a.txt', data: btoa('hello') }) });
    expect(text((await native.launchFile())!.data)).toBe('hello');
  });

  it('saves and writes back as bytes', async () => {
    const sent: any[] = [];
    const native = await withDesktop({
      saveAs: async (o: any) => { sent.push(o); return { uri: 'file:///b.pdf', name: 'b.pdf' }; },
      writeUri: async (o: any) => { sent.push(o); return { ok: true }; },
    });
    await native.saveAs(new Blob(['one'], { type: 'application/pdf' }), 'b.pdf');
    await native.writeBack('file:///b.pdf', new Blob(['two']));
    expect(sent.map((o) => [o.bytes instanceof Uint8Array, 'data' in o, new TextDecoder().decode(o.bytes)])).toEqual([[true, false, 'one'], [true, false, 'two']]);
  });

  it('reports how saved keys are protected', async () => {
    let native = await withDesktop({ secureInfo: async () => ({ encrypted: false, available: true, backend: 'basic_text' }) });
    expect(await native.secureStorageInfo()).toEqual({ encrypted: false, backend: 'basic_text' });
    native = await withDesktop({});
    expect((await native.secureStorageInfo()).encrypted).toBe(false); // an older shell that cannot say: not assumed safe
  });
});

describe('removed hand-off to other programs', () => {
  it('neither the page, the desktop shell nor the Android plugin can open a file in another program', () => {
    expect(readFileSync('src/platform/native.ts', 'utf8')).not.toMatch(/openInQuillApp|openInApp|openWith/);
    expect(readFileSync('electron/main.cjs', 'utf8') + readFileSync('electron/preload.cjs', 'utf8')).not.toMatch(/openWith|shell\.openPath/);
    expect(readFileSync('android/app/src/main/java/io/github/socrtwo/quillfolio/QuillNativePlugin.java', 'utf8')).not.toMatch(/openInApp|SIBLING_APPS/);
  });
});
