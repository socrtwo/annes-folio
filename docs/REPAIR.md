# Repairing damaged PDFs

Anne's Folio opens damaged PDFs instead of refusing them. The pipeline lives in `src/pdf/repair/index.ts` and runs automatically when the normal parse fails or yields no pages; `File ▸ Open and Repair` forces it and `File ▸ Recover Data from Any File` runs it on anything.

## Lineage

The approach descends from the author's recovery tools: [Immortal Zip](https://socrtwo.github.io/Immortal-Zip/) (byte-level ZIP salvage and the ImmortalInflate decoder that keeps the readable part of a damaged deflate stream), [XML Truncator-Fixer](https://socrtwo.github.io/xmltrncatorfixr-SF/app/) and [Word Recovery](https://github.com/socrtwo/wordrecovery-SF) (method-by-method reports, text scans as the last resort). The same `src/io/recover` files are shared with the sister apps.

## Methods, in order

| Method | What it does | Status when |
|---|---|---|
| **Identify** | Reads the bytes: PDF header anywhere in the first 64 KB, PDF objects without a header, ZIP, text, pictures, or unknown | `failed` when the file is not a PDF at all |
| **Normal open** | The ordinary parser: `startxref`, cross-reference tables and streams, `/Prev` chains, hybrid `/XRefStm` | `partial` when the xref had to be rebuilt, `failed` when nothing parsed |
| **Header and end-of-file** | Adds a missing `%PDF-` header, trims leading garbage, notes a missing `%%EOF` (truncation) | `partial` when something was fixed |
| **Cross-reference rebuild** | Scans the whole file for `N G obj`, trailers and `/Type /Catalog`; when no catalog resolves, collects loose `/Type /Page` objects in file order and synthesizes a page tree | `success` when pages are reachable |
| **Trailer and catalog** | Picks the trailer whose `/Root` resolves to a catalog with a usable `/Pages` | `partial` when the catalog was synthesized |
| **Content streams** | Decodes every page's content; damaged Flate streams keep their readable prefix (ImmortalInflate); wrong `/Length` values are recovered by searching for `endstream` | `partial` when some were damaged |
| **Segments** | A PDF fused with other data (a mail message, a Word document, another PDF): each PDF segment is tried on its own. JPEG, PNG or ZIP signatures inside a PDF's own streams do not count as separate pieces | `partial` when a segment was better than the whole |
| **ZIP** | A PDF inside a damaged ZIP (portfolio, archive): byte-level salvage of the PDF entries only, with a cap on the total decoded size | `partial` when one was found |
| **Attachments** | Embedded files that survive are kept with the document | |
| **Text scan** | When no usable structure survives: text found in decoded streams, rebuilt as a text-only PDF | `partial`; the document is marked *text only* |
| **Strings scan** | Last resort: loose readable strings as a text-only PDF | `partial` |

The candidate with the most pages and words wins; the report lists every method with its status and detail, what was **rebuilt** (cross-reference table, page tree, header) and what was **lost** (damaged content streams, unreachable pages, encrypted content without a password), the page counts before and after, and the identification confidence. The recovered document opens as *name (Recovered)*, unsaved, with the report one click away in the status bar.

## Encrypted files

A damaged encrypted file is repaired on the structure level; without the password the content stays unreadable and the report says so.

## Tests

`tests/unit/ops.test.ts` builds a valid PDF in code and damages it eight ways (truncation, zeroed xref offsets, no trailer, garbage prefix, garbage suffix without `%%EOF`, missing header, wrong stream lengths, deleted page tree) and checks that the pages and their text come back; it also corrupts a Flate stream and checks that the rest survives, and feeds plain text to get a text-only result.
