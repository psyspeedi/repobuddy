// Индекс проекта с инкрементальным обновлением по mtime/size. Лежит в
// ~/.cache/rb-nav/, чтобы не мусорить в рабочем дереве.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { extractFacts, type FileFacts } from './parse.ts';
import { loadLocaleFile, localeInfo, pickLang, type LocaleKey } from './locales.ts';
import { Resolver, walk } from './project.ts';
import { RouteExtractor, type RouteRec } from './routes.ts';

const VERSION = 2;

export interface FileEntry {
  mtime: number;
  size: number;
  facts: FileFacts | null;
  /** Резолвленные локальные зависимости (относительные пути). */
  deps: string[];
  /** Для каждого импорта: local-имя → файл (для глобальных компонентов). */
  bindings: Record<string, string>;
}

export interface NavIndex {
  version: number;
  root: string;
  builtAt: string;
  lang: string | null;
  files: Record<string, FileEntry>;
  keys: Record<string, LocaleKey>;
  routes: RouteRec[];
  /** Имя глобально зарегистрированного компонента → файл. */
  globals: Record<string, string>;
}

export interface Config {
  lang?: string;
  aliases?: Record<string, string>;
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
  const resolver = new Resolver(root, cfg.aliases);
  const abs = walk(root);
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
    if (!f.endsWith('.json')) {
      try {
        entry.facts = extractFacts(f);
        const deps = new Set<string>();
        for (const imp of entry.facts.imports) {
          const r = resolver.resolve(imp.spec, f);
          if (!r) continue;
          const rr = path.relative(root, r);
          deps.add(rr);
          for (const local of Object.keys(imp.names)) entry.bindings[local] = rr;
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

  // Локали: собираем по языку.
  const byLang = new Map<string, number>();
  const localeFiles: { rel: string; lang: string; prefix: string[] }[] = [];
  for (const rel of Object.keys(files)) {
    if (rel.includes('node_modules')) continue;
    const info = localeInfo(rel);
    if (!info) continue;
    localeFiles.push({ rel, ...info });
    byLang.set(info.lang, (byLang.get(info.lang) ?? 0) + 1);
  }
  const lang = pickLang(byLang, cfg.lang);
  const keys = new Map<string, LocaleKey>();
  for (const lf of localeFiles) {
    if (lf.lang !== lang) continue;
    try {
      loadLocaleFile(path.join(root, lf.rel), lf.rel, keys, lf.prefix);
    } catch (e) {
      stats.failed.push(`${lf.rel}: ${(e as Error).message.split('\n')[0]}`);
    }
  }

  const routes = new RouteExtractor(root, resolver).extract(abs);

  const globals: Record<string, string> = {};
  for (const e of Object.values(files)) {
    for (const g of e.facts?.globals ?? []) {
      const target = e.bindings[g.local];
      if (target) globals[g.name] = target;
    }
  }

  const index: NavIndex = {
    version: VERSION,
    root,
    builtAt: new Date().toISOString(),
    lang,
    files,
    keys: Object.fromEntries(keys),
    routes,
    globals,
  };
  fs.mkdirSync(path.dirname(cp), { recursive: true });
  fs.writeFileSync(cp, JSON.stringify(index));
  stats.ms = Date.now() - t0;
  return { index, stats };
}
