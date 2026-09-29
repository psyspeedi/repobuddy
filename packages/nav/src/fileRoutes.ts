// Роуты по структуре файлов: Next (app/pages), Nuxt 2/3/4, SvelteKit, Remix /
// React Router v7 (flat routes и app/routes.ts), Astro, Gatsby, SolidStart,
// TanStack Router, Expo Router, Qwik City. Фреймворк — по зависимостям.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { RouteRec } from './routes.ts';
import { joinPath } from './routes.ts';

const HTTP_EXPORTS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export interface FileRouteInput {
  root: string;
  /** Относительные пути всех файлов проекта. */
  files: string[];
  deps: Set<string>;
  exportsOf: (rel: string) => string[];
}

interface Draft {
  rec: RouteRec;
  /** Каталог-владелец (для привязки к layout). */
  dir: string;
}

export function fileRoutes(input: FileRouteInput): RouteRec[] {
  const out: RouteRec[] = [];
  const d = input.deps;
  const has = (...names: string[]) => names.some((n) => d.has(n));
  if (has('next')) {
    for (const base of ['app', 'src/app']) nextApp(input, base, out);
    for (const base of ['pages', 'src/pages']) nextPages(input, base, out);
  }
  if (has('nuxt', 'nuxt3', 'nuxt-edge')) nuxt(input, out);
  else if (has('unplugin-vue-router', 'vite-plugin-pages', 'vue-router/vite')) vuePages(input, ['src/pages', 'src/views'], out);
  if (has('@sveltejs/kit')) sveltekit(input, 'src/routes', out);
  if (has('@remix-run/react', '@remix-run/dev', '@react-router/dev')) remix(input, out);
  if (has('astro')) simplePages(input, 'src/pages', ['.astro', '.md', '.mdx', '.tsx', '.jsx', '.ts', '.js'], out, { endpoints: true });
  if (has('gatsby')) simplePages(input, 'src/pages', ['.tsx', '.jsx', '.ts', '.js'], out, {});
  if (has('@solidjs/start', 'solid-start')) simplePages(input, 'src/routes', ['.tsx', '.jsx', '.ts', '.js'], out, { endpoints: true, groups: true });
  if (has('@builder.io/qwik-city')) qwik(input, out);
  if (has('@tanstack/react-router', '@tanstack/solid-router', '@tanstack/vue-router') && !has('@remix-run/react')) tanstack(input, out);
  if (has('expo-router')) expo(input, out);
  return out;
}

// ---------------- общее ----------------

function under(files: string[], base: string): string[] {
  const pre = base.replace(/\/+$/, '') + '/';
  return files.filter((f) => f.startsWith(pre));
}

/** [id] → :id, [[id]] → :id?, [...slug] → :slug*, [[...slug]] → :slug*?, [id=m] → :id. */
function bracketSeg(seg: string): string {
  let m = /^\[\[\.\.\.(\w+)\]\]$/.exec(seg);
  if (m) return `:${m[1]}*?`;
  m = /^\[\.\.\.(\w+)(?:=\w+)?\]$/.exec(seg);
  if (m) return `:${m[1]}*`;
  m = /^\[\[(\w+)(?:=\w+)?\]\]$/.exec(seg);
  if (m) return `:${m[1]}?`;
  return seg.replace(/\[(\w+)(?:=\w+)?\]/g, ':$1');
}

function toPath(segs: string[]): string {
  const p = '/' + segs.filter(Boolean).join('/');
  return p.replace(/\/{2,}/g, '/');
}

function mk(input: FileRouteInput, file: string, p: string, kind: RouteRec['kind'], extra: Partial<RouteRec> = {}): RouteRec {
  let lines = 1;
  try {
    lines = fs.readFileSync(path.join(input.root, file), 'utf8').split('\n').length;
  } catch {
    // файл мог исчезнуть между обходом и разбором
  }
  return { path: p || '/', name: null, file, line: 1, endLine: lines, component: kind === 'server' ? null : file, meta: null, redirect: null, parent: null, kind, ...extra };
}

