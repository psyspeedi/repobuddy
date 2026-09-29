// Дерево роутов из конфигурации роутера: от createRouter/createBrowserRouter/
// new VueRouter через спреды, константы, импорты и реэкспорты между файлами.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { scriptBlocks, type ScriptBlock } from './parse.ts';
import type { Resolver } from './project.ts';

export interface RouteRec {
  path: string;
  /** page — экран; layout — обёртка (Next/Nuxt); server — серверная ручка. */
  kind?: 'page' | 'layout' | 'server';
  methods?: string[];
  /** Файлы, неявно относящиеся к роуту (SvelteKit +page.ts и т.п.). */
  extra?: string[];
  name: string | null;
  file: string;
  line: number;
  endLine: number;
  component: string | null;
  meta: string | null;
  redirect: string | null;
  parent: number | null;
}

const ROUTER_FACTORIES = new Set(['provideRouter', 'createRouter', 'createBrowserRouter', 'createHashRouter', 'createMemoryRouter', 'createWebRouter']);
const ROUTER_CLASSES = new Set(['VueRouter', 'Router']);
const MAX_DEPTH = 16;

interface Loc {
  expr: ts.Expression;
  file: string;
  block: ScriptBlock;
}

interface FileSyms {
  blocks: ScriptBlock[];
  decls: Map<string, { expr: ts.Expression; block: ScriptBlock }>;
  imports: Map<string, { spec: string; imported: string }>;
  exports: Map<string, { expr?: ts.Expression; local?: string; from?: { spec: string; name: string }; block: ScriptBlock }>;
  stars: string[];
}

export class RouteExtractor {
  private syms = new Map<string, FileSyms | null>();
  private resolver: Resolver;
  private root: string;
  readonly routes: RouteRec[] = [];

  constructor(root: string, resolver: Resolver) {
    this.root = root;
    this.resolver = resolver;
  }

