/*
 * Importers: convert .docx, .rtf and .txt files to plain text, entirely in the
 * browser with no external libraries (so the app keeps working offline).
 *
 *  - DOCX: minimal ZIP reader + DecompressionStream('deflate-raw') to pull out
 *          word/document.xml, then paragraph/run text extraction.
 *  - RTF:  small tokenizer that understands groups, control words, hex/unicode
 *          escapes and skips non-text destinations (font tables, pictures...).
 *  - TXT:  UTF-8 / UTF-16 (BOM) / Windows-1252 fallback decoding.
 */
(function (root) {
  'use strict';

  const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

  /* ------------------------------------------------------------ helpers */

  function normalize(text) {
    return text
      .replace(/\r\n?/g, '\n')
      .replace(/[ \t\u00A0]+\n/g, '\n') // trailing whitespace
      .replace(/\n{3,}/g, '\n\n') // at most one blank line in a row
      .trim();
  }

  function decodeText(bytes) {
    // Byte-order marks
    if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return new TextDecoder('utf-8').decode(bytes.subarray(3));
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch (_) {
      return new TextDecoder('windows-1252').decode(bytes);
    }
  }

  function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) => {
      const k = e.toLowerCase();
      if (k === 'amp') return '&';
      if (k === 'lt') return '<';
      if (k === 'gt') return '>';
      if (k === 'quot') return '"';
      if (k === 'apos') return "'";
      const code = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      try { return String.fromCodePoint(code); } catch (_) { return ''; }
    });
  }

  /* --------------------------------------------------------------- DOCX */

  async function inflateRaw(bytes) {
    if (typeof DecompressionStream === 'undefined') {
      throw new Error('This browser cannot open .docx files (needs iPadOS 16.4+ or a current desktop browser). Try saving as .rtf or .txt.');
    }
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
    return new Response(stream).text();
  }

  /** Read a single file out of a ZIP archive by name. Returns text or null. */
  async function unzipEntry(buf, wanted) {
    const dv = new DataView(buf);
    const len = buf.byteLength;
    let eocd = -1;
    for (let i = len - 22; i >= Math.max(0, len - 65557); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Not a valid .docx file (could not read the archive).');

    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const utf8 = new TextDecoder('utf-8');

    for (let n = 0; n < count && p + 46 <= len; n++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const compSize = dv.getUint32(p + 20, true);
      const nameLen = dv.getUint16(p + 28, true);
      const extraLen = dv.getUint16(p + 30, true);
      const commentLen = dv.getUint16(p + 32, true);
      const localOff = dv.getUint32(p + 42, true);
      const name = utf8.decode(new Uint8Array(buf, p + 46, nameLen));

      if (name === wanted) {
        const lNameLen = dv.getUint16(localOff + 26, true);
        const lExtraLen = dv.getUint16(localOff + 28, true);
        const start = localOff + 30 + lNameLen + lExtraLen;
        const data = new Uint8Array(buf, start, compSize);
        if (method === 0) return utf8.decode(data);
        if (method === 8) return inflateRaw(data);
        throw new Error('Unsupported compression in .docx file.');
      }
      p += 46 + nameLen + extraLen + commentLen;
    }
    return null;
  }

  /** Extract paragraphs of text from WordprocessingML (word/document.xml). */
  function docxXmlToText(xml) {
    const bodyAt = xml.indexOf('<w:body');
    let body = bodyAt >= 0 ? xml.slice(bodyAt) : xml;
    // Text boxes are stored twice (modern + VML fallback); drop the fallback copy.
    body = body.replace(/<mc:Fallback>[\s\S]*?<\/mc:Fallback>/g, '');

    const re = /<w:p(?=[\s>\/])[^>]*?(\/)?>|<\/w:p>|<w:t(?=[\s>])[^>]*>([^<]*)<\/w:t>|<w:tab\/>|<w:(?:br|cr)(?=[\s\/])[^>]*\/>|<w:noBreakHyphen\/>/g;
    const paras = [];
    const stack = [];
    let cur = null;
    let m;
    while ((m = re.exec(body))) {
      const tok = m[0];
      if (m[2] !== undefined) {
        cur = (cur || '') + decodeEntities(m[2]);
      } else if (tok === '</w:p>') {
        paras.push(cur || '');
        cur = stack.length ? stack.pop() : null;
      } else if (tok === '<w:tab/>') {
        cur = (cur || '') + '\t';
      } else if (tok === '<w:noBreakHyphen/>') {
        cur = (cur || '') + '-';
      } else if (tok.startsWith('<w:br') || tok.startsWith('<w:cr')) {
        cur = (cur || '') + '\n';
      } else if (m[1]) {
        paras.push(''); // self-closing empty paragraph <w:p/>
      } else {
        stack.push(cur); // paragraph start (may be nested inside a text box)
        cur = '';
      }
    }
    if (cur) paras.push(cur);
    return normalize(paras.map((s) => s.replace(/\s+$/, '')).join('\n'));
  }

  async function docxToText(buf) {
    const xml = await unzipEntry(buf, 'word/document.xml');
    if (xml == null) throw new Error('This file does not look like a Word .docx document.');
    return docxXmlToText(xml);
  }

  /* ---------------------------------------------------------------- RTF */

  const RTF_SKIP = new Set([
    'fonttbl', 'colortbl', 'stylesheet', 'info', 'pict', 'object', 'header', 'headerl', 'headerr',
    'headerf', 'footer', 'footerl', 'footerr', 'footerf', 'themedata', 'colorschememapping',
    'latentstyles', 'datastore', 'xmlnstbl', 'listtable', 'listoverridetable', 'rsidtbl', 'generator',
    'filetbl', 'revtbl', 'fldinst', 'shppict', 'nonshppict', 'pgdsctbl', 'mmathPr', 'wgrffmtfilter',
    'xmlopen', 'footnote', 'annotation', 'atnid', 'atnauthor', 'expandedcolortbl', 'listtext', 'pntext',
  ]);

  const RTF_CHARS = {
    par: '\n', line: '\n', sect: '\n\n', page: '\n', tab: '\t', cell: '\t', row: '\n',
    emdash: '\u2014', endash: '\u2013', bullet: '\u2022', lquote: '\u2018', rquote: '\u2019',
    ldblquote: '\u201C', rdblquote: '\u201D', emspace: ' ', enspace: ' ', qmspace: ' ',
  };

  function rtfToText(rtf) {
    if (!/^\s*\{\\rtf/.test(rtf)) throw new Error('This does not look like an RTF file.');
    const cp1252 = new TextDecoder('windows-1252');
    const isAlpha = (ch) => (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z');
    const isDigit = (ch) => ch >= '0' && ch <= '9';

    const stack = [];
    let out = '';
    let skip = false; // inside an ignored destination
    let uc = 1; // chars to skip after \uN
    let pending = 0; // remaining fallback chars to skip

    const emit = (s) => {
      if (skip) return;
      if (pending > 0) { pending--; return; }
      out += s;
    };

    const n = rtf.length;
    let i = 0;
    while (i < n) {
      const c = rtf[i];
      if (c === '{') { stack.push({ skip, uc }); pending = 0; i++; continue; }
      if (c === '}') { const s = stack.pop(); if (s) { skip = s.skip; uc = s.uc; } pending = 0; i++; continue; }
      if (c === '\r' || c === '\n') { i++; continue; }
      if (c !== '\\') { emit(c); i++; continue; }

      const d = rtf[i + 1];
      if (d === undefined) break;

      if (isAlpha(d)) {
        let j = i + 1;
        while (j < n && isAlpha(rtf[j])) j++;
        const word = rtf.slice(i + 1, j);
        let param = null;
        if (isDigit(rtf[j] || '') || (rtf[j] === '-' && isDigit(rtf[j + 1] || ''))) {
          let k = j + 1;
          while (k < n && isDigit(rtf[k])) k++;
          param = parseInt(rtf.slice(j, k), 10);
          j = k;
        }
        if (rtf[j] === ' ') j++;
        i = j;

        if (word === 'u' && param !== null) {
          if (!skip) out += String.fromCharCode(param < 0 ? param + 65536 : param);
          pending = uc;
        } else if (word === 'uc' && param !== null) {
          uc = param;
        } else if (word === 'bin' && param > 0) {
          i += param;
        } else if (RTF_SKIP.has(word)) {
          skip = true;
        } else if (RTF_CHARS[word] !== undefined) {
          emit(RTF_CHARS[word]);
        }
        continue;
      }

      // Control symbols
      i += 2;
      switch (d) {
        case '\\': case '{': case '}': emit(d); break;
        case '~': emit('\u00A0'); break;
        case '_': emit('-'); break;
        case '*': skip = true; break;
        case "'": {
          const byte = parseInt(rtf.substr(i, 2), 16);
          i += 2;
          if (!isNaN(byte)) emit(cp1252.decode(new Uint8Array([byte])));
          break;
        }
        case '\n': case '\r': emit('\n'); break;
        default: break; // \- optional hyphen, \| etc.
      }
    }
    return normalize(out);
  }

  /* ---------------------------------------------------------- dispatch */

  async function fileToText(file) {
    const name = (file.name || '').toLowerCase();
    const ext = name.includes('.') ? name.split('.').pop() : '';

    if (['doc', 'pages', 'odt', 'pdf'].includes(ext)) {
      throw new Error(`.${ext} files aren't supported. Please save/export as .docx, .rtf or .txt.`);
    }

    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);

    if (ext === 'docx' || file.type === DOCX_MIME || (bytes[0] === 0x50 && bytes[1] === 0x4b)) {
      return docxToText(buf);
    }
    const text = decodeText(bytes);
    if (ext === 'rtf' || /^\s*\{\\rtf/.test(text)) return rtfToText(text);
    return normalize(text);
  }

  root.Importers = { fileToText, docxToText, docxXmlToText, rtfToText, normalize, decodeText };
})(typeof window !== 'undefined' ? window : globalThis);
