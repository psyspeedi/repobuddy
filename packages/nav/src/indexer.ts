// Индекс проекта с инкрементальным обновлением по mtime/size. Лежит в
// ~/.cache/rb-nav/, чтобы не мусорить в рабочем дереве.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractFacts, type FileFacts } from './parse.ts';
import { configuredLocale, fallbackOrder, loadLocaleFile, localeInfo, pickLang, type LocaleKey } from './locales.ts';
import { projectInfo, Resolver, walk } from './project.ts';
import { RouteExtractor, type RouteRec } from './routes.ts';
import { fileRoutes } from './fileRoutes.ts';

const VERSION = 19;

export interface FileEntry {
  mtime: number;
  size: number;
  facts: FileFacts | null;
  /** Резолвленные локальные зависимости (относительные пути). */
  deps: string[];
  /** Для каждого импорта: local-имя → файл. */
  bindings: Record<string, string>;
  /** Баррель: файл-источник → реэкспортируемые имена ('*' — всё). */
  reexports?: Record<string, string[]>;
  /** Импортированное имя (не local) → файл: что именно файл берёт из барреля. */
  importedNames?: Record<string, string[]>;
}

export interface NavIndex {
  version: number;
  root: string;
  builtAt: string;
  lang: string | null;
  langs: string[];
  stack: string[];
  files: Record<string, FileEntry>;
  keys: Record<string, LocaleKey>;
  routes: RouteRec[];
  /** Имя компонента в шаблоне → файл (глобальная регистрация и автоимпорт). */
  globals: Record<string, string>;
  /** Функции, доступные без импорта (composables/utils Nuxt) → файл. */
  autoImports: Record<string, string>;
}

export interface Config {
  lang?: string;
  aliases?: Record<string, string>;
  /** Каталоги с автоимпортируемыми компонентами (помимо стандартных). */
  componentDirs?: string[];
}

export function loadConfig(root: string): Config {
  const f = path.join(root, '.rbnav.json');
  if (!fs.existsSync(f)) return {};
  return JSON.parse(fs.readFileSync(f, 'utf8')) as Config;
}

export function cachePath(root: string): string {
  const dir = process.env.RB_NAV_CACHE ?? path.join(os.homedir(), '.cache', 'rb-nav');
  const h = crypto.createHash('sha1').update(root).digest('hex').slice(0, 12);
  return path.join(dir, `${path.basename(root)}-${h}.json`);
}

export interface BuildStats {
  total: number;
  parsed: number;
  removed: number;
  failed: string[];
  ms: number;
}

const STACK_MARKERS: [string, string][] = [
  ['next', 'next'], ['nuxt', 'nuxt'], ['@sveltejs/kit', 'sveltekit'], ['svelte', 'svelte'], ['@angular/core', 'angular'],
  ['@remix-run/react', 'remix'], ['@react-router/dev', 'react-router7'], ['react-router', 'react-router'], ['react-router-dom', 'react-router'],
  ['vue-router', 'vue-router'], ['astro', 'astro'], ['gatsby', 'gatsby'], ['@solidjs/start', 'solid-start'], ['@builder.io/qwik-city', 'qwik-city'],
  ['@tanstack/react-router', 'tanstack-router'], ['expo-router', 'expo-router'], ['vue', 'vue'], ['react', 'react'],
  ['vue-i18n', 'vue-i18n'], ['@nuxtjs/i18n', 'nuxt-i18n'], ['i18next', 'i18next'], ['react-i18next', 'react-i18next'], ['next-intl', 'next-intl'],
  ['next-i18next', 'next-i18next'], ['react-intl', 'react-intl'], ['@lingui/core', 'lingui'], ['svelte-i18n', 'svelte-i18n'],
  ['typesafe-i18n', 'typesafe-i18n'], ['@ngx-translate/core', 'ngx-translate'], ['@jsverse/transloco', 'transloco'], ['@ngneat/transloco', 'transloco'],
  ['@angular/localize', 'angular-i18n'], ['@inlang/paraglide-js', 'paraglide'], ['axios', 'axios'], ['@tanstack/vue-query', 'vue-query'],
  ['@tanstack/react-query', 'react-query'], ['@apollo/client', 'apollo'], ['pinia', 'pinia'], ['vuex', 'vuex'],
];