function methodsOf(input: FileRouteInput, file: string): string[] {
  return input.exportsOf(file).filter((n) => HTTP_EXPORTS.includes(n));
}

/** Кладёт черновики в out, связывая страницы с ближайшим layout выше по каталогам. */
function link(drafts: Draft[], out: RouteRec[]): void {
  const layouts = drafts.filter((x) => x.rec.kind === 'layout').sort((a, b) => a.dir.length - b.dir.length);
  const idx = new Map<Draft, number>();
  for (const l of layouts) {
    const parent = [...layouts].reverse().find((p) => p !== l && isAncestor(p.dir, l.dir));
    l.rec.parent = parent ? idx.get(parent)! : null;
    idx.set(l, out.push(l.rec) - 1);
  }
  for (const x of drafts) {
    if (x.rec.kind === 'layout') continue;
    const parent = [...layouts].reverse().find((p) => isAncestor(p.dir, x.dir));
    if (parent && x.rec.kind !== 'server') x.rec.parent = idx.get(parent)!;
    out.push(x.rec);
  }
}

function isAncestor(a: string, b: string): boolean {
  return a === b || b.startsWith(a + '/') || a === '';
}

// ---------------- Next.js ----------------

function nextApp(input: FileRouteInput, base: string, out: RouteRec[]): void {
  const files = under(input.files, base);
  if (!files.some((f) => /\/page\.[jt]sx?$|\/page\.mdx$/.test(f))) return;
  const drafts: Draft[] = [];
  for (const f of files) {
    const rel = f.slice(base.length + 1);
    const m = /^(.*?)(?:^|\/)(page|layout|route|template|not-found|error|loading|default)\.(tsx|jsx|ts|js|mdx)$/.exec(rel);
    if (!m) continue;
    const dir = m[1]!;
    const segs = dir ? dir.split('/') : [];
    if (segs.some((s) => s.startsWith('_') || /^\(\.+\)/.test(s))) continue; // приватные и перехватывающие
    const urlSegs = segs.filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith('@')).map(bracketSeg);
    const p = toPath(urlSegs);
    const kind = m[2] === 'page' ? 'page' : m[2] === 'route' ? 'server' : m[2] === 'layout' || m[2] === 'template' ? 'layout' : null;
    if (!kind) continue;
    drafts.push({ rec: mk(input, f, p, kind, kind === 'server' ? { methods: methodsOf(input, f) } : {}), dir });
  }
  link(drafts, out);
}

function nextPages(input: FileRouteInput, base: string, out: RouteRec[]): void {
  const files = under(input.files, base).filter((f) => /\.(tsx|jsx|ts|js|mdx)$/.test(f));
  if (!files.length) return;
  for (const f of files) {
    const rel = f.slice(base.length + 1).replace(/\.(tsx|jsx|ts|js|mdx)$/, '');
    const segs = rel.split('/');
    if (/^_(app|document|error|middleware)$/.test(segs[segs.length - 1]!)) continue;
    if (segs[segs.length - 1] === 'index') segs.pop();
    const p = toPath(segs.map(bracketSeg));
    const server = segs[0] === 'api';
    out.push(mk(input, f, p, server ? 'server' : 'page'));
  }
}

// ---------------- Nuxt ----------------

function nuxt(input: FileRouteInput, out: RouteRec[]): void {
  vuePages(input, ['app/pages', 'pages', 'src/pages'], out);
  nuxtExtras(input, out);
}

