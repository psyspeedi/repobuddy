// Ключи локалей в плоском виде. Префикс ключа — путь файла внутри
// <locales>/<lang>/: pages/taxDeduction.json → pages.taxDeduction.*;
// <locales>/ru.json → без префикса. index-файлы — агрегаторы, их пропускаем.
// Форматы: JSON, YAML, JS/TS (export default, module.exports, обёртки),
// gettext .po (Lingui) и XLIFF (Angular) — у последних ключи глобальные.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import YAML from 'yaml';
import { scriptKindFor } from './parse.ts';
import { LOCALE_DIRS } from './project.ts';

export interface LocaleKey {
  value: string;
  file: string;
  line: number;
  /** Переводы на другие языки: поиск по тексту идёт по всем. */
  alts?: Record<string, { value: string; file: string; line: number }>;
}

// ru, en-US, zh-Hans, es-419, ca-valencia, sr-Latn-RS; трёхбуквенные — только известные,
// иначе api.json / app.json приняли бы за язык.
const THREE = new Set(['fil', 'haw', 'yue', 'ast', 'ckb', 'kab', 'gsw', 'nds', 'sah', 'tzm', 'arn', 'fur', 'ceb', 'nqo', 'kmr']);
const LANG_RE = /^([a-z]{2}|[a-z]{3})(?:[-_](?:[A-Za-z]{2,4}|\d{3}|[a-z]{5,8}))*$/;
export function isLang(s: string): boolean {
  if (!LANG_RE.test(s)) return false;
  const primary = s.split(/[-_]/)[0]!;
  return primary.length === 2 || THREE.has(primary);
}
const FLAT_FORMATS = new Set(['.po', '.xlf', '.xliff']);

interface LocaleFile {
  lang: string;
  prefix: string[];
}

export function localeInfo(rel: string): LocaleFile | null {
  const parts = rel.split(/[\\/]/);
  const i = parts.findLastIndex((p) => LOCALE_DIRS.includes(p));
  if (i < 0) return null;
  const rest = parts.slice(i + 1);
  if (!rest.length) return null;
  const file = rest[rest.length - 1]!;
  const ext = path.extname(file);
  if (!['.json', '.js', '.ts', '.mjs', '.yml', '.yaml', '.po', '.xlf', '.xliff'].includes(ext)) return null;
  const base = file.slice(0, -ext.length);
  rest[rest.length - 1] = base;
  if (FLAT_FORMATS.has(ext)) {
    // messages.ru.xlf, ru/messages.po, ru.po
    const fromName = base.split('.').reverse().find((x) => isLang(x));
    const lang = fromName ?? rest.find((x) => isLang(x));
    return lang ? { lang, prefix: [] } : null;
  }
  if (rest.length === 1) {
    if (isLang(base)) return { lang: base, prefix: [] };
    // common.ru.json
    const dotted = base.split('.');
    if (dotted.length === 2 && isLang(dotted[1]!)) return { lang: dotted[1]!, prefix: [dotted[0]!] };
    return null;
  }
  if (!isLang(rest[0]!)) return null;
  const prefix = rest.slice(1);
  if (prefix[prefix.length - 1] === 'index') {
    // index.json в корне языка — сами ключи; index.ts — обычно агрегатор, но
    // если в нём объект со строками, ключи тоже возьмём.
    prefix.pop();
  }
  return { lang: rest[0]!, prefix };
}

export function loadLocaleFile(abs: string, rel: string, out: Map<string, LocaleKey>, prefix: string[]): void {
  const text = fs.readFileSync(abs, 'utf8');
  const ext = path.extname(abs);
  if (ext === '.po') return loadPo(text, rel, out);
  if (ext === '.xlf' || ext === '.xliff') return loadXliff(text, rel, out);
  if (ext === '.yml' || ext === '.yaml') return loadYaml(text, rel, out, prefix);
  let root: ts.Expression | undefined;
  let sf: ts.SourceFile;
  if (ext === '.json') {
    sf = ts.parseJsonText(abs, text);
    root = (sf.statements[0] as ts.ExpressionStatement | undefined)?.expression;
  } else {
    sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, scriptKindFor(abs));
    const decls = new Map<string, ts.Expression>();
    for (const st of sf.statements) {
      if (ts.isVariableStatement(st)) {
        for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && d.initializer) decls.set(d.name.text, d.initializer);
      }
      if (ts.isExportAssignment(st)) root = st.expression;
      // module.exports = {...}
      if (ts.isExpressionStatement(st) && ts.isBinaryExpression(st.expression) && st.expression.left.getText(sf) === 'module.exports') {
        root = st.expression.right;
      }
    }
    if (root && ts.isIdentifier(root)) root = decls.get(root.text);
  }
  const walkObj = (e: ts.Expression | undefined, keyPath: string[]): void => {
    e = dig(e);
    if (!e || !ts.isObjectLiteralExpression(e)) return;
    for (const p of e.properties) {
      if (!ts.isPropertyAssignment(p)) continue;
      const name = ts.isIdentifier(p.name) || ts.isStringLiteralLike(p.name) || ts.isNumericLiteral(p.name) ? p.name.text : null;
      if (name === null) continue;
      const k = [...keyPath, name];
      const v = p.initializer;
      if (ts.isStringLiteralLike(v)) {
        out.set(k.join('.'), { value: v.text, file: rel, line: sf.getLineAndCharacterOfPosition(p.getStart(sf)).line + 1 });
      } else {
        walkObj(v, k);
      }
    }
  };
  walkObj(root, prefix);
}

