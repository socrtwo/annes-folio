/**
 * Small XML helpers for the importers and exporters (XFDF, text files): decoding bytes by their
 * declared encoding, parsing with a real error result, and escaping.
 */

/** Decodes XML bytes honoring a BOM or the encoding named in the declaration. */
export function decodeXml(u8: Uint8Array): string {
  if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return new TextDecoder('utf-8').decode(u8.subarray(3));
  if (u8[0] === 0xff && u8[1] === 0xfe) return new TextDecoder('utf-16le').decode(u8.subarray(2));
  if (u8[0] === 0xfe && u8[1] === 0xff) return new TextDecoder('utf-16be').decode(u8.subarray(2));
  const head = String.fromCharCode(...Array.from(u8.subarray(0, 200)));
  const m = /^\s*<\?xml[^>]*encoding\s*=\s*["']([\w.:-]+)["']/i.exec(head);
  const label = m ? m[1].toLowerCase() : 'utf-8';
  if (label !== 'utf-8' && label !== 'utf8') {
    try { return new TextDecoder(label).decode(u8); } catch { /* unknown label */ }
  }
  return new TextDecoder('utf-8').decode(u8);
}

/** Parses XML text; retries after removing characters XML 1.0 forbids. Null on failure. */
export function parseXml(text: string): Document | null {
  const parse = (t: string): Document | null => {
    try {
      const d = new DOMParser().parseFromString(t, 'application/xml');
      if (!d.documentElement || d.documentElement.localName === 'parsererror' || d.getElementsByTagName('parsererror').length) return null;
      return d;
    } catch {
      return null;
    }
  };
  const clean = text.replace(/^﻿/, '');
  return parse(clean) || parse(clean.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ''));
}

/** Escapes text for XML content and attribute values; drops characters XML 1.0 forbids. */
export function esc(s: string | number | null | undefined): string {
  return String(s ?? '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F￾￿]/g, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
