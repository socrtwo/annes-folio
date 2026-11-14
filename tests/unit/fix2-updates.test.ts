// Check for Updates used to open the releases page only; it now asks GitHub for the newest release, and an
// opt-in (off by default) start-up check does the same at most once a day in the installed apps.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { compareVersions, latestRelease, startupUpdateCheck } from '../../src/commands/help';
import { defaultPrefs } from '../../src/prefs';

describe('update check', () => {
  beforeEach(() => localStorage.clear());
  it('compares versions', () => {
    expect(compareVersions('0.2.0', '0.1.0')).toBe(1);
    expect(compareVersions('v0.1.0', '0.1.0')).toBe(0);
    expect(compareVersions('0.1.10', '0.1.9')).toBe(1);
    expect(compareVersions('1.0', '1.0.1')).toBe(-1);
    expect(compareVersions('0.1.0-build.5', '0.1.0')).toBe(0);
  });
  it('reads the latest release and refuses odd answers', async () => {
    const ok = vi.fn(async () => new Response(JSON.stringify({ tag_name: 'v0.3.1', html_url: 'https://github.com/socrtwo/annes-folio/releases/tag/v0.3.1' })));
    expect(await latestRelease(ok as any)).toEqual({ version: '0.3.1', url: 'https://github.com/socrtwo/annes-folio/releases/tag/v0.3.1' });
    const evil = vi.fn(async () => new Response(JSON.stringify({ tag_name: 'v9.9.9', html_url: 'javascript:alert(1)' })));
    expect((await latestRelease(evil as any))!.url).toBe('https://github.com/socrtwo/annes-folio/releases/latest');
    expect(await latestRelease((async () => new Response('nope', { status: 403 })) as any)).toBeNull();
    expect(await latestRelease((async () => new Response(JSON.stringify({ tag_name: 'nightly' }))) as any)).toBeNull();
    expect(await latestRelease((async () => { throw new TypeError('offline'); }) as any)).toBeNull();
  });
  it('is off by default and does nothing unless enabled in an installed app', async () => {
    expect(defaultPrefs().checkUpdates).toBe(false);
    const f = vi.spyOn(globalThis, 'fetch');
    await startupUpdateCheck(false, true);
    await startupUpdateCheck(true, false);
    expect(f).not.toHaveBeenCalled();
    f.mockRestore();
  });
});