/** as/satisfies/скобки, () => ({...}), defineI18nLocale(() => ({...})), defineMessages({...}). */
function dig(e: ts.Expression | undefined): ts.Expression | undefined {
  for (let i = 0; e && i < 8; i++) {
    if (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isSatisfiesExpression(e)) e = e.expression;
    else if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
      if (ts.isBlock(e.body)) {
        const ret = e.body.statements.find(ts.isReturnStatement);
        e = ret?.expression;
      } else e = e.body;
    } else if (ts.isCallExpression(e)) e = e.arguments.find((a) => ts.isObjectLiteralExpression(a) || ts.isArrowFunction(a) || ts.isFunctionExpression(a));
    else break;
  }
  return e;
}

function loadYaml(text: string, rel: string, out: Map<string, LocaleKey>, prefix: string[]): void {
  const lc = new YAML.LineCounter();
  const doc = YAML.parseDocument(text, { lineCounter: lc });
  const walkNode = (node: any, keyPath: string[]): void => {
    if (!YAML.isMap(node)) return;
    for (const pair of node.items) {
      const key = YAML.isScalar(pair.key) ? String(pair.key.value) : null;
      if (key === null) continue;
      const k = [...keyPath, key];
      if (YAML.isScalar(pair.value) && typeof pair.value.value === 'string') {
        const pos = (pair.key as any).range?.[0] ?? 0;
        out.set(k.join('.'), { value: pair.value.value, file: rel, line: lc.linePos(pos).line });
      } else walkNode(pair.value, k);
    }
  };
  // Rails-стиль: корень — язык (ru: {...}); снимаем его.
  let root: any = doc.contents;
  if (YAML.isMap(root) && root.items.length === 1 && YAML.isScalar(root.items[0]!.key) && isLang(String((root.items[0]!.key as any).value))) {
    root = root.items[0]!.value;
  }
  walkNode(root, prefix);
}

function loadPo(text: string, rel: string, out: Map<string, LocaleKey>): void {
  const lines = text.split('\n');
  let msgid: string | null = null;
  let ctx: string | null = null;
  let idLine = 0;
  const unq = (s: string) => JSON.parse(s.trim()) as string;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!.trim();
    if (l.startsWith('msgctxt ')) ctx = unq(l.slice(8));
    else if (l.startsWith('msgid ')) {
      msgid = unq(l.slice(6));
      idLine = i + 1;
      while (lines[i + 1]?.trim().startsWith('"')) msgid += unq(lines[++i]!);
    } else if (l.startsWith('msgstr ') && msgid) {
      let str = unq(l.slice(7));
      while (lines[i + 1]?.trim().startsWith('"')) str += unq(lines[++i]!);
      out.set(ctx ? `${ctx}.${msgid}` : msgid, { value: str || msgid, file: rel, line: idLine });
      msgid = null;
      ctx = null;
    }
  }
}

function loadXliff(text: string, rel: string, out: Map<string, LocaleKey>): void {
  const re = /<(trans-unit|unit)\b[^>]*\bid="([^"]+)"[^>]*>([\s\S]*?)<\/\1>/g;
  let m: RegExpExecArray | null;
  const strip = (s: string | undefined) => (s ?? '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
  while ((m = re.exec(text))) {
    const body = m[3]!;
    const target = /<target[^>]*>([\s\S]*?)<\/target>/.exec(body)?.[1];
    const source = /<source[^>]*>([\s\S]*?)<\/source>/.exec(body)?.[1];
    const line = text.slice(0, m.index).split('\n').length;
    out.set(m[2]!, { value: strip(target) || strip(source), file: rel, line });
  }
}

/**
 * Основной язык: явно заданный → defaultLocale из конфигов → ru → en →
 * тот, где больше ключей.
 */
export function pickLang(langs: Map<string, number>, wanted?: string | null): string | null {
  const find = (l: string) => [...langs.keys()].find((x) => x.toLowerCase() === l.toLowerCase());
  for (const l of [wanted, 'ru', 'ru-RU', 'ru_RU', 'en', 'en-US', 'en_US', 'en-GB']) {
    const hit = l ? find(l) : undefined;
    if (hit) return hit;
  }
  let best: string | null = null;
  let n = -1;
  for (const [l, c] of langs) if (c > n) [best, n] = [l, c];
  return best;
}

/** Порядок запасных языков для ключей, которых нет в основном. */
export function fallbackOrder(langs: string[], primary: string | null): string[] {
  const rank = (l: string) => (l === primary ? 0 : /^en\b|^en[-_]/i.test(l) ? 1 : 2);
  return [...langs].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
}

/** defaultLocale / defaultLanguage / sourceLocale из типовых конфигов i18n. */
export function configuredLocale(root: string): string | null {
  const candidates = [
    'nuxt.config.ts', 'nuxt.config.js', 'next.config.js', 'next.config.mjs', 'next.config.ts', 'astro.config.mjs', 'astro.config.ts',
    'i18n.config.ts', 'i18n.ts', 'i18n.js', 'src/i18n.ts', 'src/i18n/index.ts', 'src/i18n/routing.ts', 'src/i18n/request.ts',
    'next-i18next.config.js', 'lingui.config.ts', 'lingui.config.js', 'project.inlang/settings.json', 'svelte.config.js',
    'src/lib/i18n.ts', 'src/lib/i18n/index.ts', 'angular.json', 'transloco.config.ts',
  ];
  for (const c of candidates) {
    let text: string;
    try {
      text = fs.readFileSync(path.join(root, c), 'utf8');
    } catch {
      continue;
    }
    const m = /\b(?:defaultLocale|defaultLanguage|sourceLocale|baseLocale|fallbackLocale|sourceLanguageTag|baseLanguageTag)["']?\s*[:=]\s*["']([\w-]+)["']/.exec(text);
    if (m) return m[1]!;
  }
  return null;
}
