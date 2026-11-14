// Older engines used to get no Content-Security-Policy at all; they now get one that still refuses inline
// and injected scripts, with 'unsafe-eval' (which they need for WebAssembly) instead of 'wasm-unsafe-eval'.
import { describe, it, expect } from 'vitest';
import { CSP_POLICY, CSP_POLICY_LEGACY, cspLevel, installCsp } from '../../src/csp';

const chrome = (v: number) => `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v}.0.0.0 Safari/537.36`;
const directive = (p: string, name: string) => p.split('; ').find((d) => d.startsWith(name + ' '))!;

describe('Content-Security-Policy on older engines', () => {
  it('picks the policy by engine', () => {
    expect(cspLevel(chrome(140), false)).toBe('modern');
    expect(cspLevel(chrome(90), false)).toBe('legacy');
    expect(cspLevel('Mozilla/5.0 (X11; Linux x86_64; rv:101.0) Gecko/20100101 Firefox/101.0', false)).toBe('legacy');
    expect(cspLevel('SomethingElse/1.0', false)).toBe('legacy');
    expect(cspLevel(chrome(140), true)).toBe('none');
    expect(cspLevel(`${chrome(140)} Electron/43.8.0`, false)).toBe('none');
  });
  it('the legacy policy still refuses inline script and differs only in how WebAssembly is allowed', () => {
    const s = directive(CSP_POLICY_LEGACY, 'script-src');
    expect(s).toContain("'unsafe-eval'");
    expect(s).not.toContain("'wasm-unsafe-eval'");
    expect(s).not.toContain("'unsafe-inline'");
    expect(CSP_POLICY_LEGACY.replace("'unsafe-eval'", "'wasm-unsafe-eval'")).toBe(CSP_POLICY);
    expect(CSP_POLICY_LEGACY).toContain("object-src 'none'");
  });
  it('installs the policy it is given', () => {
    const doc = document.implementation.createHTMLDocument('t');
    expect(installCsp(doc, { protocol: 'https:', host: 'example.org' }, CSP_POLICY_LEGACY)).toBe(true);
    expect(doc.querySelector('meta[http-equiv="Content-Security-Policy"]')!.getAttribute('content')).toBe(CSP_POLICY_LEGACY);
  });
});
