import { inflateRawSync } from "node:zlib";

/**
 * Минимален read-only четец на .xlsx (OOXML) без външни зависимости.
 * Чете само: списък на листовете, споделените низове и клетките (стойност + текст на формулата).
 * НЕ изпълнява формули. За връзки разпознава само HYPERLINK / IFERROR / _xlfn._LONGTEXT с текстови литерали
 * (виж extractHyperlinkUrl) — всичко друго се връща като null.
 */

export const MAX_XLSX_BYTES = 20_000_000;
const MAX_ENTRY_BYTES = 60_000_000;

function readZip(buf: Buffer): Map<string, Buffer> {
  if (buf.length > MAX_XLSX_BYTES) throw new Error("Файлът е твърде голям.");
  // End of central directory (последните ≤ 65 557 байта)
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65_557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("Невалиден .xlsx (не е zip архив).");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error("Невалидна централна директория.");
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    p += 46 + nlen + elen + clen;
    if (usize > MAX_ENTRY_BYTES) throw new Error(`Твърде голям елемент: ${name}`);
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error("Невалиден локален хедър.");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + csize);
    if (method === 0) out.set(name, Buffer.from(data));
    else if (method === 8) out.set(name, inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES }));
    else throw new Error(`Неподдържана компресия (${method}) за ${name}`);
  }
  return out;
}

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");

const attr = (tag: string, name: string) => {
  const m = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return m ? decodeXml(m[1]!) : null;
};

export interface XlsxCell {
  /** Кеширана/литерална стойност като текст (числата — както са записани в XML). */
  value: string | null;
  /** Текст на формулата (без „=“), ако има. */
  formula: string | null;
  type: string | null;
}

export interface XlsxSheet {
  name: string;
  /** Редовете по физически номер на реда (1-базиран) → колона ("A") → клетка. */
  rows: Map<number, Map<string, XlsxCell>>;
  maxRow: number;
}

export interface XlsxBook {
  sheetNames: string[];
  sheet(name: string): XlsxSheet;
}

export function readXlsx(buf: Buffer): XlsxBook {
  const files = readZip(buf);
  const text = (n: string) => {
    const b = files.get(n);
    if (!b) throw new Error(`Липсва ${n}`);
    return b.toString("utf8");
  };
  const wb = text("xl/workbook.xml");
  const rels = text("xl/_rels/workbook.xml.rels");
  const relTarget = new Map<string, string>();
  for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) {
    const id = attr(m[0], "Id");
    const target = attr(m[0], "Target");
    if (id && target) relTarget.set(id, target.startsWith("/") ? target.slice(1) : `xl/${target}`);
  }
  const sheets: { name: string; path: string }[] = [];
  for (const m of wb.matchAll(/<sheet\b[^>]*\/?>/g)) {
    const name = attr(m[0], "name");
    const rid = attr(m[0], "r:id");
    if (name && rid && relTarget.has(rid)) sheets.push({ name, path: relTarget.get(rid)! });
  }
  const shared: string[] = [];
  if (files.has("xl/sharedStrings.xml")) {
    for (const m of text("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)) {
      // Само <t> извън фонетичните <rPh> блокове.
      const body = m[1]!.replace(/<rPh\b[\s\S]*?<\/rPh>/g, "");
      shared.push([...body.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1]!)).join(""));
    }
  }
  const cache = new Map<string, XlsxSheet>();
  return {
    sheetNames: sheets.map((s) => s.name),
    sheet(name: string) {
      const hit = cache.get(name);
      if (hit) return hit;
      const def = sheets.find((s) => s.name === name);
      if (!def) throw new Error(`Няма лист „${name}“`);
      const xml = text(def.path);
      const rows = new Map<number, Map<string, XlsxCell>>();
      let maxRow = 0;
      for (const rm of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/g)) {
        const r = Number(attr(`<row ${rm[1]}`, "r"));
        const cells = new Map<string, XlsxCell>();
        for (const cm of rm[2]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const tag = `<c ${cm[1]}`;
          const ref = attr(tag, "r") ?? "";
          const col = ref.replace(/\d+/g, "");
          const t = attr(tag, "t");
          const inner = cm[2] ?? "";
          const f = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(inner);
          const v = /<v\b[^>]*>([\s\S]*?)<\/v>/.exec(inner);
          let value: string | null = v ? decodeXml(v[1]!) : null;
          if (t === "s" && value !== null) value = shared[Number(value)] ?? null;
          if (t === "inlineStr") value = [...inner.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((x) => decodeXml(x[1]!)).join("");
          cells.set(col, { value, formula: f ? decodeXml(f[1]!) : null, type: t });
        }
        rows.set(r, cells);
        if (r > maxRow) maxRow = r;
      }
      const s = { name, rows, maxRow };
      cache.set(name, s);
      return s;
    },
  };
}

