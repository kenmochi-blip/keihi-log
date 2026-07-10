/*
 * 最小構成の XLSX 生成（外部ライブラリ・CDN 不使用・CSP 安全）。
 *   XlsxLite.download(filename, sheetName, aoa)
 *   XlsxLite.build(sheetName, aoa) -> Uint8Array
 * aoa は「行の配列（各行はセルの配列）」。セル値は次を扱う:
 *   - 文字列 / 数値
 *   - { d: 'YYYY-MM-DD' } … 日付（Excelシリアル値＋yyyy/mm/dd書式で出力）
 * ZIP は store（無圧縮）方式。文字列は inlineStr で埋め込む。
 */
(function () {
  const enc = (typeof TextEncoder !== 'undefined') ? new TextEncoder() : null;
  const toUtf8 = enc ? (s => enc.encode(s)) : (s => Buffer.from(s, 'utf8')); // node fallback

  const crcTable = (function () {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();
  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  function colLetter(n) { let s = ''; n++; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
  function dateSerial(iso) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    if (!m) return null;
    return Math.round((Date.UTC(+m[1], +m[2] - 1, +m[3]) - Date.UTC(1899, 11, 30)) / 86400000);
  }

  function sheetXml(aoa) {
    let rows = '';
    for (let r = 0; r < aoa.length; r++) {
      const row = aoa[r] || [];
      let cells = '';
      for (let c = 0; c < row.length; c++) {
        let v = row[c];
        if (v === null || v === undefined || v === '') continue;
        const ref = colLetter(c) + (r + 1);
        if (typeof v === 'object' && v.d) {
          const s = dateSerial(v.d);
          if (s !== null) { cells += `<c r="${ref}" s="1"><v>${s}</v></c>`; continue; }
          v = v.d;
        }
        if (typeof v === 'number' && isFinite(v)) cells += `<c r="${ref}"><v>${v}</v></c>`;
        else cells += `<c r="${ref}" t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
      }
      rows += `<row r="${r + 1}">${cells}</row>`;
    }
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData></worksheet>`;
  }

  const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy/mm/dd"/></numFmts><fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts><fills count="1"><fill><patternFill patternType="none"/></fill></fills><borders count="1"><border/></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;

  const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>`;

  const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>`;

  const WB_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;

  function workbookXml(name) {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${esc(name).slice(0, 31)}" sheetId="1" r:id="rId1"/></sheets></workbook>`;
  }

  // store方式ZIP。DOS日時は 1980-01-01 00:00（date=0x21, time=0）で固定。
  function zip(files) {
    const u16 = n => [n & 0xFF, (n >>> 8) & 0xFF];
    const u32 = n => [n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF];
    const DOSTIME = 0, DOSDATE = 0x21;
    const local = [], central = [];
    let offset = 0;
    for (const f of files) {
      const nameBytes = toUtf8(f.name);
      const crc = crc32(f.data);
      const size = f.data.length;
      const lh = [].concat([0x50, 0x4b, 0x03, 0x04], u16(20), u16(0), u16(0),
        u16(DOSTIME), u16(DOSDATE), u32(crc), u32(size), u32(size), u16(nameBytes.length), u16(0));
      local.push(new Uint8Array(lh), nameBytes, f.data);
      const ch = [].concat([0x50, 0x4b, 0x01, 0x02], u16(20), u16(20), u16(0), u16(0),
        u16(DOSTIME), u16(DOSDATE), u32(crc), u32(size), u32(size), u16(nameBytes.length),
        u16(0), u16(0), u16(0), u16(0), u32(0), u32(offset));
      central.push(new Uint8Array(ch), nameBytes);
      offset += lh.length + nameBytes.length + size;
    }
    let centralSize = 0;
    for (const c of central) centralSize += c.length;
    const end = new Uint8Array([].concat([0x50, 0x4b, 0x05, 0x06], u16(0), u16(0),
      u16(files.length), u16(files.length), u32(centralSize), u32(offset), u16(0)));
    const all = local.concat(central, [end]);
    let total = 0; for (const a of all) total += a.length;
    const out = new Uint8Array(total); let p = 0;
    for (const a of all) { out.set(a, p); p += a.length; }
    return out;
  }

  function build(sheetName, aoa) {
    return zip([
      { name: '[Content_Types].xml', data: toUtf8(CONTENT_TYPES) },
      { name: '_rels/.rels', data: toUtf8(RELS) },
      { name: 'xl/workbook.xml', data: toUtf8(workbookXml(sheetName)) },
      { name: 'xl/_rels/workbook.xml.rels', data: toUtf8(WB_RELS) },
      { name: 'xl/styles.xml', data: toUtf8(STYLES) },
      { name: 'xl/worksheets/sheet1.xml', data: toUtf8(sheetXml(aoa)) },
    ]);
  }

  function download(filename, sheetName, aoa) {
    const blob = new Blob([build(sheetName, aoa)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.click();
    URL.revokeObjectURL(url);
  }

  const api = { build, download };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof window !== 'undefined') window.XlsxLite = api;
})();