export function buildIndex(rootArg: string, opts: { force?: boolean } = {}): { index: NavIndex; stats: BuildStats } {
  const t0 = Date.now();
  const root = path.resolve(rootArg);
  const cfg = loadConfig(root);
  const cp = cachePath(root);
  let prev: NavIndex | null = null;
  if (!opts.force && fs.existsSync(cp)) {
    try {
      prev = JSON.parse(fs.readFileSync(cp, 'utf8')) as NavIndex;
      if (prev.version !== VERSION) prev = null;
    } catch {
      prev = null;
    }
  }
  const info = projectInfo(root);
  const resolver = new Resolver(root, { ...frameworkAliases(root, info.deps), ...cfg.aliases });
  const abs = walk(root, info);
  const files: Record<string, FileEntry> = {};
  const stats: BuildStats = { total: abs.length, parsed: 0, removed: 0, failed: [], ms: 0 };
  let changed = !prev;

  for (const f of abs) {
    const rel = path.relative(root, f);
    const st = fs.statSync(f);
    const old = prev?.files[rel];
    if (old && old.mtime === st.mtimeMs && old.size === st.size) {
      files[rel] = old;
      continue;
    }
    changed = true;
    stats.parsed++;
    const entry: FileEntry = { mtime: st.mtimeMs, size: st.size, facts: null, deps: [], bindings: {} };
    if (!localeInfo(rel) || /\.(vue|svelte|astro|tsx|jsx)$/.test(rel)) {
      try {
        entry.facts = extractFacts(f);
        const deps = new Set<string>();
        for (const imp of entry.facts.imports) {
          const targets = imp.spec.includes('*') ? globImport(imp.spec, f, abs, resolver) : [resolver.resolve(imp.spec, f)];
          for (const r of targets) {
            if (!r) continue;
            const rr = path.relative(root, r);
            deps.add(rr);
            if (imp.reexport) {
              (entry.reexports ??= {})[rr] = Object.keys(imp.names);
              continue;
            }
            for (const [local, imported] of Object.entries(imp.names)) {
              entry.bindings[local] = rr;
              ((entry.importedNames ??= {})[rr] ??= []).push(imported);
            }
          }
        }
        // Реэкспорт импортированного (export default X после import X) — тоже ребро барреля.
        for (const [exported, local] of Object.entries(entry.facts.localReexports ?? {})) {
          const f2 = entry.bindings[local];
          if (f2) ((entry.reexports ??= {})[f2] ??= []).push(exported);
        }
        entry.deps = [...deps];
      } catch (e) {
        stats.failed.push(`${rel}: ${(e as Error).message.split('\n')[0]}`);
      }
    }
    files[rel] = entry;
  }
  if (prev) {
    for (const rel of Object.keys(prev.files)) if (!(rel in files)) stats.removed++;
    if (stats.removed) changed = true;
  }

  if (!changed && prev) {
    stats.ms = Date.now() - t0;
    return { index: prev, stats };
  }

  // Локали: основной язык даёт файл и строку, остальные — переводы рядом.
  const byLang = new Map<string, number>();
  const localeFiles: { rel: string; lang: string; prefix: string[] }[] = [];
  for (const rel of Object.keys(files)) {
    const li = localeInfo(rel);
    if (!li) continue;
    localeFiles.push({ rel, ...li });
    byLang.set(li.lang, (byLang.get(li.lang) ?? 0) + 1);
  }
  const lang = pickLang(byLang, cfg.lang ?? configuredLocale(root));
  const perLang = new Map<string, Map<string, LocaleKey>>();
  for (const lf of localeFiles) {
    if (!perLang.has(lf.lang)) perLang.set(lf.lang, new Map());
    try {
      loadLocaleFile(path.join(root, lf.rel), lf.rel, perLang.get(lf.lang)!, lf.prefix);
    } catch (e) {
      stats.failed.push(`${lf.rel}: ${(e as Error).message.split('\n')[0]}`);
    }
  }
  const keys = new Map<string, LocaleKey>();
  // Основной язык первым, затем en, затем остальные: ключ без основного перевода
  // получает file:line запасного языка, а не первого по алфавиту.
  for (const l of fallbackOrder([...perLang.keys()], lang)) {
    for (const [k, v] of perLang.get(l)!) {
      const base = keys.get(k);
      if (!base) keys.set(k, { ...v });
      else (base.alts ??= {})[l] = { value: v.value, file: v.file, line: v.line };
    }
  }
  for (const [rel, e] of Object.entries(files)) {
    for (const lk of e.facts?.localKeys ?? []) if (!keys.has(lk.key)) keys.set(lk.key, { value: lk.value, file: rel, line: lk.line });
  }

  const routes = new RouteExtractor(root, resolver).extract(abs);
  const relFiles = Object.keys(files);
  const exportsOf = (rel: string) => files[rel]?.facts?.exportNames ?? [];
  // parent у файловых роутов — индекс в их собственном списке; сдвигаем.
  const base = routes.length;
  const viteConfig = ['vite.config.ts', 'vite.config.js', 'vite.config.mts', 'vite.config.mjs']
    .map((f) => {
      try {
        return fs.readFileSync(path.join(root, f), 'utf8');
      } catch {
        return '';
      }
    })
    .join('\n');
  for (const r of fileRoutes({ root, files: relFiles, deps: info.deps, exportsOf, viteConfig })) {
    if (r.parent !== null) r.parent += base;
    routes.push(r);
  }

  const globals: Record<string, string> = {};
  for (const e of Object.values(files)) {
    for (const g of e.facts?.globals ?? []) {
      const target = e.bindings[g.local];
      if (target) globals[g.name] = target;
    }
  }
  for (const [rel, e] of Object.entries(files)) {
    for (const sel of e.facts?.selectors ?? []) globals[toPascal(sel)] = rel;
  }
  const nuxtLike = info.deps.has('nuxt') || info.deps.has('nuxt3');
  const unplugin = info.deps.has('unplugin-vue-components') || info.deps.has('@nuxt/components');
  if (nuxtLike || unplugin) {
    const dirs = [...(cfg.componentDirs ?? []), 'components', 'app/components', 'src/components'];
    for (const rel of relFiles) {
      if (!/\.(vue|tsx|jsx)$/.test(rel)) continue;
      const dir = dirs.find((d) => rel.startsWith(d + '/'));
      if (!dir) continue;
      const inner = rel.slice(dir.length + 1).replace(/(\.(client|server))?\.(vue|tsx|jsx)$/, '').split('/');
      const name = nuxtLike ? nuxtComponentName(inner) : pascal(inner[inner.length - 1]!);
      if (!globals[name]) globals[name] = rel;
      if (nuxtLike && !globals['Lazy' + name]) globals['Lazy' + name] = rel;
    }
  }
  const autoImports: Record<string, string> = {};
  if (nuxtLike || info.deps.has('unplugin-auto-import')) {
    for (const rel of relFiles) {
      if (!/^(app\/|src\/)?(composables|utils|stores|store)\/[^/]+\.[cm]?[jt]s$/.test(rel)) continue;
      for (const n of files[rel]!.facts?.exportNames ?? []) {
        if (n === 'default') autoImports[camel(path.basename(rel).replace(/\.[cm]?[jt]s$/, ''))] = rel;
        else autoImports[n] = rel;
      }
    }
  }

  const stack = [...new Set(STACK_MARKERS.filter(([dep]) => info.deps.has(dep)).map(([, n]) => n))];
  const index: NavIndex = {
    version: VERSION,
    root,
    builtAt: new Date().toISOString(),
    lang,
    langs: [...byLang.keys()],
    stack,
    files,
    keys: Object.fromEntries(keys),
    routes,
    globals,
    autoImports,
  };
  fs.mkdirSync(path.dirname(cp), { recursive: true });
  fs.writeFileSync(cp, JSON.stringify(index));
  stats.ms = Date.now() - t0;
  return { index, stats };
}

