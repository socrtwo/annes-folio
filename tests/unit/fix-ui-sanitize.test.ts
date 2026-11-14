import { describe, it, expect } from 'vitest';
import { sanitizeHtml, isSafeExternalUrl, escHtml } from '../../src/util/sanitize';
import { h } from '../../src/ui/dom';

const clean = (html: string): string => { const d = document.createElement('div'); d.appendChild(sanitizeHtml(html)); return d.innerHTML; };

describe('sanitizeHtml (allow-list for every HTML string the UI shows)', () => {
  it('keeps the formatting the dialogs use', () => {
    expect(clean('<p class="ql-help">Font <b>Helvetica</b>, 12.0 pt.<br>Second line</p>')).toBe('<p class="ql-help">Font <b>Helvetica</b>, 12.0 pt.<br>Second line</p>');
    expect(clean('<b style="color:#c62828;text-decoration:underline wavy">word</b>')).toBe('<b style="color: #c62828; text-decoration: underline wavy">word</b>');
    expect(clean('<ul><li>one</li></ul><table><tr><td colspan="2">x</td></tr></table><h3>T</h3><pre><code>a &lt; b</code></pre>'))
      .toBe('<ul><li>one</li></ul><table><tbody><tr><td colspan="2">x</td></tr></tbody></table><h3>T</h3><pre><code>a &lt; b</code></pre>');
  });

  it('removes what a font name from a PDF injected into the Edit Text dialog', () => {
    const out = clean('<p class="ql-help">Font <img src="x" onerror="window.__xss=1">, 24.0 pt.</p>');
    expect(out).toBe('<p class="ql-help">Font , 24.0 pt.</p>');
  });

  it('drops scripts, handlers, frames, forms, SVG and MathML', () => {
    const out = clean('<p onclick="alert(1)">a</p><script>alert(1)</script><iframe src="https://x.example"></iframe><svg><a xlink:href="javascript:alert(1)"><text>s</text></a><animate attributeName="href" values="javascript:alert(1)"/></svg>'
      + '<math><mtext><table><mglyph><style><!--</style><img title="--&gt;&lt;img src=1 onerror=alert(1)&gt;"></mglyph></table></mtext></math><form action="https://x.example"><input name="q"><button>Go</button></form><style>p{color:red}</style><object data="x"></object>');
    expect(out).not.toMatch(/script|onclick|onerror|iframe|svg|animate|math|form|input|button|style|object|javascript/i);
    expect(out.startsWith('<p>a</p>')).toBe(true);
  });

  it('does not stumble over DOM clobbering', () => {
    for (const name of ['childNodes', 'attributes', 'nodeType', 'localName', 'removeAttribute', 'body', 'documentElement']) {
      const out = clean(`<form><input name="${name}"></form><p>kept</p><img src="x" onerror="alert(1)">`);
      expect(out, name).toBe('<p>kept</p>');
    }
  });

  it('keeps links to web, mail and in-page targets only, and opens web links outside', () => {
    expect(clean('<a href="https://example.org/a?b=1">x</a>')).toBe('<a href="https://example.org/a?b=1" target="_blank" rel="noopener noreferrer">x</a>');
    expect(clean('<a href="#top">x</a>')).toBe('<a href="#top">x</a>');
    for (const bad of ['javascript:alert(1)', 'jav\tascript:alert(1)', 'data:text/html,<script>1</script>', 'file:///etc/passwd', 'intent://x#Intent;end', 'blob:https://x/1', '//evil.example/x'])
      expect(clean(`<a href="${bad}" onclick="x()">x</a>`), bad).toBe('<a>x</a>');
  });

  it('filters styles and classes that could dress text up as app chrome or load something', () => {
    expect(clean('<div class="ql-overlay ql-dialog ql-help" style="position:fixed;inset:0;background:url(https://x.example/p);color:red">t</div>')).toBe('<div class="ql-help" style="color: red">t</div>');
    expect(clean('<span style="color:expression(alert(1)); background-color: var(--x); font-weight: bold">t</span>')).toBe('<span style="font-weight: bold">t</span>');
  });

  it('is what h() uses for its html prop', () => {
    const el = h('div', { html: '<p>ok</p><img src=x onerror="window.__h=1">' });
    expect(el.innerHTML).toBe('<p>ok</p>');
    // an event handler given as a string is never written as an attribute
    expect(h('button', { onclick: 'alert(1)' } as any).hasAttribute('onclick')).toBe(false);
  });
});

describe('URL allow-list and escaping', () => {
  it('accepts web, mail and phone addresses only', () => {
    expect(isSafeExternalUrl(' https://a.example')).toBe(true);
    expect(isSafeExternalUrl('mailto:a@b.example')).toBe(true);
    for (const u of ['javascript:alert(1)', 'file:///x', 'intent://x', 'app://x', 'data:text/html,x', 'blob:x']) expect(isSafeExternalUrl(u), u).toBe(false);
  });
  it('escapes the five characters', () => { expect(escHtml(`<a href="x" title='y'>&`)).toBe('&lt;a href=&quot;x&quot; title=&#39;y&#39;&gt;&amp;'); });
});