  extract(files: string[]): RouteRec[] {
    const needle = /createRouter|createBrowserRouter|createHashRouter|createMemoryRouter|createWebRouter|new\s+(Vue)?Router\s*\(|forRoot|provideRouter|<Route\b/;
    for (const f of files) {
      if (f.endsWith('.json')) continue;
      let text: string;
      try {
        text = fs.readFileSync(f, 'utf8');
      } catch {
        continue;
      }
      if (!needle.test(text)) continue;
      const s = this.symbols(f);
      if (!s) continue;
      for (const block of s.blocks) this.findEntries(block, f);
    }
    if (!this.routes.length) this.typedRouteArrays(files);
    return this.routes;
  }

  /** Запасной путь: массивы с типом Routes / RouteRecordRaw[] / RouteObject[]. */
  private typedRouteArrays(files: string[]): void {
    for (const f of files) {
      if (!/\.[cm]?[jt]sx?$/.test(f)) continue;
      let text: string;
      try {
        text = fs.readFileSync(f, 'utf8');
      } catch {
        continue;
      }
      if (!/:\s*(Routes|Route\[\]|RouteRecordRaw\[\]|RouteObject\[\])\s*=/.test(text)) continue;
      const s = this.symbols(f);
      for (const block of s?.blocks ?? []) {
        for (const st of block.sf.statements) {
          if (!ts.isVariableStatement(st)) continue;
          for (const d of st.declarationList.declarations) {
            if (d.initializer && d.type && /^(Routes|Route\[\]|RouteRecordRaw\[\]|RouteObject\[\])$/.test(d.type.getText(block.sf))) {
              this.collect({ expr: d.initializer, file: f, block }, '', null, 0);
            }
          }
        }
      }
    }
  }

  private findEntries(block: ScriptBlock, file: string): void {
    const visit = (n: ts.Node): void => {
      let args: ts.NodeArray<ts.Expression> | undefined;
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && ROUTER_FACTORIES.has(n.expression.text)) args = n.arguments;
      // Angular: RouterModule.forRoot(routes), provideRouter(routes).
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'forRoot' && n.expression.expression.getText(block.sf) === 'RouterModule') {
        if (n.arguments[0]) this.collect({ expr: n.arguments[0], file, block }, '', null, 0);
      }
      // JSX: <Routes><Route path element={<X/>}>…</Route></Routes> — только верхние Route.
      if ((ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n)) && jsxTag(n) === 'Route' && !insideJsxRoute(n)) {
        this.recordJsx(n, { expr: n as unknown as ts.Expression, file, block }, '', null, 0);
        return;
      }
      if (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && ROUTER_CLASSES.has(n.expression.text)) args = n.arguments;
      const a0 = args?.[0];
      if (a0) {
        let routesExpr: ts.Expression | null = null;
        const obj = this.deref({ expr: a0, file, block });
        if (obj && ts.isObjectLiteralExpression(obj.expr)) {
          const p = prop(obj.expr, 'routes');
          if (p) routesExpr = p;
          if (routesExpr) this.collect({ expr: routesExpr, file: obj.file, block: obj.block }, '', null, 0);
        } else {
          this.collect({ expr: a0, file, block }, '', null, 0);
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(block.sf);
  }

  /** Раскрывает выражение в список записей роутов. */
  private collect(loc: Loc, parentPath: string, parent: number | null, depth: number): void {
    if (depth > MAX_DEPTH) return;
    const d = this.deref(loc);
    if (!d) return;
    const e = d.expr;
    if (ts.isArrayLiteralExpression(e)) {
      for (const el of e.elements) {
        if (ts.isSpreadElement(el)) this.collect({ ...d, expr: el.expression }, parentPath, parent, depth + 1);
        else this.collect({ ...d, expr: el }, parentPath, parent, depth + 1);
      }
      return;
    }
    if (ts.isObjectLiteralExpression(e)) {
      if (!prop(e, 'path') && !prop(e, 'children')) return;
      this.record({ ...d, expr: e }, parentPath, parent, depth);
      return;
    }
    // STUBS.map((s) => ({ path: s.path, component: Stub })) — роут на каждый элемент.
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === 'map') {
      const fn = e.arguments[0];
      const body = fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) ? (ts.isBlock(fn.body) ? fn.body.statements.find(ts.isReturnStatement)?.expression : fn.body) : undefined;
      const obj = body ? unwrap(body) : undefined;
      const arr = this.deref({ ...d, expr: e.expression.expression });
      if (obj && ts.isObjectLiteralExpression(obj) && arr && ts.isArrayLiteralExpression(arr.expr)) {
        this.recordMapped(arr, obj, d, parentPath, parent);
        return;
      }
    }
    // [...].map(fn), defineRoutes([...]) — берём массив-аргумент или объект вызова.
    if (ts.isCallExpression(e)) {
      if (ts.isPropertyAccessExpression(e.expression)) this.collect({ ...d, expr: e.expression.expression }, parentPath, parent, depth + 1);
      else if (e.arguments[0]) this.collect({ ...d, expr: e.arguments[0] }, parentPath, parent, depth + 1);
    }
  }

  private record(loc: Loc, parentPath: string, parent: number | null, depth: number): void {
    const o = loc.expr as ts.ObjectLiteralExpression;
    const sf = loc.block.sf;
    const rawPath = this.str(prop(o, 'path'), loc);
    const full = joinPath(parentPath, rawPath ?? '');
    const nameE = prop(o, 'name');
    const metaE = prop(o, 'meta');
    const redirE = prop(o, 'redirect') ?? prop(o, 'redirectTo');
    const compE =
      prop(o, 'component') ?? prop(o, 'element') ?? prop(o, 'Component') ?? prop(o, 'lazy') ?? prop(o, 'loadComponent') ?? defaultOf(prop(o, 'components'));
    const rec: RouteRec = {
      path: full || '/',
      name: nameE ? (this.str(nameE, loc) ?? nameE.getText(sf)) : null,
      file: path.relative(this.root, loc.file),
      line: loc.block.lineBase + sf.getLineAndCharacterOfPosition(o.getStart(sf)).line,
      endLine: loc.block.lineBase + sf.getLineAndCharacterOfPosition(o.getEnd()).line,
      component: null,
      meta: metaE ? squeeze(metaE.getText(sf), 220) : null,
      redirect: redirE ? squeeze(redirE.getText(sf), 120) : null,
      parent,
    };
    if (compE) {
      const c = this.componentFile({ ...loc, expr: compE }, 0);
      if (c) rec.component = path.relative(this.root, c);
    }
    const idx = this.routes.push(rec) - 1;
    const ch = prop(o, 'children');
    if (ch) this.collect({ ...loc, expr: ch }, full, idx, depth + 1);
    const lazy = prop(o, 'loadChildren');
    if (lazy) this.lazyChildren({ ...loc, expr: lazy }, full, idx, depth + 1);
  }

  private recordMapped(arr: Loc, tpl: ts.ObjectLiteralExpression, fnLoc: Loc, parentPath: string, parent: number | null): void {
    const sf = arr.block.sf;
    const compE = prop(tpl, 'component') ?? prop(tpl, 'element') ?? prop(tpl, 'loadComponent');
    const comp = compE ? this.componentFile({ ...fnLoc, expr: compE }, 0) : null;
    const metaE = prop(tpl, 'meta');
    for (const el0 of (arr.expr as ts.ArrayLiteralExpression).elements) {
      const el = this.deref({ ...arr, expr: el0 });
      if (!el || !ts.isObjectLiteralExpression(el.expr)) continue;
      const raw = this.str(prop(el.expr, 'path'), el) ?? '';
      const nameE = prop(el.expr, 'name');
      this.routes.push({
        path: joinPath(parentPath, raw) || '/',
        name: nameE ? this.str(nameE, el) : null,
        file: path.relative(this.root, el.file),
        line: el.block.lineBase + el.block.sf.getLineAndCharacterOfPosition(el.expr.getStart(el.block.sf)).line,
        endLine: el.block.lineBase + el.block.sf.getLineAndCharacterOfPosition(el.expr.getEnd()).line,
        component: comp ? path.relative(this.root, comp) : null,
        meta: metaE ? squeeze(metaE.getText(fnLoc.block.sf), 220) : null,
        redirect: null,
        parent,
      });
    }
    void sf;
  }

  /** Angular loadChildren: () => import('./x').then(m => m.X) — массив роутов или NgModule с forChild. */
  private lazyChildren(loc: Loc, parentPath: string, parent: number, depth: number): void {
    let e = unwrap(loc.expr);
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
      if (ts.isBlock(e.body)) {
        const r = e.body.statements.find(ts.isReturnStatement);
        if (!r?.expression) return;
        e = r.expression;
      } else e = e.body;
    }
    let member = 'default';
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && e.expression.name.text === 'then') {
      const cb = e.arguments[0];
      if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && !ts.isBlock(cb.body) && ts.isPropertyAccessExpression(cb.body)) {
        member = cb.body.name.text;
      }
      e = e.expression.expression;
    }
    if (!ts.isCallExpression(e) || e.expression.kind !== ts.SyntaxKind.ImportKeyword) {
      // loadChildren: 'app/x.module#XModule' (старый строковый формат)
      if (ts.isStringLiteralLike(e)) {
        const [spec, mem] = e.text.split('#');
        const t = spec ? this.resolver.resolve(spec.startsWith('.') ? spec : './' + spec, loc.file) : null;
        if (t) this.childrenFromModule(t, mem ?? 'default', parentPath, parent, depth);
      }
      return;
    }
    const a0 = e.arguments[0];
    if (!a0 || !ts.isStringLiteralLike(a0)) return;
    const t = this.resolver.resolve(a0.text, loc.file);
    if (t) this.childrenFromModule(t, member, parentPath, parent, depth);
  }

  private childrenFromModule(file: string, member: string, parentPath: string, parent: number, depth: number): void {
    const ex = this.exported(file, member, 0);
    const d = ex ? this.deref(ex) : null;
    if (d && ts.isArrayLiteralExpression(d.expr)) {
      this.collect(d, parentPath, parent, depth);
      return;
    }
    // NgModule: ищем RouterModule.forChild(...) в файле и его локальных импортах.
    const queue = [file];
    const seen = new Set<string>();
    while (queue.length && seen.size < 6) {
      const f = queue.shift()!;
      if (seen.has(f)) continue;
      seen.add(f);
      const s = this.symbols(f);
      if (!s) continue;
      let found = false;
      for (const block of s.blocks) {
        const visit = (n: ts.Node): void => {
          if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'forChild' && n.arguments[0]) {
            found = true;
            this.collect({ expr: n.arguments[0], file: f, block }, parentPath, parent, depth);
          }
          ts.forEachChild(n, visit);
        };
        visit(block.sf);
      }
      if (found) return;
      for (const imp of s.imports.values()) {
        if (!imp.spec.startsWith('.')) continue;
        const t = this.resolver.resolve(imp.spec, f);
        if (t) queue.push(t);
      }
    }
  }

  /** <Route path="x" element={<X/>}> с вложенными Route. */
  private recordJsx(el: ts.JsxElement | ts.JsxSelfClosingElement, loc: Loc, parentPath: string, parent: number | null, depth: number): void {
    if (depth > MAX_DEPTH) return;
    const sf = loc.block.sf;
    const attrs = (ts.isJsxElement(el) ? el.openingElement : el).attributes.properties;
    const attr = (name: string): ts.Expression | undefined => {
      for (const a of attrs) {
        if (!ts.isJsxAttribute(a) || a.name.getText(sf) !== name) continue;
        if (!a.initializer) return ts.factory.createTrue();
        if (ts.isStringLiteral(a.initializer)) return a.initializer;
        if (ts.isJsxExpression(a.initializer) && a.initializer.expression) return a.initializer.expression;
      }
      return undefined;
    };
    const raw = this.str(attr('path'), loc) ?? '';
    const full = joinPath(parentPath, raw);
    const compE = attr('element') ?? attr('component') ?? attr('Component') ?? attr('lazy');
    const rec: RouteRec = {
      path: full || '/',
      name: null,
      file: path.relative(this.root, loc.file),
      line: loc.block.lineBase + sf.getLineAndCharacterOfPosition(el.getStart(sf)).line,
      endLine: loc.block.lineBase + sf.getLineAndCharacterOfPosition(el.getEnd()).line,
      component: null,
      meta: null,
      redirect: null,
      parent,
    };
    if (compE) {
      const c = this.componentFile({ ...loc, expr: compE }, 0);
      if (c) rec.component = path.relative(this.root, c);
    }
    const idx = this.routes.push(rec) - 1;
    if (ts.isJsxElement(el)) {
      for (const ch of el.children) {
        if ((ts.isJsxElement(ch) || ts.isJsxSelfClosingElement(ch)) && jsxTag(ch) === 'Route') this.recordJsx(ch, loc, full, idx, depth + 1);
      }
    }
  }

  /** Файл компонента роута: ленивый import(), константа, импорт, JSX-элемент. */
  private componentFile(loc: Loc, depth: number): string | null {
    if (depth > 8) return null;
    let e = unwrap(loc.expr);
    if (ts.isArrowFunction(e) || ts.isFunctionExpression(e)) {
      const body = e.body;
      if (ts.isBlock(body)) {
        const ret = body.statements.find(ts.isReturnStatement);
        if (!ret?.expression) return null;
        e = ret.expression;
      } else e = body;
      // Стрелка возвращает разметку — это сам компонент, а не ленивый загрузчик.
      if (isJsxLike(e)) return loc.file;
      return this.componentFile({ ...loc, expr: e }, depth + 1);
    }
    if (ts.isClassExpression(e)) return loc.file;
    if (ts.isCallExpression(e)) {
      if (e.expression.kind === ts.SyntaxKind.ImportKeyword && e.arguments[0] && ts.isStringLiteralLike(e.arguments[0])) {
        const r = this.resolver.resolve(e.arguments[0].text, loc.file);
        return r ? this.followDefault(r, 0) : null;
      }
      // import('x').then(m => m.X)
      if (ts.isPropertyAccessExpression(e.expression)) return this.componentFile({ ...loc, expr: e.expression.expression }, depth + 1);
      // defineAsyncComponent(() => import('x')), lazy(() => import('x'))
      if (e.arguments[0]) return this.componentFile({ ...loc, expr: e.arguments[0] }, depth + 1);
      return null;
    }
    if (ts.isJsxSelfClosingElement(e) || ts.isJsxElement(e)) {
      // <Guard><Page/></Guard> — страница внутри обёртки.
      while (ts.isJsxElement(e)) {
        const kids = e.children.filter((c): c is ts.JsxElement | ts.JsxSelfClosingElement => ts.isJsxElement(c) || ts.isJsxSelfClosingElement(c));
        if (kids.length !== 1) break;
        e = kids[0]!;
      }
      if (ts.isJsxFragment(e)) return null;
      const tag = ts.isJsxElement(e) ? e.openingElement.tagName : (e as ts.JsxSelfClosingElement).tagName;
      if (ts.isIdentifier(tag)) return this.componentFile({ ...loc, expr: tag }, depth + 1);
      return null;
    }
    if (ts.isIdentifier(e)) {
      const s = this.symbols(loc.file);
      if (!s) return null;
      const decl = s.decls.get(e.text);
      if (decl) return this.componentFile({ expr: decl.expr, file: loc.file, block: decl.block }, depth + 1);
      const imp = s.imports.get(e.text);
      if (imp) {
        const r = this.resolver.resolve(imp.spec, loc.file);
        if (!r) return null;
        if (imp.imported === 'default') return this.followDefault(r, 0);
        const ex = this.exported(r, imp.imported, 0);
        return ex ? this.componentFile(ex, depth + 1) : r;
      }
    }
    return null;
  }

  /** index.ts, реэкспортирующий default из .vue/.tsx — идём до компонента. */
  private followDefault(file: string, depth: number): string {
    if (depth > 4 || /\.(vue|tsx|jsx)$/.test(file)) return file;
    const ex = this.exported(file, 'default', 0);
    if (!ex) return file;
    const next = this.componentFile(ex, 0);
    return next && next !== file ? this.followDefault(next, depth + 1) : file;
  }

  /** Разыменование идентификаторов и импортов до выражения-значения. */
  private deref(loc: Loc, depth = 0): Loc | null {
    if (depth > MAX_DEPTH) return null;
    const e = unwrap(loc.expr);
    if (ts.isPropertyAccessExpression(e)) {
      // paths.app.root.path → значение свойства во вложенном объекте-конфиге.
      const base = this.deref({ ...loc, expr: e.expression }, depth + 1);
      if (base && ts.isObjectLiteralExpression(base.expr)) {
        const v = prop(base.expr, e.name.text);
        if (v) return this.deref({ ...base, expr: v }, depth + 1);
      }
      return { ...loc, expr: e };
    }
    if (!ts.isIdentifier(e)) return { ...loc, expr: e };
    const s = this.symbols(loc.file);
    if (!s) return null;
    const decl = s.decls.get(e.text);
    if (decl) return this.deref({ expr: decl.expr, file: loc.file, block: decl.block }, depth + 1);
    const imp = s.imports.get(e.text);
    if (!imp) return null;
    const target = this.resolver.resolve(imp.spec, loc.file);
    if (!target) return null;
    const ex = this.exported(target, imp.imported, 0);
    return ex ? this.deref(ex, depth + 1) : null;
  }

  private exported(file: string, name: string, depth: number): Loc | null {
    if (depth > 6) return null;
    const s = this.symbols(file);
    if (!s) return null;
    const ex = s.exports.get(name);
    if (ex) {
      if (ex.expr) return { expr: ex.expr, file, block: ex.block };
      if (ex.local) {
        const decl = s.decls.get(ex.local);
        if (decl) return { expr: decl.expr, file, block: decl.block };
        const imp = s.imports.get(ex.local);
        if (imp) {
          const t = this.resolver.resolve(imp.spec, file);
          return t ? this.exported(t, imp.imported, depth + 1) : null;
        }
      }
      if (ex.from) {
        const t = this.resolver.resolve(ex.from.spec, file);
        if (!t) return null;
        if (/\.(vue|tsx|jsx)$/.test(t) && ex.from.name === 'default') {
          // Сам .vue — значение неизвестно, но файл компонента нам и нужен.
          const fake = ts.factory.createCallExpression(ts.factory.createToken(ts.SyntaxKind.ImportKeyword) as any, undefined, [
            ts.factory.createStringLiteral(ex.from.spec),
          ]);
          return { expr: fake, file, block: ex.block };
        }
        return this.exported(t, ex.from.name, depth + 1);
      }
    }
    for (const spec of s.stars) {
      const t = this.resolver.resolve(spec, file);
      const r = t ? this.exported(t, name, depth + 1) : null;
      if (r) return r;
    }
    return null;
  }

  private str(e: ts.Expression | undefined, loc: Loc): string | null {
    if (!e) return null;
    const d = this.deref({ ...loc, expr: e });
    if (!d) return null;
    const x = d.expr;
    if (ts.isStringLiteralLike(x)) return x.text;
    if (ts.isTemplateExpression(x)) {
      let s = x.head.text;
      for (const span of x.templateSpans) s += (this.str(span.expression, d) ?? `{${span.expression.getText(d.block.sf)}}`) + span.literal.text;
      return s;
    }
    if (ts.isPropertyAccessExpression(x)) {
      // enum/объект констант: RouteName.X → значение члена, если найдём.
      const base = this.deref({ ...d, expr: x.expression });
      const member = x.name.text;
      if (base && ts.isObjectLiteralExpression(base.expr)) {
        const v = prop(base.expr, member);
        if (v && ts.isStringLiteralLike(v)) return v.text;
      }
      const en = base ? null : this.enumMember(d, x);
      if (en) return en;
      return x.getText(d.block.sf);
    }
    return null;
  }

  private enumMember(loc: Loc, x: ts.PropertyAccessExpression): string | null {
    if (!ts.isIdentifier(x.expression)) return null;
    const findIn = (file: string, enumName: string): string | null => {
      const s = this.symbols(file);
      if (!s) return null;
      for (const b of s.blocks) {
        for (const st of b.sf.statements) {
          if (ts.isEnumDeclaration(st) && st.name.text === enumName) {
            const m = st.members.find((mm) => mm.name.getText(b.sf) === x.name.text);
            if (m?.initializer && ts.isStringLiteralLike(m.initializer)) return m.initializer.text;
            return null;
          }
        }
      }
      const imp = s.imports.get(enumName);
      if (imp) {
        const t = this.resolver.resolve(imp.spec, file);
        if (t) return findIn(t, imp.imported === 'default' ? enumName : imp.imported);
      }
      for (const spec of s.stars) {
        const t = this.resolver.resolve(spec, file);
        const r = t ? findIn(t, enumName) : null;
        if (r) return r;
      }
      return null;
    };
    return findIn(loc.file, x.expression.text);
  }

  private symbols(file: string): FileSyms | null {
    if (this.syms.has(file)) return this.syms.get(file)!;
    let res: FileSyms | null = null;
    try {
      const { blocks } = scriptBlocks(file);
      res = { blocks, decls: new Map(), imports: new Map(), exports: new Map(), stars: [] };
      for (const block of blocks) indexBlock(block, res);
    } catch {
      res = null;
    }
    this.syms.set(file, res);
    return res;
  }
}