/** import(`./types/${x}/index.vue`) → все файлы, подходящие под шаблон. */
function globImport(spec: string, from: string, all: string[], resolver: Resolver): string[] {
  const star = spec.indexOf('*');
  const dirSpec = spec.slice(0, spec.lastIndexOf('/', star) + 1) || './';
  const base = resolver.resolveDir(dirSpec, from);
  if (!base) return [];
  const rest = spec.slice(dirSpec.length).replace(/[.+?^$()|[\]\\{}]/g, '\\$&').replace(/\*/g, '[^/]+');
  const re = new RegExp('^' + base.replace(/[.+?^$()|[\]\\{}]/g, '\\$&') + '/' + rest + '(\\.(vue|svelte|tsx?|jsx?))?$');
  return all.filter((f) => re.test(f)).slice(0, 200);
}

/** Алиасы, которые фреймворк задаёт в сгенерированном tsconfig (его в репозитории нет). */
function frameworkAliases(root: string, deps: Set<string>): Record<string, string> {
  const a: Record<string, string> = {};
  if (deps.has('@sveltejs/kit')) Object.assign(a, { $lib: 'src/lib', '$lib/*': 'src/lib/*' });
  if (deps.has('nuxt') || deps.has('nuxt3')) {
    const src = fs.existsSync(path.join(root, 'app/pages')) || fs.existsSync(path.join(root, 'app/app.vue')) ? 'app' : '.';
    Object.assign(a, { '~/*': `${src}/*`, '@/*': `${src}/*`, '~~/*': '*', '@@/*': '*', '~': src, '@': src });
  }
  return a;
}

function pascal(s: string): string {
  return s.replace(/[^A-Za-z0-9]+(.)/g, (_, c: string) => c.toUpperCase()).replace(/^./, (c) => c.toUpperCase());
}

function camel(s: string): string {
  const p = pascal(s);
  return p.charAt(0).toLowerCase() + p.slice(1);
}

function toPascal(tag: string): string {
  return tag.split('-').map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join('');
}

/** components/base/foo/Button.vue → BaseFooButton; base/BaseButton.vue → BaseButton; x/index.vue → X. */
export function nuxtComponentName(segs: string[]): string {
  const parts = segs.map(pascal);
  let name = parts.pop()!;
  if (name === 'Index' && parts.length) name = parts.pop()!;
  for (let k = 0; k <= parts.length; k++) {
    const rest = parts.slice(k).join('');
    if (name.startsWith(rest)) return parts.slice(0, k).join('') + name;
  }
  return parts.join('') + name;
}
