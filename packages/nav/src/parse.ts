// Факты об одном файле: импорты, строки, видимый текст, HTTP-вызовы, цепочки
// вызовов. Поддерживаются .ts/.js/.tsx/.jsx, .vue, .svelte, .astro и
// HTML-шаблоны Angular. Выражения из любых шаблонов прогоняются через один и
// тот же TS-обходчик, поэтому ключи, api и строки ловятся одинаково.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import sfcPkg from '@vue/compiler-sfc';
import domPkg from '@vue/compiler-dom';
import { parse as parseSvelte } from 'svelte/compiler';
import YAML from 'yaml';

const { parse: parseSfc } = sfcPkg;
const { parse: parseDom } = domPkg;

export interface ImportFact {
  spec: string;
  line: number;
  dynamic: boolean;
  /** local → imported ('default' для default-импорта, '*' для namespace). */
  names: Record<string, string>;
}

export interface ApiCall {
  method: string;
  url: string;
  line: number;
  /** Имя функции или метода, внутри которого сделан вызов. */
  owner: string | null;
}

export interface CallChain {
  chain: string[];
  line: number;
}

export interface FileFacts {
  imports: ImportFact[];
  /** Строковый фрагмент → первая строка, где встретился. */
  strings: Record<string, number>;
  /** Человекочитаемый текст (шаблоны, JSX, кириллица в скриптах). */
  texts: { t: string; line: number }[];
  apiCalls: ApiCall[];
  calls: CallChain[];
  tags: string[];
  globals: { name: string; local: string }[];
  /** Экспортируемые имена (для автоимпортов и серверных ручек). */
  exportNames: string[];
  /** Селекторы Angular-компонентов, объявленных в файле. */
  selectors: string[];
  /** Ключи из <i18n>-блока Vue SFC. */
  localKeys: { key: string; value: string; line: number }[];
}