function indexBlock(block: ScriptBlock, s: FileSyms): void {
  const isExported = (n: ts.Node) =>
    ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
  const isDefault = (n: ts.Node) =>
    ts.canHaveModifiers(n) && (ts.getModifiers(n) ?? []).some((m) => m.kind === ts.SyntaxKind.DefaultKeyword);
  for (const st of block.sf.statements) {
    if (ts.isImportDeclaration(st) && ts.isStringLiteral(st.moduleSpecifier) && st.importClause) {
      const spec = st.moduleSpecifier.text;
      const c = st.importClause;
      if (c.name) s.imports.set(c.name.text, { spec, imported: 'default' });
      if (c.namedBindings) {
        if (ts.isNamespaceImport(c.namedBindings)) s.imports.set(c.namedBindings.name.text, { spec, imported: '*' });
        else for (const e of c.namedBindings.elements) s.imports.set(e.name.text, { spec, imported: (e.propertyName ?? e.name).text });
      }
    } else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer) {
          s.decls.set(d.name.text, { expr: d.initializer, block });
          if (isExported(st)) s.exports.set(d.name.text, { expr: d.initializer, block });
        }
      }
    } else if (ts.isExportAssignment(st)) {
      s.exports.set('default', { expr: st.expression, block });
    } else if (ts.isExportDeclaration(st)) {
      const from = st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier) ? st.moduleSpecifier.text : null;
      if (!st.exportClause) {
        if (from) s.stars.push(from);
      } else if (ts.isNamedExports(st.exportClause)) {
        for (const e of st.exportClause.elements) {
          const local = (e.propertyName ?? e.name).text;
          s.exports.set(e.name.text, from ? { from: { spec: from, name: local }, block } : { local, block });
        }
      }
    } else if ((ts.isFunctionDeclaration(st) || ts.isClassDeclaration(st)) && st.name) {
      if (isExported(st)) s.exports.set(isDefault(st) ? 'default' : st.name.text, { local: st.name.text, block });
    }
  }
}