/** Страницы в стиле Nuxt / unplugin-vue-router / vite-plugin-pages. */
function vuePages(input: FileRouteInput, bases: string[], out: RouteRec[]): void {
  const base = bases.find((b) => under(input.files, b).some((f) => f.endsWith('.vue')));
  if (base) {
    const files = under(input.files, base).filter((f) => f.endsWith('.vue'));
    const nuxt2 = !files.some((f) => f.includes('['));
    const seg = (s: string) => (nuxt2 && s.startsWith('_') ? ':' + s.slice(1) + (s === '_' ? '*' : '') : bracketSeg(s));
    const byPath = new Map<string, number>();
    // Родители раньше детей: users.vue раньше users/[id].vue.
    const sorted = files.map((f) => ({ f, segs: f.slice(base.length + 1, -4).split('/') })).sort((a, b) => a.segs.length - b.segs.length);
    for (const { f, segs } of sorted) {
      const urlSegs = segs.filter((s) => !/^\(.*\)$/.test(s)).map(seg);
      if (urlSegs[urlSegs.length - 1] === 'index') urlSegs.pop();
      const p = toPath(urlSegs);
      const rec = mk(input, f, p, 'page');
      // pages/users.vue — родитель для pages/users/*.vue (NuxtPage внутри).
      const parentKey = segs.slice(0, -1).join('/');
      if (parentKey && byPath.has(parentKey)) rec.parent = byPath.get(parentKey)!;
      const i = out.push(rec) - 1;
      byPath.set(segs.join('/'), i);
    }
  }
}

function nuxtExtras(input: FileRouteInput, out: RouteRec[]): void {
  for (const lb of ['app/layouts', 'layouts', 'src/layouts']) {
    for (const f of under(input.files, lb).filter((x) => x.endsWith('.vue'))) {
      out.push(mk(input, f, `layout:${path.basename(f, '.vue')}`, 'layout'));
    }
  }
  for (const [sb, prefix] of [['server/api', '/api'], ['server/routes', ''], ['src/server/api', '/api']] as const) {
    for (const f of under(input.files, sb).filter((x) => /\.[cm]?[jt]s$/.test(x))) {
      let rel = f.slice(sb.length + 1).replace(/\.[cm]?[jt]s$/, '');
      const mm = /\.(get|post|put|patch|delete|head)$/.exec(rel);
      if (mm) rel = rel.slice(0, -mm[0].length);
      const segs = rel.split('/');
      if (segs[segs.length - 1] === 'index') segs.pop();
      out.push(mk(input, f, joinPath(prefix || '/', segs.map(bracketSeg).join('/')), 'server', { methods: mm ? [mm[1]!.toUpperCase()] : ['*'] }));
    }
  }
}

// ---------------- SvelteKit ----------------

function sveltekit(input: FileRouteInput, base: string, out: RouteRec[]): void {
  const files = under(input.files, base);
  const drafts: Draft[] = [];
  for (const f of files) {
    const rel = f.slice(base.length + 1);
    const m = /^(.*?)(?:^|\/)\+(page|layout|server)(\.server)?\.(svelte|ts|js)$/.exec(rel);
    if (!m) continue;
    const dir = m[1]!;
    const segs = dir ? dir.split('/') : [];
    const p = toPath(segs.filter((s) => !/^\(.*\)$/.test(s)).map(bracketSeg));
    if (m[2] === 'server') {
      drafts.push({ rec: mk(input, f, p, 'server', { methods: methodsOf(input, f) }), dir });
    } else if (m[4] === 'svelte') {
      // +page.ts / +page.server.ts рядом — загрузка данных этой страницы.
      const extra = files.filter((x) => x.startsWith(path.posix.join(base, dir, `+${m[2]}.`)) && !x.endsWith('.svelte'));
      drafts.push({ rec: mk(input, f, p, m[2] === 'page' ? 'page' : 'layout', { extra }), dir });
    }
  }
  link(drafts, out);
}

// ---------------- Remix / React Router v7 ----------------