export interface ScriptBlock {
  sf: ts.SourceFile;
  /** Номер строки файла, соответствующий первой строке блока (1-based). */
  lineBase: number;
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head', 'del']);
const METHOD_NAME: Record<string, string> = { del: 'DELETE' };
/** Получатель похож на http-клиент: тогда и однословный путь — URL (api.get('tags')). */
const CLIENT_RECEIVER = /(^|\.)(\$?https?|api\w*|\w*client|axios|\$?axios|request|ky|fetcher|rest|backend|server|agent|\$?fetch|superagent|got)$/i;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…' };
function decodeEntities(s: string): string {
  return s.replace(/&(#x[\da-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
/** Функции-загрузчики: первый аргумент — URL. */
const FETCHERS = new Set(['fetch', '$fetch', 'useFetch', 'useLazyFetch', 'ofetch', 'ky', 'got', 'useSWR', 'useSWRImmutable', 'axios', 'request', 'superagent']);
const NOISE_CALLS = new Set([
  'then', 'catch', 'finally', 'map', 'filter', 'forEach', 'push', 'includes', 'find', 'findIndex', 'some',
  'every', 'reduce', 'join', 'split', 'replace', 'toString', 'log', 'error', 'warn', 'emit', 'slice',
  'indexOf', 'trim', 'toLowerCase', 'toUpperCase', 'keys', 'values', 'entries', 'assign', 'stringify',
  'parse', 'set', 'has', 'add', 'sort', 'concat', 'format', 'startsWith', 'endsWith', 'test', 'match',
  ...HTTP_METHODS,
]);
const CYRILLIC = /[А-Яа-яЁё]/;
const KEYLIKE = /^[\w-]+(?:[.:][\w-]+)+$/;
const TEXT_ATTRS = new Set([
  'title', 'placeholder', 'label', 'aria-label', 'alt', 'text', 'description', 'tooltip', 'header', 'caption',
  'aria-description', 'aria-placeholder', 'helperText', 'helper-text', 'subtitle', 'hint', 'message', 'heading',
]);

export function scriptKindFor(file: string, lang?: string): ts.ScriptKind {
  const l = lang ?? path.extname(file).slice(1);
  if (l === 'tsx') return ts.ScriptKind.TSX;
  if (l === 'jsx') return ts.ScriptKind.JSX;
  if (l === 'ts' || l === 'mts' || l === 'cts') return ts.ScriptKind.TS;
  // .js тоже может содержать JSX (CRA, Next) — парсер JSX терпит обычный JS.
  if (l === 'js' || l === 'mjs' || l === 'cjs') return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function lineStarts(src: string): number[] {
  const res = [0];
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) res.push(i + 1);
  return res;
}

function lineAt(starts: number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid]! <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Скриптовые блоки файла для резолва символов (роуты и т.п.). */
export function scriptBlocks(file: string, text?: string): { blocks: ScriptBlock[]; template: any | null } {
  const src = text ?? fs.readFileSync(file, 'utf8');
  if (file.endsWith('.vue')) {
    const { descriptor } = parseSfc(src, { filename: file, ignoreEmpty: false });
    const blocks: ScriptBlock[] = [];
    for (const b of [descriptor.script, descriptor.scriptSetup]) {
      if (!b) continue;
      const sf = ts.createSourceFile(file, b.content, ts.ScriptTarget.Latest, true, scriptKindFor(file, b.lang ?? 'js'));
      blocks.push({ sf, lineBase: b.loc.start.line });
    }
    return { blocks, template: descriptor.template?.ast ?? null };
  }
  if (file.endsWith('.svelte')) return { blocks: svelteScripts(file, src).blocks, template: null };
  if (file.endsWith('.astro')) {
    const fm = astroFrontmatter(src);
    return { blocks: fm ? [{ sf: ts.createSourceFile(file, fm.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), lineBase: fm.lineBase }] : [], template: null };
  }
  if (file.endsWith('.html')) return { blocks: [], template: null };
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, scriptKindFor(file));
  return { blocks: [{ sf, lineBase: 1 }], template: null };
}

export function emptyFacts(): FileFacts {
  return { imports: [], strings: {}, texts: [], apiCalls: [], calls: [], tags: [], globals: [], exportNames: [], selectors: [], localKeys: [] };
}

export function extractFacts(file: string): FileFacts {
  const facts = emptyFacts();
  const src = fs.readFileSync(file, 'utf8');
  const tags = new Set<string>();
  if (file.endsWith('.vue')) {
    const { descriptor } = parseSfc(src, { filename: file, ignoreEmpty: false });
    for (const b of [descriptor.script, descriptor.scriptSetup]) {
      if (!b) continue;
      const sf = ts.createSourceFile(file, b.content, ts.ScriptTarget.Latest, true, scriptKindFor(file, b.lang ?? 'js'));
      visitScript(sf, b.loc.start.line, facts, true, tags);
    }
    const tpl = descriptor.template;
    // Своё дерево с сохранёнными пробелами: в готовом ast многострочный текст схлопнут
    // и теряет номера строк. pug и прочие препроцессоры не разбираем.
    if (tpl && (!tpl.lang || tpl.lang === 'html')) parseDomTemplate(tpl.content, tpl.loc.start.line, facts, tags);
    for (const cb of descriptor.customBlocks) {
      if (cb.type === 'i18n') facts.localKeys.push(...sfcI18nKeys(cb.content, cb.lang, cb.loc.start.line));
    }
  } else if (file.endsWith('.svelte')) {
    extractSvelte(file, src, facts, tags);
  } else if (file.endsWith('.astro')) {
    extractAstro(file, src, facts, tags);
  } else if (file.endsWith('.html')) {
    visitHtml(src, 1, facts, tags);
  } else if (file.endsWith('.md') || file.endsWith('.mdx')) {
    // Видимый текст markdown построчно, без кода и фронтматтера.
    let fence = false;
    src.split('\n').forEach((l, i) => {
      if (/^\s*(```|~~~|---\s*$)/.test(l)) fence = !fence;
      else if (!fence && !/^\s*(import|export)\s/.test(l)) addText(facts, l.replace(/^[#>*\-\d.\s]+|[*_`]/g, ''), i + 1);
    });
  } else {
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, scriptKindFor(file));
    visitScript(sf, 1, facts, true, tags);
  }
  facts.tags = [...tags];
  return facts;
}

function addString(facts: FileFacts, s: string, line: number): void {
  const norm = s.trim().replace(/^\.+|\.+$/g, '');
  if (!norm || norm.length > 300) return;
  if (!(norm in facts.strings)) facts.strings[norm] = line;
  // i18next: 'ns:key' → 'ns.key'; Angular i18n: '@@id' → 'id'.
  if (/^[\w-]+:[\w.-]+$/.test(norm)) {
    const dotted = norm.replace(':', '.');
    if (!(dotted in facts.strings)) facts.strings[dotted] = line;
  }
}

/** Многострочный текстовый узел: куски, разделённые строками без букв, — каждый со своей строкой. */
function addTextChunks(facts: FileFacts, content: string, startLine: number): void {
  const lines = content.split('\n');
  let chunk: string[] = [];
  let chunkLine = startLine;
  const flush = () => {
    if (chunk.length) addText(facts, chunk.join(' '), chunkLine);
    chunk = [];
  };
  lines.forEach((l, i) => {
    if (/\p{L}/u.test(l)) {
      if (!chunk.length) chunkLine = startLine + i;
      chunk.push(l);
    } else flush();
  });
  flush();
}

function addText(facts: FileFacts, s: string, line: number): void {
  const t = decodeEntities(s).replace(/\s+/g, ' ').trim();
  if (t.length < 2 || !/\p{L}/u.test(t)) return;
  facts.texts.push({ t: t.slice(0, 300), line });
  // Текст узла может быть ключом: <span translate>MENU.HOME</span>.
  if (KEYLIKE.test(t)) addString(facts, t, line);
}

// ---------------- скрипты ----------------

function visitScript(sf: ts.SourceFile, lineBase: number, facts: FileFacts, topLevel: boolean, tags: Set<string>): void {
  const lineOf = (n: ts.Node) => lineBase + sf.getLineAndCharacterOfPosition(n.getStart(sf)).line;
  const consts = new Map<string, string>();
  const destructured = new Map<string, string[]>();
  const importedLocals = new Set<string>();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !st.importClause) continue;
    const c = st.importClause;
    if (c.name) importedLocals.add(c.name.text);
    if (c.namedBindings && ts.isNamedImports(c.namedBindings)) for (const e of c.namedBindings.elements) importedLocals.add(e.name.text);
  }

  // Первый проход: строковые константы и деструктуризация цепочек.
  const pre = (n: ts.Node): void => {
    if (ts.isVariableDeclaration(n) && n.initializer) {
      if (ts.isIdentifier(n.name)) {
        const v = stringValue(n.initializer, consts);
        if (v !== null) consts.set(n.name.text, v);
      } else if (ts.isObjectBindingPattern(n.name)) {
        const base = flattenChain(n.initializer);
        if (base) {
          for (const el of n.name.elements) {
            if (!ts.isIdentifier(el.name)) continue;
            const prop = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
            destructured.set(el.name.text, [...base, prop]);
          }
        }
      }
    }
    ts.forEachChild(n, pre);
  };
  pre(sf);

  if (topLevel) collectExports(sf, facts);

  const visit = (n: ts.Node): void => {
    if (topLevel && ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
      if (!n.importClause?.isTypeOnly) {
        const names: Record<string, string> = {};
        const c = n.importClause;
        if (c?.name) names[c.name.text] = 'default';
        if (c?.namedBindings) {
          if (ts.isNamespaceImport(c.namedBindings)) names[c.namedBindings.name.text] = '*';
          else for (const e of c.namedBindings.elements) names[e.name.text] = (e.propertyName ?? e.name).text;
        }
        facts.imports.push({ spec: n.moduleSpecifier.text, line: lineOf(n), dynamic: false, names });
      }
      return;
    }
    if (topLevel && ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      facts.imports.push({ spec: n.moduleSpecifier.text, line: lineOf(n), dynamic: false, names: {} });
      return;
    }
    if (ts.isDecorator(n)) onDecorator(n);
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
      addString(facts, n.text, lineOf(n));
      if (CYRILLIC.test(n.text)) addText(facts, n.text, lineOf(n));
    } else if (ts.isTemplateExpression(n)) {
      addString(facts, n.head.text, lineOf(n));
      for (const span of n.templateSpans) addString(facts, span.literal.text, lineOf(n));
      // Префикс из константы: `${prefix}.key` → полный ключ тоже в строки.
      const full = stringValue(n, consts);
      if (full !== null) addString(facts, full, lineOf(n));
      const cyr = [n.head.text, ...n.templateSpans.map((s) => s.literal.text)].join(' ');
      if (CYRILLIC.test(cyr)) addText(facts, cyr, lineOf(n));
    } else if (
      ts.isPropertyAccessExpression(n) &&
      !ts.isPropertyAccessExpression(n.parent) &&
      !(ts.isCallExpression(n.parent) && n.parent.expression === n)
    ) {
      // Ссылка без вызова: return api.modules.v3.x.executeCode — тоже потребитель.
      const chain = flattenChain(n);
      if (chain && chain.length >= 3 && !chain[0]!.endsWith('()') && chain[0] !== 'this') facts.calls.push({ chain, line: lineOf(n) });
    } else if (ts.isTaggedTemplateExpression(n)) {
      onTagged(n);
    } else if (ts.isCallExpression(n)) {
      onCall(n);
    } else if (ts.isJsxText(n)) {
      // Видимый текст JSX — на любом языке, как текст шаблона.
      addTextChunks(facts, n.text, lineBase + sf.getLineAndCharacterOfPosition(n.pos).line);
    } else if (ts.isJsxAttribute(n) && n.initializer && ts.isStringLiteral(n.initializer) && TEXT_ATTRS.has(n.name.getText())) {
      addText(facts, n.initializer.text, lineOf(n));
    } else if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const tag = n.tagName.getText();
      if (/^[A-Z]/.test(tag)) tags.add(tag);
      if (/(^|\.)(form|Form)$/.test(tag)) {
        const attr = (name: string) => {
          const a = n.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText() === name) as ts.JsxAttribute | undefined;
          return a?.initializer && ts.isStringLiteral(a.initializer) ? a.initializer.text : null;
        };
        const action = attr('action');
        if (action?.startsWith('/')) facts.apiCalls.push({ method: (attr('method') ?? 'GET').toUpperCase(), url: action, line: lineOf(n), owner: null });
      }
    }
    ts.forEachChild(n, visit);
  };

  const onDecorator = (d: ts.Decorator): void => {
    const e = d.expression;
    if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression) || e.expression.text !== 'Component') return;
    const arg = e.arguments[0];
    if (!arg || !ts.isObjectLiteralExpression(arg)) return;
    for (const p of arg.properties) {
      if (!ts.isPropertyAssignment(p)) continue;
      const name = p.name.getText();
      const v = p.initializer;
      if (name === 'selector' && ts.isStringLiteralLike(v)) {
        for (const s of v.text.split(',')) {
          const sel = s.trim();
          if (/^[a-z][\w-]*$/.test(sel)) facts.selectors.push(sel);
        }
      } else if (name === 'templateUrl' && ts.isStringLiteralLike(v)) {
        facts.imports.push({ spec: v.text.startsWith('.') ? v.text : './' + v.text, line: lineOf(p), dynamic: true, names: {} });
      } else if (name === 'template' && (ts.isStringLiteralLike(v) || ts.isTemplateExpression(v))) {
        const raw = v.getText(sf).slice(1, -1);
        visitHtml(raw, lineOf(v), facts, tags);
      }
    }
  };

  const onTagged = (n: ts.TaggedTemplateExpression): void => {
    const tag = n.tag.getText(sf);
    if (tag !== 'gql' && tag !== 'graphql' && !tag.endsWith('.gql')) return;
    const body = n.template.getText(sf);
    const m = /\b(query|mutation|subscription|fragment)\s+(\w+)/.exec(body);
    if (m && m[1] !== 'fragment') {
      facts.apiCalls.push({ method: m[1]!.toUpperCase(), url: m[2]!, line: lineOf(n), owner: ownerName(n) });
    }
  };

  const onCall = (n: ts.CallExpression): void => {
    let callee: ts.Expression = n.expression;
    // (globalThis.$fetch as any)('/x'), (0, fetch)('/x')
    while (ts.isParenthesizedExpression(callee) || ts.isAsExpression(callee) || ts.isNonNullExpression(callee)) callee = callee.expression;
    const arg0 = n.arguments[0];
    if (topLevel && callee.kind === ts.SyntaxKind.ImportKeyword && arg0 && ts.isStringLiteralLike(arg0)) {
      facts.imports.push({ spec: arg0.text, line: lineOf(n), dynamic: true, names: {} });
      return;
    }
    if (topLevel && ts.isIdentifier(callee) && callee.text === 'require' && arg0 && ts.isStringLiteralLike(arg0)) {
      facts.imports.push({ spec: arg0.text, line: lineOf(n), dynamic: true, names: {} });
      return;
    }
    if (ts.isPropertyAccessExpression(callee)) {
      const m = callee.name.text;
      if (HTTP_METHODS.has(m) && arg0) {
        const loose = CLIENT_RECEIVER.test(callee.expression.getText(sf).replace(/\s+/g, ''));
        for (const url of urlValues(arg0, consts, loose)) {
          facts.apiCalls.push({ method: METHOD_NAME[m] ?? m.toUpperCase(), url, line: lineOf(n), owner: ownerName(n) });
        }
      }
      // globalThis.$fetch('/x'), window.fetch('/x')
      if (FETCHERS.has(m) && !HTTP_METHODS.has(m) && arg0 && !ts.isObjectLiteralExpression(arg0)) {
        for (const url of urlValues(arg0, consts, false)) {
          facts.apiCalls.push({ method: methodFromOptions(n.arguments[1], consts) ?? 'GET', url, line: lineOf(n), owner: ownerName(n) });
        }
      }
      if (m === 'request' && arg0 && ts.isObjectLiteralExpression(arg0)) pushConfigCall(n, arg0);
      if (m === 'component' && arg0 && ts.isStringLiteralLike(arg0) && n.arguments[1] && ts.isIdentifier(n.arguments[1])) {
        facts.globals.push({ name: arg0.text, local: n.arguments[1].text });
      }
      const chain = flattenChain(callee);
      if (chain && chain.length >= 2 && !NOISE_CALLS.has(chain[chain.length - 1]!)) {
        facts.calls.push({ chain, line: lineOf(n) });
        // typesafe-i18n / paraglide: LL.home.title() → ключ home.title.
        if (/^\$?LL$|^m$/.test(chain[0]!)) addString(facts, chain.slice(1).join('.').replace(/\(\)/g, ''), lineOf(n));
      }
      return;
    }
    if (!ts.isIdentifier(callee)) return;
    const name = callee.text;
    if (FETCHERS.has(name) && arg0) {
      if (ts.isObjectLiteralExpression(arg0)) pushConfigCall(n, arg0);
      else {
        for (const url of urlValues(arg0, consts, false)) {
          facts.apiCalls.push({ method: methodFromOptions(n.arguments[1], consts) ?? 'GET', url, line: lineOf(n), owner: ownerName(n) });
        }
      }
    }
    if (destructured.has(name)) facts.calls.push({ chain: destructured.get(name)!, line: lineOf(n) });
    else if ((importedLocals.has(name) || /^(use[A-Z]|\$[a-z])/.test(name)) && !NOISE_CALLS.has(name)) {
      facts.calls.push({ chain: [name], line: lineOf(n) });
    }
  };

  const pushConfigCall = (n: ts.CallExpression, cfg: ts.ObjectLiteralExpression): void => {
    let url: string | null = null;
    let method = 'GET';
    for (const p of cfg.properties) {
      if (!ts.isPropertyAssignment(p)) continue;
      const k = p.name.getText();
      if (k === 'url') url = urlValues(p.initializer, consts, true)[0] ?? null;
      if (k === 'method') method = (stringValue(p.initializer, consts) ?? 'GET').toUpperCase();
    }
    if (url) facts.apiCalls.push({ method, url, line: lineOf(n), owner: ownerName(n) });
  };

  visit(sf);
}

