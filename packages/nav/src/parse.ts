// Факты об одном файле: импорты, строки, видимый текст, HTTP-вызовы, цепочки
// вызовов. Для .vue разбираются <script>, <script setup> и шаблон.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import sfcPkg from '@vue/compiler-sfc';

const { parse: parseSfc } = sfcPkg;

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
  /** Человекочитаемый текст (шаблон, кириллица в скриптах). */
  texts: { t: string; line: number }[];
  apiCalls: ApiCall[];
  calls: CallChain[];
  tags: string[];
  globals: { name: string; local: string }[];
}

export interface ScriptBlock {
  sf: ts.SourceFile;
  /** Номер строки файла, соответствующий первой строке блока (1-based). */
  lineBase: number;
}

const HTTP_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'head']);
const NOISE_CALLS = new Set([
  'then', 'catch', 'finally', 'map', 'filter', 'forEach', 'push', 'includes', 'find', 'findIndex', 'some',
  'every', 'reduce', 'join', 'split', 'replace', 'toString', 'log', 'error', 'warn', 'emit', 'slice',
  'indexOf', 'trim', 'toLowerCase', 'toUpperCase', 'keys', 'values', 'entries', 'assign', 'stringify',
  'parse', 'set', 'has', 'add', 'sort', 'concat', 'format', 'startsWith', 'endsWith', 'test', 'match',
  ...HTTP_METHODS,
]);
const CYRILLIC = /[А-Яа-яЁё]/;

export function scriptKindFor(file: string, lang?: string): ts.ScriptKind {
  const l = lang ?? path.extname(file).slice(1);
  if (l === 'tsx') return ts.ScriptKind.TSX;
  if (l === 'jsx') return ts.ScriptKind.JSX;
  if (l === 'ts' || l === 'mts' || l === 'cts') return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

/** Скриптовые блоки файла: один для .ts/.js, до двух для .vue. */
export function scriptBlocks(file: string, text?: string): { blocks: ScriptBlock[]; template: any | null } {
  const src = text ?? fs.readFileSync(file, 'utf8');
  if (!file.endsWith('.vue')) {
    const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true, scriptKindFor(file));
    return { blocks: [{ sf, lineBase: 1 }], template: null };
  }
  const { descriptor } = parseSfc(src, { filename: file, ignoreEmpty: false });
  const blocks: ScriptBlock[] = [];
  for (const b of [descriptor.script, descriptor.scriptSetup]) {
    if (!b) continue;
    const sf = ts.createSourceFile(file, b.content, ts.ScriptTarget.Latest, true, scriptKindFor(file, b.lang ?? 'js'));
    blocks.push({ sf, lineBase: b.loc.start.line });
  }
  return { blocks, template: descriptor.template?.ast ?? null };
}

export function extractFacts(file: string): FileFacts {
  const facts: FileFacts = { imports: [], strings: {}, texts: [], apiCalls: [], calls: [], tags: [], globals: [] };
  const { blocks, template } = scriptBlocks(file);
  const tags = new Set<string>();
  for (const b of blocks) visitScript(b.sf, b.lineBase, facts, true);
  if (template) visitTemplate(template, facts, tags);
  facts.tags = [...tags];
  return facts;
}

function addString(facts: FileFacts, s: string, line: number): void {
  const norm = s.trim().replace(/^\.+|\.+$/g, '');
  if (!norm || norm.length > 200) return;
  if (!(norm in facts.strings)) facts.strings[norm] = line;
}

function addText(facts: FileFacts, s: string, line: number): void {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length < 2 || !/\p{L}/u.test(t)) return;
  facts.texts.push({ t: t.slice(0, 300), line });
}