function remix(input: FileRouteInput, out: RouteRec[]): void {
  const cfg = ['app/routes.ts', 'app/routes.tsx', 'app/routes.js'].find((f) => input.files.includes(f));
  if (cfg) {
    routesConfig(input, cfg, out);
    if (out.length) return;
  }
  const base = 'app/routes';
  for (const f of under(input.files, base)) {
    const rel = f.slice(base.length + 1);
    let name: string;
    if (/^[^/]+\.(tsx|jsx|ts|js|mdx)$/.test(rel)) name = rel.replace(/\.(tsx|jsx|ts|js|mdx)$/, '');
    else {
      const m = /^([^/]+)\/route\.(tsx|jsx|ts|js)$/.exec(rel);
      if (!m) continue;
      name = m[1]!;
    }
    const segs = name.replace(/\[\.\]/g, '\u0000').split('.').map((s) => s.replace(/\u0000/g, '.'));
    const url: string[] = [];
    for (const s of segs) {
      if (s === '_index' || s === 'index') continue;
      if (s.startsWith('_')) continue; // pathless layout
      const clean = s.endsWith('_') ? s.slice(0, -1) : s;
      url.push(clean === '$' ? '*' : clean.startsWith('$') ? ':' + clean.slice(1) : clean.replace(/^\(\$?(\w+)\)$/, ':$1?'));
    }
    const exps = input.exportsOf(f);
    const server = !exps.includes('default') && (exps.includes('loader') || exps.includes('action'));
    out.push(mk(input, f, toPath(url), server ? 'server' : 'page'));
  }
}