function collectExports(sf: ts.SourceFile, facts: FileFacts): void {
  const has = (n: ts.Node, k: ts.SyntaxKind) => ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === k);
  for (const st of sf.statements) {
    if (ts.isVariableStatement(st) && has(st, ts.SyntaxKind.ExportKeyword)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name)) facts.exportNames.push(d.name.text);
    } else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name && has(st, ts.SyntaxKind.ExportKeyword)) {
      facts.exportNames.push(has(st, ts.SyntaxKind.DefaultKeyword) ? 'default' : st.name.text);
    } else if (ts.isExportAssignment(st)) {
      facts.exportNames.push('default');
    } else if (ts.isExportDeclaration(st) && st.exportClause && ts.isNamedExports(st.exportClause)) {
      for (const e of st.exportClause.elements) facts.exportNames.push(e.name.text);
    }
  }
}

function methodFromOptions(opts: ts.Expression | undefined, consts: Map<string, string>): string | null {
  if (!opts || !ts.isObjectLiteralExpression(opts)) return null;
  for (const p of opts.properties) {
    if (ts.isPropertyAssignment(p) && p.name.getText() === 'method') return (stringValue(p.initializer, consts) ?? '').toUpperCase() || null;
  }
  return null;
}

/** a.b.c() → ['a','b','c']; useApi().x.y → ['useApi()','x','y']. */
function flattenChain(e: ts.Expression): string[] | null {
  if (ts.isIdentifier(e)) return [e.text];
  if (e.kind === ts.SyntaxKind.ThisKeyword) return ['this'];
  if (ts.isPropertyAccessExpression(e)) {
    const base = flattenChain(e.expression);
    return base ? [...base, e.name.text] : null;
  }
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) {
    const base = flattenChain(e.expression);
    return base ? [...base, e.argumentExpression.text] : null;
  }
  if (ts.isCallExpression(e)) {
    const base = flattenChain(e.expression);
    if (!base) return null;
    base[base.length - 1] += '()';
    return base;
  }
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) return flattenChain(e.expression);
  return null;
}