function visitScript(sf: ts.SourceFile, lineBase: number, facts: FileFacts, collectImports: boolean): void {
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

  const visit = (n: ts.Node): void => {
    if (collectImports && ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) {
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
    if (collectImports && ts.isExportDeclaration(n) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      facts.imports.push({ spec: n.moduleSpecifier.text, line: lineOf(n), dynamic: false, names: {} });
      return;
    }
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
    } else if (ts.isCallExpression(n)) {
      onCall(n);
    } else if (ts.isJsxText(n)) {
      // Видимый текст JSX — на любом языке, как текст шаблона Vue.
      const lead = n.text.length - n.text.trimStart().length;
      addText(facts, n.text, lineBase + sf.getLineAndCharacterOfPosition(n.getStart(sf) + lead).line);
    } else if (ts.isJsxAttribute(n) && n.initializer && ts.isStringLiteral(n.initializer) && TEXT_ATTRS.has(n.name.getText())) {
      addText(facts, n.initializer.text, lineOf(n));
    }
    ts.forEachChild(n, visit);
  };

  const onCall = (n: ts.CallExpression): void => {
    const callee = n.expression;
    const arg0 = n.arguments[0];
    if (collectImports && callee.kind === ts.SyntaxKind.ImportKeyword && arg0 && ts.isStringLiteralLike(arg0)) {
      facts.imports.push({ spec: arg0.text, line: lineOf(n), dynamic: true, names: {} });
      return;
    }
    if (collectImports && ts.isIdentifier(callee) && callee.text === 'require' && arg0 && ts.isStringLiteralLike(arg0)) {
      facts.imports.push({ spec: arg0.text, line: lineOf(n), dynamic: true, names: {} });
      return;
    }
    if (ts.isPropertyAccessExpression(callee)) {
      const m = callee.name.text;
      if (HTTP_METHODS.has(m) && arg0) {
        const url = urlValue(arg0, consts);
        if (url) facts.apiCalls.push({ method: m.toUpperCase(), url, line: lineOf(n), owner: ownerName(n) });
      }
      if (m === 'component' && arg0 && ts.isStringLiteralLike(arg0) && n.arguments[1] && ts.isIdentifier(n.arguments[1])) {
        facts.globals.push({ name: arg0.text, local: n.arguments[1].text });
      }
      const chain = flattenChain(callee);
      if (chain && chain.length >= 2 && !NOISE_CALLS.has(chain[chain.length - 1]!)) {
        facts.calls.push({ chain, line: lineOf(n) });
      }
    } else if (ts.isIdentifier(callee) && destructured.has(callee.text)) {
      facts.calls.push({ chain: destructured.get(callee.text)!, line: lineOf(n) });
    } else if (ts.isIdentifier(callee) && importedLocals.has(callee.text) && !NOISE_CALLS.has(callee.text)) {
      facts.calls.push({ chain: [callee.text], line: lineOf(n) });
    }
  };

  visit(sf);
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

/** URL с плейсхолдерами на месте неизвестных частей: `/v1/x/${id}` → /v1/x/{id}. */
function urlValue(e: ts.Expression, consts: Map<string, string>): string | null {
  let s: string | null = null;
  if (ts.isStringLiteralLike(e) || ts.isIdentifier(e)) s = stringValue(e, consts);
  else if (ts.isTemplateExpression(e)) {
    s = e.head.text;
    for (const span of e.templateSpans) {
      s += (stringValue(span.expression, consts) ?? `{${span.expression.getText().slice(0, 30)}}`) + span.literal.text;
    }
  } else if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const a = urlValue(e.left, consts);
    const b = stringValue(e.right, consts) ?? (ts.isIdentifier(e.right) ? `{${e.right.text}}` : null);
    s = a !== null && b !== null ? a + b : null;
  }
  if (!s || /\s/.test(s) || !s.includes('/')) return null;
  if (!/^(\/|https?:\/\/|\{|[\w-]+\/)/.test(s)) return null;
  return s;
}

function ownerName(n: ts.Node): string | null {
  for (let p: ts.Node | undefined = n.parent; p; p = p.parent) {
    if ((ts.isMethodDeclaration(p) || ts.isFunctionDeclaration(p) || ts.isGetAccessor(p)) && p.name) return p.name.getText();
    if (ts.isPropertyAssignment(p) && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))) return p.name.getText();
    if (ts.isVariableDeclaration(p) && p.initializer && (ts.isArrowFunction(p.initializer) || ts.isFunctionExpression(p.initializer))) return p.name.getText();
  }
  return null;
}

// ---- шаблон Vue ----

const NODE_ELEMENT = 1;
const NODE_TEXT = 2;
const NODE_INTERPOLATION = 5;
const PROP_ATTRIBUTE = 6;
const PROP_DIRECTIVE = 7;
const TEXT_ATTRS = new Set(['title', 'placeholder', 'label', 'aria-label', 'alt', 'text', 'description', 'tooltip', 'header', 'caption']);

function visitTemplate(node: any, facts: FileFacts, tags: Set<string>): void {
  if (!node) return;
  if (node.type === NODE_ELEMENT) {
    const tag: string = node.tag;
    if (/^[A-Z]/.test(tag) || tag.includes('-')) tags.add(toPascal(tag));
    for (const p of node.props ?? []) {
      const line = p.loc?.start?.line ?? node.loc.start.line;
      if (p.type === PROP_ATTRIBUTE && p.value?.content) {
        addString(facts, p.value.content, line);
        if (TEXT_ATTRS.has(p.name) || CYRILLIC.test(p.value.content)) addText(facts, p.value.content, line);
      } else if (p.type === PROP_DIRECTIVE && p.exp?.content) {
        visitExpression(p.exp.content, line, facts);
      }
    }
  } else if (node.type === NODE_TEXT) {
    addText(facts, node.content, node.loc.start.line);
  } else if (node.type === NODE_INTERPOLATION && node.content?.content) {
    visitExpression(node.content.content, node.loc.start.line, facts);
  }
  for (const c of node.children ?? []) visitTemplate(c, facts, tags);
}

function visitExpression(code: string, line: number, facts: FileFacts): void {
  // v-for="x in xs" — не выражение; берём правую часть.
  const m = /^\s*(?:\(?[^)]*\)?|\w+)\s+(?:in|of)\s+([\s\S]+)$/.exec(code);
  const src = `(${m ? m[1] : code})`;
  const sf = ts.createSourceFile('expr.ts', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  visitScript(sf, line, facts, false);
}

function toPascal(tag: string): string {
  return tag.includes('-') ? tag.split('-').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('') : tag;
}