/* ---------------- Връзки от формули (без изпълнение) ---------------- */

type Tok = { k: "str"; v: string } | { k: "id"; v: string } | { k: "p"; v: string };

function tokenize(f: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < f.length) {
    const ch = f[i]!;
    if (/\s/.test(ch)) {
      i++;
    } else if (ch === '"') {
      let s = "";
      i++;
      for (;;) {
        if (i >= f.length) throw new Error("Незатворен низ във формулата");
        if (f[i] === '"') {
          if (f[i + 1] === '"') {
            s += '"';
            i += 2;
            continue;
          }
          i++;
          break;
        }
        s += f[i++];
      }
      out.push({ k: "str", v: s });
    } else if (/[A-Za-z_]/.test(ch)) {
      let s = "";
      while (i < f.length && /[A-Za-z0-9_.]/.test(f[i]!)) s += f[i++];
      out.push({ k: "id", v: s.toUpperCase() });
    } else if ("(),&".includes(ch)) {
      out.push({ k: "p", v: ch });
      i++;
    } else throw new Error(`Неподдържан символ „${ch}“ във формулата`);
  }
  return out;
}

/**
 * Безопасен разбор на ограничено подмножество: литерал | "a" & "b" | _xlfn._LONGTEXT(текст, …) (съединява частите)
 * | HYPERLINK(текст[, етикет]) | IFERROR(израз, резервен). Всичко друго (препратки към клетки, други функции) → грешка.
 */
function evalText(toks: Tok[], pos: { i: number }): { text: string; url: string | null } {
  let acc = evalTerm(toks, pos);
  while (toks[pos.i]?.k === "p" && toks[pos.i]!.v === "&") {
    pos.i++;
    const r = evalTerm(toks, pos);
    acc = { text: acc.text + r.text, url: null };
  }
  return acc;
}

function expect(toks: Tok[], pos: { i: number }, v: string) {
  const t = toks[pos.i];
  if (!t || t.k !== "p" || t.v !== v) throw new Error(`Очакваше се „${v}“`);
  pos.i++;
}

function args(toks: Tok[], pos: { i: number }) {
  expect(toks, pos, "(");
  const out: { text: string; url: string | null }[] = [];
  if (toks[pos.i]?.k === "p" && toks[pos.i]!.v === ")") {
    pos.i++;
    return out;
  }
  for (;;) {
    out.push(evalText(toks, pos));
    const t = toks[pos.i];
    if (t?.k === "p" && t.v === ",") {
      pos.i++;
      continue;
    }
    expect(toks, pos, ")");
    return out;
  }
}

function evalTerm(toks: Tok[], pos: { i: number }): { text: string; url: string | null } {
  const t = toks[pos.i];
  if (!t) throw new Error("Непълна формула");
  if (t.k === "str") {
    pos.i++;
    return { text: t.v, url: null };
  }
  if (t.k === "id") {
    pos.i++;
    const name = t.v.replace(/^_XLFN\./, "");
    const a = args(toks, pos);
    if (name === "_LONGTEXT") return { text: a.map((x) => x.text).join(""), url: null };
    if (name === "HYPERLINK") {
      if (a.length < 1 || a.length > 2) throw new Error("HYPERLINK с неочакван брой аргументи");
      return { text: a[1]?.text ?? a[0]!.text, url: a[0]!.text };
    }
    if (name === "IFERROR") {
      if (a.length !== 2) throw new Error("IFERROR с неочакван брой аргументи");
      return a[0]!;
    }
    throw new Error(`Неподдържана функция ${t.v}`);
  }
  throw new Error("Неочакван символ във формулата");
}

/** URL от формула HYPERLINK (вкл. IFERROR и _xlfn._LONGTEXT). null, ако формулата не е такава. Нищо не се изпълнява. */
export function extractHyperlinkUrl(formula: string | null | undefined): string | null {
  if (!formula || !/HYPERLINK/i.test(formula)) return null;
  const toks = tokenize(formula.replace(/^=/, ""));
  const pos = { i: 0 };
  const r = evalText(toks, pos);
  if (pos.i !== toks.length) throw new Error("Излишно съдържание след формулата");
  return r.url;
}

/** Excel serial дата (система 1900) → "YYYY-MM-DD". */
export function excelSerialToIsoDate(serial: number): string {
  const ms = Math.round((serial - 25569) * 86_400_000);
  return new Date(ms).toISOString().slice(0, 10);
}
