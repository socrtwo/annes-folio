// iOS app with the QuillIOS plugin: API keys go to the iOS Keychain (via platform/native), not the app
// database, and a key an older build left in the app database is moved into the Keychain on first use.
import { describe, it, expect, beforeEach, vi } from 'vitest';

const kv = new Map<string, unknown>();
const keychain = new Map<string, string>();
vi.mock('../../src/util/store', () => ({
  kvGet: async (k: string) => kv.get(k),
  kvSet: async (k: string, v: unknown) => { kv.set(k, v); },
  kvDel: async (k: string) => { kv.delete(k); },
}));
vi.mock('../../src/platform/native', () => ({
  isNative: () => false,
  isDesktop: () => false,
  isCapacitor: () => true,
  hasSecureStorage: () => true,
  secureGet: async (k: string) => keychain.get(k) ?? null,
  secureSet: async (k: string, v: string) => { keychain.set(k, v); },
  secureRemove: async (k: string) => { keychain.delete(k); },
  secureStorageInfo: async () => ({ encrypted: true, backend: 'ios-keychain' }),
}));

async function fresh() { vi.resetModules(); return import('../../src/ai/store'); }
beforeEach(() => { kv.clear(); keychain.clear(); localStorage.clear(); });

describe('API keys in the iOS Keychain', () => {
  it('saves to the Keychain and reports it as encrypted', async () => {
    const store = await fresh();
    const where = await store.setApiKey('openai', 'sk-test-1');
    expect(where.kind).toBe('ios-keychain');
    expect(where.encrypted).toBe(true);
    expect(keychain.get('ai.key.openai')).toBe('sk-test-1');
    expect(kv.has('aikey:openai')).toBe(false);
    const again = await fresh();
    expect(await again.getApiKey('openai')).toBe('sk-test-1');
  });
  it('moves a key an older build kept in the app database into the Keychain', async () => {
    kv.set('aikey:groq', 'gsk-old');
    const store = await fresh();
    expect(await store.getApiKey('groq')).toBe('gsk-old');
    expect(keychain.get('ai.key.groq')).toBe('gsk-old');
    expect(kv.has('aikey:groq')).toBe(false);
  });
  it('deletes from both places', async () => {
    kv.set('aikey:mistral', 'old'); keychain.set('ai.key.mistral', 'new');
    const store = await fresh();
    await store.deleteApiKey('mistral');
    expect(keychain.has('ai.key.mistral')).toBe(false);
    expect(kv.has('aikey:mistral')).toBe(false);
  });
});
