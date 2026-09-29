// Ключи локалей в плоском виде. Префикс ключа — путь файла внутри
// locales/<lang>/: pages/taxDeduction.json → pages.taxDeduction.*;
// locales/ru.json → без префикса. index-файлы — агрегаторы, их пропускаем.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { scriptKindFor } from './parse.ts';

export interface LocaleKey {
  value: string;
  file: string;
  line: number;
}

const LANG_RE = /^[a-z]{2}(?:[-_][A-Za-z]{2,4})?$/;

interface LocaleFile {
  lang: string;
  prefix: string[];
}

export function localeInfo(rel: string): LocaleFile | null {
  const parts = rel.split(/[\\/]/);
  const i = parts.findLastIndex((p) => p === 'locales' || p === 'locale' || p === 'i18n' || p === 'lang');
  if (i < 0) return null;
  const rest = parts.slice(i + 1);
  if (!rest.length) return null;
  const ext = path.extname(rest[rest.length - 1]!);
  if (!['.json', '.js', '.ts', '.mjs'].includes(ext)) return null;
  rest[rest.length - 1] = rest[rest.length - 1]!.slice(0, -ext.length);
  if (rest.length === 1) return LANG_RE.test(rest[0]!) ? { lang: rest[0]!, prefix: [] } : null;
  if (!LANG_RE.test(rest[0]!)) return null;
  const prefix = rest.slice(1);
  if (prefix[prefix.length - 1] === 'index') {
    // index.json в корне языка — сами ключи; index.ts — агрегатор.
    if (ext !== '.json') return null;
    prefix.pop();
  }
  return { lang: rest[0]!, prefix };
}

export function loadLocaleFile(abs: string, rel: string, out: Map<string, LocaleKey>, prefix: string[]): void {
  const text = fs.readFileSync(abs, 'utf8');
  let root: ts.Expression | undefined;
  let sf: ts.SourceFile;
  if (abs.endsWith('.json')) {
    sf = ts.parseJsonText(abs, text);
    root = (sf.statements[0] as ts.ExpressionStatement | undefined)?.expression;
  } else {
    sf = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, true, scriptKindFor(abs));
    for (const st of sf.statements) {
      if (ts.isExportAssignment(st)) root = st.expression;
    }
  }
  const walkObj = (e: ts.Expression | undefined, keyPath: string[]): void => {
    while (e && (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isSatisfiesExpression(e))) e = e.expression;
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

/** Выбирает язык: явно заданный, иначе ru, иначе тот, где больше файлов. */
export function pickLang(langs: Map<string, number>, wanted?: string): string | null {
  if (wanted && langs.has(wanted)) return wanted;
  if (langs.has('ru')) return 'ru';
  let best: string | null = null;
  let n = -1;
  for (const [l, c] of langs) if (c > n) [best, n] = [l, c];
  return best;
}
