// Обход проекта и резолв импортов: алиасы из tsconfig/jsconfig (с extends),
// расширения и index-файлы — как у webpack/vite по умолчанию.
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

export const SOURCE_EXT = ['.vue', '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];
const RESOLVE_EXT = ['.tsx', '.ts', '.mjs', '.js', '.jsx', '.vue', '.json'];
const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'coverage', '.nuxt', '.output', '.next', 'public', '.rbnav',
  '__tests__', '__mocks__', 'e2e', 'cypress', 'testing', '.storybook',
]);
const SKIP_FILES = /\.(spec|test|stories|cy)\.[cm]?[jt]sx?$/;

export function walk(root: string): string[] {
  const out: string[] = [];
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop()!;
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
        if (!SKIP_DIRS.has(e.name)) stack.push(full);
      } else if (e.isFile()) {
        if (SOURCE_EXT.includes(path.extname(e.name)) && !e.name.endsWith('.d.ts') && !SKIP_FILES.test(e.name)) out.push(full);
        else if (e.name.endsWith('.json') && /[\\/]locales?[\\/]/.test(full)) out.push(full);
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