function stringValue(e: ts.Expression, consts: Map<string, string>): string | null {
  if (ts.isStringLiteralLike(e)) return e.text;
  if (ts.isIdentifier(e)) return consts.get(e.text) ?? null;
  if (ts.isAsExpression(e) || ts.isParenthesizedExpression(e)) return stringValue(e.expression, consts);
  if (ts.isTemplateExpression(e)) {
    let s = e.head.text;
    for (const span of e.templateSpans) {
      const v = stringValue(span.expression, consts);
      if (v === null) return null;
      s += v + span.literal.text;
    }
    return s;
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const a = stringValue(e.left, consts);
    const b = stringValue(e.right, consts);
    return a !== null && b !== null ? a + b : null;
  }
  return null;
}

/**
 * URL с плейсхолдерами на месте неизвестных частей: `/v1/x/${id}` → /v1/x/{id}.
 * Тернарник разворачивается в варианты: '/a' + (f ? '/feed' : '') → /a/feed, /a.
 * loose — получатель похож на http-клиент, тогда допустим и путь без «/» ('tags').
 */
function urlValues(e: ts.Expression, consts: Map<string, string>, loose: boolean): string[] {
  const parts = (x: ts.Expression): string[] => {
    while (ts.isParenthesizedExpression(x) || ts.isAsExpression(x)) x = x.expression;
    if (ts.isStringLiteralLike(x)) return [x.text];
    if (ts.isIdentifier(x)) return [consts.get(x.text) ?? `{${x.text}}`];
    if (ts.isConditionalExpression(x)) return [...parts(x.whenTrue), ...parts(x.whenFalse)].slice(0, 4);
    if (ts.isTemplateExpression(x)) {
      let acc = [x.head.text];
      for (const span of x.templateSpans) {
        const mid = ts.isConditionalExpression(span.expression)
          ? parts(span.expression)
          : [stringValue(span.expression, consts) ?? `{${span.expression.getText().slice(0, 30)}}`];
        acc = acc.flatMap((a) => mid.map((m) => a + m + span.literal.text)).slice(0, 4);
      }
      return acc;
    }
    if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const l = parts(x.left);
      const r = parts(x.right);
      return l.flatMap((a) => r.map((b) => a + b)).slice(0, 4);
    }
    return [`{${x.getText().slice(0, 30)}}`];
  };
  if (ts.isIdentifier(e) && !consts.has(e.text)) return [];
  const out: string[] = [];
  for (const s of parts(e)) {
    if (!s || /\s/.test(s) || s.startsWith('{')) continue;
    const pathLike = s.includes('/') && /^(\/|https?:\/\/|[\w-]+\/)/.test(s);
    const segment = loose && /^[a-z][\w-]*(\/|\?|$|\{)/i.test(s) && !/^(true|false|null|undefined)$/.test(s);
    if (pathLike || segment) out.push(s);
  }
  return [...new Set(out)];
}

