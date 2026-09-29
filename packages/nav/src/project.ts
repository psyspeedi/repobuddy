// Обход проекта и резолв импортов: алиасы из tsconfig/jsconfig (с extends),
// расширения и index-файлы — как у webpack/vite по умолчанию.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export const SOURCE_EXT = ['.vue', '.svelte', '.astro', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const RESOLVE_EXT = ['.tsx', '.ts', '.mjs', '.js', '.jsx', '.vue', '.svelte', '.astro', '.json', '.html'];
/** Каталоги, внутри которых лежат словари переводов. */
export const LOCALE_DIRS = ['locales', 'locale', 'i18n', 'lang', 'langs', 'messages', 'translations', 'intl', 'l10n', 'translation'];
export const LOCALE_EXT = ['.json', '.yml', '.yaml', '.po', '.xlf', '.xliff', '.js', '.ts', '.mjs'];
const LOCALE_PATH = new RegExp(`[\\\\/](${LOCALE_DIRS.join('|')})[\\\\/]`);
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.nuxt', '.output', '.next', '.svelte-kit', '.astro', '.angular',
  '.vercel', '.netlify', '.turbo', '.cache', 'out', '.rbnav', '__tests__', '__mocks__', 'e2e', 'cypress', 'testing',
  '.storybook', 'storybook-static', 'vendor', 'tmp',
]);
const SKIP_FILES =
  /\.(spec|test|stories|story|cy|e2e)\.[cm]?[jt]sx?$|^(vite|vitest|webpack|rollup|nuxt|next|svelte|astro|tailwind|postcss|eslint|prettier|jest|playwright|babel|tsup|commitlint|stylelint|uno|windi|quasar|karma|capacitor|lint-staged|remix|react-router|app)\.config\.[cm]?[jt]s$/;
/** app.config.ts — конфиг Angular-приложения (provideRouter), а в Nuxt/Vite это конфиг инструмента. */
const APP_CONFIG = /^app\.config\.[cm]?[jt]s$/;
/** Каталоги со статикой: из них берём только словари переводов (next-i18next). */
const ASSET_DIRS = new Set(['public', 'static', 'assets']);

export interface ProjectInfo {
  deps: Set<string>;
  angular: boolean;
}

export function projectInfo(root: string): ProjectInfo {
  const deps = new Set<string>();
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    for (const k of ['dependencies', 'devDependencies', 'peerDependencies']) for (const d of Object.keys(pkg[k] ?? {})) deps.add(d);
  } catch {
    // без package.json — определяем по файлам
  }
  const angular = deps.has('@angular/core') || fs.existsSync(path.join(root, 'angular.json'));
  return { deps, angular };
}

export function walk(root: string, info: ProjectInfo = projectInfo(root)): string[] {
  const out: string[] = [];
  const stack: { dir: string; assets: boolean }[] = [{ dir: root, assets: false }];
  while (stack.length) {
    const { dir, assets } = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name.startsWith('.') && e.name !== '.') continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) stack.push({ dir: full, assets: assets || ASSET_DIRS.has(e.name) });
      } else if (e.isFile()) {
        const ext = path.extname(e.name);
        const isLocale = LOCALE_EXT.includes(ext) && LOCALE_PATH.test(full.slice(root.length));
        if (assets) {
          if (isLocale && !['.js', '.ts', '.mjs'].includes(ext)) out.push(full);
          continue;
        }
        const skip = SKIP_FILES.test(e.name) && !(info.angular && APP_CONFIG.test(e.name));
        if (SOURCE_EXT.includes(ext) && !e.name.endsWith('.d.ts') && !skip) out.push(full);
        else if (ext === '.html' && info.angular) out.push(full);
        // Markdown-страницы (vite-plugin-pages, Astro, Nuxt Content, Next mdx).
        else if ((ext === '.md' || ext === '.mdx') && !/^readme/i.test(e.name) && /[\\/](pages|routes|app|content)[\\/]/.test(full.slice(root.length))) out.push(full);
        else if (isLocale) out.push(full);
      }
    }
  }
  return out.sort();
}