/** app/routes.ts: route('p', 'file', [..]), index('file'), layout('file', [..]), prefix('p', [..]). */
function routesConfig(input: FileRouteInput, cfg: string, out: RouteRec[]): void {
  const abs = path.join(input.root, cfg);
  const sf = ts.createSourceFile(abs, fs.readFileSync(abs, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const appDir = path.posix.dirname(cfg);
  const fileOf = (s: string) => {
    const f = path.posix.normalize(path.posix.join(appDir, s));
    return input.files.includes(f) ? f : null;
  };
  const walkArr = (arr: ts.Expression | undefined, parentPath: string, parent: number | null): void => {
    if (!arr || !ts.isArrayLiteralExpression(arr)) return;
    for (const el of arr.elements) {
      const e = ts.isSpreadElement(el) ? el.expression : el;
      if (!ts.isCallExpression(e) || !ts.isIdentifier(e.expression)) continue;
      const fn = e.expression.text;
      const [a0, a1, a2] = e.arguments;
      const s0 = a0 && ts.isStringLiteralLike(a0) ? a0.text : null;
      const s1 = a1 && ts.isStringLiteralLike(a1) ? a1.text : null;
      const line = sf.getLineAndCharacterOfPosition(e.getStart(sf)).line + 1;
      const add = (p: string, file: string | null, kind: RouteRec['kind']) =>
        out.push({ path: p || '/', name: null, file: cfg, line, endLine: sf.getLineAndCharacterOfPosition(e.getEnd()).line + 1, component: file, meta: null, redirect: null, parent, kind }) - 1;
      if (fn === 'route' && s0 !== null) {
        const p = joinPath(parentPath || '/', s0.replace(/^\//, ''));
        const i = add(p, s1 ? fileOf(s1) : null, 'page');
        walkArr(a2 ?? (a1 && ts.isArrayLiteralExpression(a1) ? a1 : undefined), p, i);
      } else if (fn === 'index' && s0) add(parentPath || '/', fileOf(s0), 'page');
      else if (fn === 'layout' && s0) {
        const i = add(parentPath || '/', fileOf(s0), 'layout');
        walkArr(a1, parentPath, i);
      } else if (fn === 'prefix' && s0 !== null) walkArr(a1, joinPath(parentPath || '/', s0.replace(/^\//, '')), parent);
    }
  };
  const visit = (n: ts.Node): void => {
    if (ts.isExportAssignment(n)) {
      let e = n.expression;
      while (ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isParenthesizedExpression(e)) e = e.expression;
      if (ts.isCallExpression(e) && e.arguments[0]) e = e.arguments[0]; // flatRoutes() и т.п. — пропускаем
      walkArr(e, '', null);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
}

// ---------------- Astro, Gatsby, SolidStart ----------------

function simplePages(input: FileRouteInput, base: string, exts: string[], out: RouteRec[], opts: { endpoints?: boolean; groups?: boolean }): void {
  for (const f of under(input.files, base)) {
    const ext = path.extname(f);
    if (!exts.includes(ext)) continue;
    const segs = f.slice(base.length + 1, -ext.length).split('/');
    if (segs.some((s) => s.startsWith('_'))) continue;
    if (segs[segs.length - 1] === 'index') segs.pop();
    const url = segs.filter((s) => !(opts.groups && /^\(.*\)$/.test(s))).map((s) => bracketSeg(s.replace(/^\{[^}]*?\.?(\w+)\}$/, ':$1')));
    const isEndpoint = opts.endpoints && (ext === '.ts' || ext === '.js') && methodsOf(input, f).length > 0;
    out.push(mk(input, f, toPath(url), isEndpoint ? 'server' : 'page', isEndpoint ? { methods: methodsOf(input, f) } : {}));
  }
}

// ---------------- Qwik City ----------------

function qwik(input: FileRouteInput, out: RouteRec[]): void {
  const base = 'src/routes';
  const drafts: Draft[] = [];
  for (const f of under(input.files, base)) {
    const rel = f.slice(base.length + 1);
    const m = /^(.*?)(?:^|\/)(index|layout)(@\w+)?\.(tsx|jsx|mdx|md|ts)$/.exec(rel);
    if (!m) continue;
    const dir = m[1]!;
    const segs = dir ? dir.split('/') : [];
    const p = toPath(segs.filter((s) => !/^\(.*\)$/.test(s)).map(bracketSeg));
    const kind = m[2] === 'layout' ? 'layout' : m[4] === 'ts' ? 'server' : 'page';
    drafts.push({ rec: mk(input, f, p, kind, kind === 'server' ? { methods: input.exportsOf(f).filter((n) => /^on(Get|Post|Put|Patch|Delete|Request)$/.test(n)) } : {}), dir });
  }
  link(drafts, out);
}

// ---------------- TanStack Router ----------------

function tanstack(input: FileRouteInput, out: RouteRec[]): void {
  const base = ['src/routes', 'app/routes'].find((b) => under(input.files, b).some((f) => /__root\.[jt]sx?$/.test(f)));
  if (!base) return;
  for (const f of under(input.files, base)) {
    const rel = f.slice(base.length + 1);
    if (!/\.[jt]sx?$/.test(rel) || /(^|\/)-/.test(rel) || rel.endsWith('.gen.ts')) continue;
    const noExt = rel.replace(/\.(lazy\.)?[jt]sx?$/, '').replace(/\/route$/, '');
    if (/(^|\/)__root$/.test(noExt)) {
      out.push(mk(input, f, '/', 'layout'));
      continue;
    }
    const segs = noExt.split(/[/.]/);
    const url: string[] = [];
    for (const s of segs) {
      if (s === 'index' || s.startsWith('_') || /^\(.*\)$/.test(s)) continue;
      const clean = s.endsWith('_') ? s.slice(0, -1) : s;
      url.push(clean === '$' ? '*' : clean.startsWith('$') ? ':' + clean.slice(1) : clean);
    }
    out.push(mk(input, f, toPath(url), segs.some((s) => s.startsWith('_') && s.length > 1) && !segs.includes('index') && segs.length === 1 ? 'layout' : 'page'));
  }
}

// ---------------- Expo Router ----------------

function expo(input: FileRouteInput, out: RouteRec[]): void {
  const base = ['app', 'src/app'].find((b) => under(input.files, b).some((f) => /\/_layout\.[jt]sx?$/.test(f)));
  if (!base) return;
  const drafts: Draft[] = [];
  for (const f of under(input.files, base)) {
    const rel = f.slice(base.length + 1);
    const m = /^(?:(.*)\/)?([^/]+?)(\+api)?\.[jt]sx?$/.exec(rel);
    if (!m) continue;
    const dir = m[1] ?? '';
    const name = m[2]!;
    if (name.startsWith('+')) continue;
    const segs = (dir ? dir.split('/') : []).filter((s) => !/^\(.*\)$/.test(s)).map(bracketSeg);
    if (name === '_layout') {
      drafts.push({ rec: mk(input, f, toPath(segs), 'layout'), dir });
      continue;
    }
    if (name !== 'index') segs.push(bracketSeg(name));
    drafts.push({ rec: mk(input, f, toPath(segs), m[3] ? 'server' : 'page', m[3] ? { methods: methodsOf(input, f) } : {}), dir });
  }
  link(drafts, out);
}