function ownerName(n: ts.Node): string | null {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if ((ts.isMethodDeclaration(p) || ts.isFunctionDeclaration(p) || ts.isGetAccessor(p)) && p.name) return p.name.getText();
    if (ts.isPropertyAssignment(p) && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))) return p.name.getText();
    if (ts.isVariableDeclaration(p) && p.initializer && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))) return p.name.getText();
  }
  return null;
}

function visitExpression(code: string, line: number, facts: FileFacts, tags: Set<string>): void {
  // v-for="x in xs", *ngFor="let x of xs" — не выражение; берём правую часть.
  const m = /^\s*(?:let\s+)?(?:\(?[^)]*\)?|\w+)\s+(?:in|of)\s+([\s\S]+?)(?:;[\s\S]*)?$/.exec(code);
  const src = `(${m ? m[1] : code})`;
  const sf = ts.createSourceFile('expr.tsx', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  visitScript(sf, line, facts, false, tags);
}

// ---------------- DOM-шаблоны: Vue, Angular, Astro ----------------

const NODE_ELEMENT = 1;
const NODE_TEXT = 2;
const NODE_INTERPOLATION = 5;
const PROP_ATTRIBUTE = 6;
const PROP_DIRECTIVE = 7;

function visitDomTemplate(node: any, facts: FileFacts, tags: Set<string>): void {
  if (!node) return;
  if (node.type === NODE_ELEMENT) {
    const tag: string = node.tag;
    if (/^[A-Z]/.test(tag) || tag.includes('-')) tags.add(toPascal(tag));
    if (tag === 'form' || tag === 'Form') {
      const attr = (name: string) => (node.props ?? []).find((p: any) => p.type === PROP_ATTRIBUTE && p.name === name)?.value?.content as string | undefined;
      const action = attr('action');
      if (action?.startsWith('/')) facts.apiCalls.push({ method: (attr('method') ?? 'GET').toUpperCase(), url: action, line: node.loc.start.line, owner: null });
    }
    for (const p of node.props ?? []) {
      const line = p.loc?.start?.line ?? node.loc.start.line;
      if (p.type === PROP_ATTRIBUTE) {
        const v: string | undefined = p.value?.content;
        const name: string = p.name;
        if (!v) continue;
        if (/^[[(*]|^bind-|^on-/.test(name)) {
          // Angular: [title]="'KEY' | translate", (click)="save()", *ngIf="x".
          visitExpression(v, line, facts, tags);
        } else if (name === 'i18n' || name.startsWith('i18n-')) {
          const id = v.split('@@')[1];
          if (id) addString(facts, id, line);
        } else {
          addString(facts, v, line);
          if (TEXT_ATTRS.has(name) || CYRILLIC.test(v)) addText(facts, v, line);
        }
      } else if (p.type === PROP_DIRECTIVE && p.exp?.content) {
        visitExpression(p.exp.content, line, facts, tags);
      }
    }
  } else if (node.type === NODE_TEXT) {
    addTextChunks(facts, node.content, node.loc.start.line);
  } else if (node.type === NODE_INTERPOLATION && node.content?.content) {
    visitExpression(node.content.content, node.loc.start.line, facts, tags);
  }
  for (const c of node.children ?? []) visitDomTemplate(c, facts, tags);
}

/** HTML-шаблон (Angular, Astro-разметка) через терпимый парсер Vue. */
function visitHtml(src: string, lineBase: number, facts: FileFacts, tags: Set<string>): void {
  // Control flow Angular 17+ (@if (...) {, @for, } ) — не текст; вырезаем с сохранением строк.
  const cleaned = src
    // «} @else {» — закрывающая скобка перед следующим блоком.
    .replace(/\}(\s*)(?=@(?:else|empty|placeholder|loading|error)\b)/g, ' $1')
    .replace(/@(?:if|else if|else|for|switch|case|default|defer|placeholder|loading|error|empty)\b[^{\n]*\{/g, (s) => {
      const cond = /\(([\s\S]*)\)/.exec(s)?.[1];
      return cond ? ` {{ ${cond.replace(/;[\s\S]*$/, '')} }} ` : ' ';
    })
    .replace(/^[ \t]*\}[ \t]*$/gm, '');
  parseDomTemplate(cleaned, lineBase, facts, tags);
}

function parseDomTemplate(src: string, lineBase: number, facts: FileFacts, tags: Set<string>): void {
  let ast: any;
  try {
    ast = parseDom(src, { onError: () => {}, onWarn: () => {}, comments: false, whitespace: 'preserve' } as any);
  } catch {
    return;
  }
  const shift = (n: any): void => {
    if (!n || typeof n !== 'object') return;
    if (n.loc?.start) n.loc.start.line += lineBase - 1;
    for (const p of n.props ?? []) if (p.loc?.start) p.loc.start.line += lineBase - 1;
    for (const c of n.children ?? []) shift(c);
  };
  shift(ast);
  visitDomTemplate(ast, facts, tags);
}

function toPascal(tag: string): string {
  return tag.includes('-') ? tag.split('-').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('') : tag;
}

// ---------------- Svelte ----------------

const SVELTE_NODES = new Set([
  'Root', 'Fragment', 'Text', 'RegularElement', 'Component', 'Attribute', 'ExpressionTag', 'IfBlock', 'EachBlock',
  'AwaitBlock', 'KeyBlock', 'SnippetBlock', 'HtmlTag', 'ConstTag', 'RenderTag', 'DebugTag', 'SvelteElement',
  'SvelteComponent', 'SvelteSelf', 'SvelteWindow', 'SvelteBody', 'SvelteHead', 'SvelteDocument', 'SvelteFragment',
  'SvelteBoundary', 'SlotElement', 'TitleElement', 'OnDirective', 'BindDirective', 'ClassDirective', 'StyleDirective',
  'UseDirective', 'TransitionDirective', 'AnimateDirective', 'LetDirective', 'SpreadAttribute', 'AttachTag', 'Comment',
  'Script', 'StyleSheet',
]);

function svelteScripts(file: string, src: string): { blocks: ScriptBlock[]; ast: any } {
  const ast: any = parseSvelte(src, { modern: true });
  const starts = lineStarts(src);
  const blocks: ScriptBlock[] = [];
  for (const s of [ast.module, ast.instance]) {
    if (!s?.content) continue;
    const code = src.slice(s.content.start, s.content.end);
    const lang = (s.attributes ?? []).find((a: any) => a.name === 'lang');
    const isTs = Array.isArray(lang?.value) && lang.value[0]?.data === 'ts';
    blocks.push({
      sf: ts.createSourceFile(file, code, ts.ScriptTarget.Latest, true, isTs ? ts.ScriptKind.TS : ts.ScriptKind.JS),
      lineBase: lineAt(starts, s.content.start),
    });
  }
  return { blocks, ast };
}

function extractSvelte(file: string, src: string, facts: FileFacts, tags: Set<string>): void {
  const { blocks, ast } = svelteScripts(file, src);
  for (const b of blocks) visitScript(b.sf, b.lineBase, facts, true, tags);
  const starts = lineStarts(src);
  const walk = (n: any, parentType: string | null): void => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) {
      for (const x of n) walk(x, parentType);
      return;
    }
    const type: string | undefined = n.type;
    if (type && !SVELTE_NODES.has(type) && typeof n.start === 'number') {
      // ESTree-выражение внутри шаблона.
      visitExpression(src.slice(n.start, n.end), lineAt(starts, n.start), facts, tags);
      return;
    }
    if (type === 'Text' && parentType !== 'Attribute') addTextChunks(facts, n.data ?? '', lineAt(starts, n.start));
    if (type === 'Attribute' && Array.isArray(n.value)) {
      const text = n.value.filter((v: any) => v.type === 'Text').map((v: any) => v.data).join('');
      if (text) {
        addString(facts, text, lineAt(starts, n.start));
        if (TEXT_ATTRS.has(n.name) || CYRILLIC.test(text)) addText(facts, text, lineAt(starts, n.start));
      }
    }
    if ((type === 'Component' || type === 'SvelteComponent') && n.name) tags.add(n.name);
    for (const [k, v] of Object.entries(n)) {
      if (k === 'parent' || k === 'metadata' || k === 'instance' || k === 'module' || k === 'css' || k === 'loc' || k === 'name_loc') continue;
      if (v && typeof v === 'object') walk(v, type ?? parentType);
    }
  };
  walk(ast.fragment, null);
}

