/** OpenRouter sign-in: unavailable in the iOS app, and the sign-in tab is opened while the click is being handled. */
import { describe, it, expect, afterEach, vi } from 'vitest';

const platform = { native: false, capacitor: false };
vi.mock('../../src/platform/native', () => ({
  isNative: () => platform.native,
  isCapacitor: () => platform.capacitor,
  openExternal: vi.fn(),
  startOAuthLoopback: vi.fn(async () => 5123),
  stopOAuthLoopback: vi.fn(async () => undefined),
  onOAuthCallback: vi.fn(async () => ({ remove: () => undefined })),
}));
import { startOpenRouterSignIn, signInAvailable, parseOAuthInput, isOurCallback } from '../../src/ai/oauth';

afterEach(() => { platform.native = false; platform.capacitor = false; vi.restoreAllMocks(); });

describe('OpenRouter sign-in', () => {
  it('is not offered in the iOS app, and says what to do instead', async () => {
    platform.capacitor = true; // Capacitor shell without the native bridge = iOS
    expect(signInAvailable()).toBe(false);
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    await expect(startOpenRouterSignIn()).rejects.toThrow(/not available in the iOS app.*paste/);
    expect(open).not.toHaveBeenCalled();
    platform.native = true; // Android
    expect(signInAvailable()).toBe(true);
  });

  it('browser: opens the tab before the first await, detaches it, then sends it to OpenRouter', async () => {
    const tab = { opener: window as unknown, location: { href: 'about:blank' }, close: vi.fn(), closed: false };
    const open = vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    const p = startOpenRouterSignIn(1000);
    expect(open).toHaveBeenCalledTimes(1); // synchronously, inside the click
    const session = await p;
    expect(session.opened).toBe(true);
    expect(tab.opener).toBeNull();
    expect(tab.location.href).toBe(session.url);
    const u = new URL(session.url);
    expect(u.origin + u.pathname).toBe('https://openrouter.ai/auth');
    expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    expect(u.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(new URL(u.searchParams.get('callback_url')!).searchParams.get('ql-state')).toMatch(/^[A-Za-z0-9_-]{22}$/);
    session.cancel();
    await expect(session.key).rejects.toThrow('Canceled');
  });

  it('a blocked pop-up is reported with the address to open by hand', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null);
    const session = await startOpenRouterSignIn(1000);
    expect(session.opened).toBe(false);
    expect(session.url).toMatch(/^https:\/\/openrouter\.ai\/auth\?/);
    session.cancel();
    await session.key.catch(() => undefined);
  });

  it('reads a code from a pasted address or a bare code, and only this sign-in\'s callback path counts', () => {
    expect(parseOAuthInput('http://127.0.0.1:5123/callback/abc?code=xyz%2D1&x=1')).toBe('xyz-1');
    expect(parseOAuthInput('abcdefghijklmnop1234')).toBe('abcdefghijklmnop1234');
    expect(parseOAuthInput('hello')).toBeNull();
    expect(isOurCallback('http://127.0.0.1:5123/callback/abc?code=1', '/callback/abc')).toBe(true);
    expect(isOurCallback('http://127.0.0.1:5123/callback/other?code=1', '/callback/abc')).toBe(false);
  });
});