interface AliasRule {
  pattern: string; // без '*'
  wildcard: boolean;
  targets: string[]; // абсолютные, без '*'
}

export class Resolver {
  readonly root: string;
  private rules: AliasRule[] = [];
  private baseUrl: string | null = null;
  private cache = new Map<string, string | null>();

  constructor(root: string, extraAliases: Record<string, string> = {}) {
    this.root = root;
    this.loadTsconfig();
    for (const [k, v] of Object.entries(extraAliases)) {
      const wildcard = k.endsWith('/*');
      this.rules.push({
        pattern: wildcard ? k.slice(0, -1) : k,
        wildcard,
        targets: [path.resolve(root, wildcard ? v.replace(/\*$/, '') : v)],
      });
    }
    // Конвенция по умолчанию, если tsconfig молчит: '@/' → src/.
    if (!this.rules.some((r) => r.pattern === '@/') && fs.existsSync(path.join(root, 'src'))) {
      this.rules.push({ pattern: '@/', wildcard: true, targets: [path.join(root, 'src') + '/'] });
    }
    // Длинные префиксы проверяются первыми: '@ui/' раньше '@/'.
    this.rules.sort((a, b) => b.pattern.length - a.pattern.length);
  }

  private loadTsconfig(): void {
    for (const name of ['tsconfig.json', 'jsconfig.json']) {
      const file = path.join(this.root, name);
      if (!fs.existsSync(file)) continue;
      const read = ts.readConfigFile(file, ts.sys.readFile);
      if (read.error || !read.config) continue;
      const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, this.root, undefined, file);
      const opts = parsed.options;
      const base = (opts.pathsBasePath as string | undefined) ?? opts.baseUrl ?? this.root;
      if (opts.baseUrl) this.baseUrl = opts.baseUrl;
      for (const [k, vals] of Object.entries(opts.paths ?? {})) {
        const wildcard = k.endsWith('*');
        this.rules.push({
          pattern: wildcard ? k.slice(0, -1) : k,
          wildcard,
          targets: vals.map((v) => path.resolve(base, wildcard ? v.replace(/\*$/, '') : v) + (wildcard && v.endsWith('/*') ? '/' : '')),
        });
      }
      return;
    }
  }

  /** Абсолютный путь к файлу или null для внешних пакетов и нерезолвимого. */
  resolve(spec: string, fromFile: string): string | null {
    const key = spec.startsWith('.') ? path.dirname(fromFile) + '\0' + spec : spec;
    if (this.cache.has(key)) return this.cache.get(key)!;
    const res = this.resolveUncached(spec, fromFile);
    this.cache.set(key, res);
    return res;
  }

  private resolveUncached(spec: string, fromFile: string): string | null {
    const clean = spec.split('?')[0]!;
    if (clean.startsWith('.') || clean.startsWith('/')) {
      return tryFile(path.resolve(path.dirname(fromFile), clean));
    }
    for (const r of this.rules) {
      if (r.wildcard ? clean.startsWith(r.pattern) : clean === r.pattern) {
        const rest = r.wildcard ? clean.slice(r.pattern.length) : '';
        for (const t of r.targets) {
          const hit = tryFile(path.join(t, rest));
          if (hit) return hit;
        }
      }
    }
    if (this.baseUrl) {
      const hit = tryFile(path.join(this.baseUrl, clean));
      if (hit && !hit.includes('node_modules')) return hit;
    }
    return null;
  }
}

function tryFile(base: string): string | null {
  if (isFile(base)) return base;
  for (const ext of RESOLVE_EXT) if (isFile(base + ext)) return base + ext;
  for (const ext of RESOLVE_EXT) {
    const idx = path.join(base, 'index' + ext);
    if (isFile(idx)) return idx;
  }
  return null;
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}