// ---------------- Astro ----------------

function astroFrontmatter(src: string): { code: string; lineBase: number; end: number } | null {
  const m = /^\s*---\r?\n([\s\S]*?)\r?\n---/.exec(src);
  if (!m) return null;
  const before = src.slice(0, m.index + m[0].indexOf('\n') + 1);
  return { code: m[1]!, lineBase: before.split('\n').length, end: m.index + m[0].length };
}

function extractAstro(file: string, src: string, facts: FileFacts, tags: Set<string>): void {
  const fm = astroFrontmatter(src);
  if (fm) visitScript(ts.createSourceFile(file, fm.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS), fm.lineBase, facts, true, tags);
  const offset = fm ? fm.end : 0;
  const body = src.slice(offset);
  const baseLine = src.slice(0, offset).split('\n').length;
  // {выражения} — через TS-обходчик, в разметке заменяем пробелами (строки сохраняются).
  const starts = lineStarts(body);
  let out = '';
  let last = 0;
  let depth = 0;
  let from = -1;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    if (ch === '{') {
      if (depth === 0) from = i;
      depth++;
    } else if (ch === '}' && depth > 0) {
      depth--;
      if (depth === 0 && from >= 0) {
        const expr = body.slice(from + 1, i);
        visitExpression(expr, baseLine + lineAt(starts, from) - 1, facts, tags);
        out += body.slice(last, from) + expr.replace(/[^\n]/g, ' ') + '  ';
        last = i + 1;
      }
    }
  }
  out += body.slice(last);
  visitHtml(out, baseLine, facts, tags);
}

// ---------------- <i18n> в Vue SFC ----------------

function sfcI18nKeys(content: string, lang: string | undefined, lineBase: number): { key: string; value: string; line: number }[] {
  let data: any;
  try {
    data = lang === 'yaml' || lang === 'yml' ? YAML.parse(content) : JSON.parse(content);
  } catch {
    return [];
  }
  if (!data || typeof data !== 'object') return [];
  const langs = Object.keys(data);
  const pick = langs.find((l) => l === 'ru') ?? langs.find((l) => /^[a-z]{2}(-\w+)?$/.test(l));
  const root = pick ? data[pick] : data;
  const out: { key: string; value: string; line: number }[] = [];
  const lines = content.split('\n');
  const walk = (o: any, prefix: string[]): void => {
    for (const [k, v] of Object.entries(o ?? {})) {
      if (typeof v === 'string') {
        const idx = lines.findIndex((l) => l.includes(k) && l.includes(v.slice(0, 20)));
        out.push({ key: [...prefix, k].join('.'), value: v, line: lineBase + Math.max(idx, 0) });
      } else if (v && typeof v === 'object') walk(v, [...prefix, k]);
    }
  };
  walk(root, []);
  return out;
}