function isJsxLike(e: ts.Expression): boolean {
  const u = unwrap(e);
  return ts.isJsxElement(u) || ts.isJsxSelfClosingElement(u) || ts.isJsxFragment(u) || (ts.isConditionalExpression(u) && isJsxLike(u.whenTrue));
}

function jsxTag(n: ts.JsxElement | ts.JsxSelfClosingElement): string {
  return (ts.isJsxElement(n) ? n.openingElement.tagName : n.tagName).getText();
}

function insideJsxRoute(n: ts.Node): boolean {
  for (let p = n.parent; p; p = p.parent) {
    if ((ts.isJsxElement(p) || ts.isJsxSelfClosingElement(p)) && jsxTag(p) === 'Route') return true;
  }
  return false;
}

function prop(o: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const p of o.properties) {
    if (ts.isPropertyAssignment(p) && p.name.getText().replace(/['"]/g, '') === name) return p.initializer;
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return p.name;
    if (ts.isMethodDeclaration(p) && p.name.getText() === name) return p as unknown as ts.Expression;
  }
  return undefined;
}

function defaultOf(e: ts.Expression | undefined): ts.Expression | undefined {
  return e && ts.isObjectLiteralExpression(e) ? prop(e, 'default') : undefined;
}

function unwrap(e: ts.Expression): ts.Expression {
  while (ts.isAsExpression(e) || ts.isParenthesizedExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression;
  return e;
}

export function joinPath(parent: string, child: string): string {
  if (child.startsWith('/')) return child;
  if (!child) return parent;
  return (parent.replace(/\/+$/, '') + '/' + child).replace(/\/{2,}/g, '/');
}

function squeeze(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}
