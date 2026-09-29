// Запросы к индексу: текст → ключ → использование → роут → api и обратно.
import type { NavIndex } from './indexer.ts';
import type { ApiCall } from './parse.ts';
import type { RouteRec } from './routes.ts';

const HUB_FANIN = 30;
const UP_LIMIT = 4000;

export interface Endpoint extends ApiCall {
  file: string;
}

export interface UsageHit {
  file: string;
  line: number;
  how: 'key' | 'prefix+key' | 'text';
}

export interface RouteHit {
  route: RouteRec;
  /** Цепочка файлов от места использования до компонента роута. */
  via: string[];
}

export function norm(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
}

export class Nav {
  readonly ix: NavIndex;
  private deps = new Map<string, string[]>();
  private rdeps = new Map<string, string[]>();
  private routeByComp = new Map<string, number[]>();
  private byOwner = new Map<string, Endpoint[]>();
  private epCache = new Map<string, Endpoint[]>();

  constructor(ix: NavIndex) {
    this.ix = ix;
    for (const [rel, e] of Object.entries(ix.files)) {
      const d = new Set(e.deps);
      for (const tag of e.facts?.tags ?? []) {
        const g = ix.globals[tag];
        if (g && g !== rel) d.add(g);
      }
      this.deps.set(rel, [...d]);
      for (const x of d) {
        if (!this.rdeps.has(x)) this.rdeps.set(x, []);
        this.rdeps.get(x)!.push(rel);
      }
      for (const c of e.facts?.apiCalls ?? []) {
        if (!c.owner) continue;
        if (!this.byOwner.has(c.owner)) this.byOwner.set(c.owner, []);
        this.byOwner.get(c.owner)!.push({ ...c, file: rel });
      }
    }
    ix.routes.forEach((r, i) => {
      if (!r.component) return;
      if (!this.routeByComp.has(r.component)) this.routeByComp.set(r.component, []);
      this.routeByComp.get(r.component)!.push(i);
    });
  }

  isHub(rel: string): boolean {
    return (this.rdeps.get(rel)?.length ?? 0) >= HUB_FANIN;
  }

  fanIn(rel: string): number {
    return this.rdeps.get(rel)?.length ?? 0;
  }

  // ---- текст и ключи ----

  keysByText(q: string, limit = 12): { key: string; value: string; file: string; line: number }[] {
    const n = norm(q);
    const hits: { key: string; value: string; file: string; line: number; score: number }[] = [];
    for (const [key, v] of Object.entries(this.ix.keys)) {
      const nv = norm(v.value);
      const pos = nv.indexOf(n);
      if (pos < 0) continue;
      const score = (nv === n ? 0 : 1) + nv.length / 1000 + (pos === 0 ? 0 : 0.5);
      hits.push({ key, value: v.value, file: v.file, line: v.line, score });
    }
    return hits.sort((a, b) => a.score - b.score).slice(0, limit);
  }

  keysByPrefix(prefix: string): string[] {
    return Object.keys(this.ix.keys).filter((k) => k === prefix || k.startsWith(prefix + '.'));
  }

  /**
   * Где используется ключ. Без знания обёрток перевода: ключ целиком в строке,
   * либо в файле есть строки P и L, из которых он складывается (P.L), — так
   * ловятся useGetTranslation(prefix) + t('x'), `${prefix}.x` и суффиксы
   * вариантов (P.L.default).
   */
  usagesOfKey(key: string): UsageHit[] {
    const segs = key.split('.');
    const variants = [key];
    if (segs.length > 2) variants.push(segs.slice(0, -1).join('.'));
    const out: UsageHit[] = [];
    for (const [rel, e] of Object.entries(this.ix.files)) {
      const s = e.facts?.strings;
      if (!s || rel.includes('/locales/') || rel.includes('/locale/')) continue;
      let hit: UsageHit | null = null;
      for (const k of variants) {
        if (k in s) {
          hit = { file: rel, line: s[k]!, how: 'key' };
          break;
        }
        const parts = k.split('.');
        for (let i = 1; i < parts.length && !hit; i++) {
          const p = parts.slice(0, i).join('.');
          const l = parts.slice(i).join('.');
          if (p in s && l in s) hit = { file: rel, line: s[l]!, how: 'prefix+key' };
        }
        if (hit) break;
      }
      if (hit) out.push(hit);
    }
    // Точные совпадения — первыми.
    return out.sort((a, b) => (a.how === b.how ? 0 : a.how === 'key' ? -1 : 1));
  }

  textInCode(q: string, limit = 20): UsageHit[] {
    const n = norm(q);
    const out: UsageHit[] = [];
    for (const [rel, e] of Object.entries(this.ix.files)) {
      for (const t of e.facts?.texts ?? []) {
        if (norm(t.t).includes(n)) {
          out.push({ file: rel, line: t.line, how: 'text' });
          break;
        }
      }
      if (out.length >= limit) break;
    }
    return out;
  }

  // ---- роуты ----

  /** Роут, чья запись в роутере содержит строку line файла file. */
  routeAtLine(file: string, line: number): RouteRec | null {
    let best: RouteRec | null = null;
    for (const r of this.ix.routes) {
      if (r.file === file && r.line <= line && line <= r.endLine) {
        if (!best || r.endLine - r.line < best.endLine - best.line) best = r;
      }
    }
    return best;
  }

  /** Вверх по импортам до компонентов роутов; кратчайший путь к каждому. */
  routesFor(file: string, limit = 6): { hits: RouteHit[]; total: number } {
    const prev = new Map<string, string | null>([[file, null]]);
    const queue = [file];
    const found: RouteHit[] = [];
    const seenRoutes = new Set<number>();
    while (queue.length && prev.size < UP_LIMIT) {
      const cur = queue.shift()!;
      const rs = this.routeByComp.get(cur);
      if (rs) {
        const via: string[] = [];
        for (let x: string | null = cur; x; x = prev.get(x) ?? null) via.unshift(x);
        for (const i of rs) {
          if (seenRoutes.has(i)) continue;
          seenRoutes.add(i);
          found.push({ route: this.ix.routes[i]!, via: [...via] });
        }
      }
      for (const up of this.rdeps.get(cur) ?? []) {
        if (prev.has(up)) continue;
        // Не поднимаемся через роутер и индексы-агрегаторы: там всё со всем.
        if (/(^|\/)router\//.test(up)) continue;
        prev.set(up, cur);
        queue.push(up);
      }
    }
    return { hits: found.slice(0, limit), total: found.length };
  }

  /** Кратчайшая цепочка импортов вверх до файла, который никто не импортирует. */
  pathToTop(file: string): string[] {
    const prev = new Map<string, string | null>([[file, null]]);
    const queue = [file];
    while (queue.length && prev.size < UP_LIMIT) {
      const cur = queue.shift()!;
      const ups = this.rdeps.get(cur) ?? [];
      if (!ups.length && cur !== file) {
        const chain: string[] = [];
        for (let x: string | null = cur; x; x = prev.get(x) ?? null) chain.unshift(x);
        return chain;
      }
      for (const up of ups) {
        if (prev.has(up)) continue;
        prev.set(up, cur);
        queue.push(up);
      }
    }
    return [];
  }

  routeChain(r: RouteRec): RouteRec[] {
    const chain: RouteRec[] = [];
    for (let x: RouteRec | undefined = r; x; x = x.parent === null ? undefined : this.ix.routes[x.parent]) chain.unshift(x);
    return chain;
  }

  findRoutes(q: string): RouteRec[] {
    const n = q.toLowerCase();
    return this.ix.routes.filter(
      (r) => r.path.toLowerCase().includes(n) || (r.name ?? '').toLowerCase().includes(n) || (r.component ?? '').toLowerCase().includes(n),
    );
  }

  // ---- api ----

  /** Эндпоинты, которые вызывает сам файл (напрямую или через api-модуль). */
  endpointsOf(rel: string): Endpoint[] {
    const cached = this.epCache.get(rel);
    if (cached) return cached;
    const res = this.endpointsOfUncached(rel);
    this.epCache.set(rel, res);
    return res;
  }

  private endpointsOfUncached(rel: string): Endpoint[] {
    const e = this.ix.files[rel];
    if (!e?.facts) return [];
    const out: Endpoint[] = e.facts.apiCalls.map((c) => ({ ...c, file: rel }));
    for (const call of e.facts.calls) {
      const last = call.chain[call.chain.length - 1]!.replace(/\(\)$/, '');
      const cands = this.byOwner.get(last);
      if (!cands) continue;
      const segs = call.chain.map((s) => s.replace(/\(\)$/, '').toLowerCase());
      let best: Endpoint[] = [];
      let bestScore = -1;
      for (const c of cands) {
        const fsegs = c.file.toLowerCase().split(/[\\/.\-_]/);
        const score = segs.filter((s) => fsegs.includes(s)).length;
        if (score > bestScore) [best, bestScore] = [[c], score];
        else if (score === bestScore) best.push(c);
      }
      if (best.length <= 3) out.push(...best);
    }
    return dedupeEndpoints(out);
  }

  /** Эндпоинты файла и его импортов до depth, не заходя в хабы. */
  endpointsNear(rel: string, depth = 2): Endpoint[] {
    const seen = new Set([rel]);
    let frontier = [rel];
    const out: Endpoint[] = [...this.endpointsOf(rel)];
    for (let d = 0; d < depth; d++) {
      const next: string[] = [];
      for (const f of frontier) {
        for (const x of this.deps.get(f) ?? []) {
          if (seen.has(x) || this.isHub(x)) continue;
          seen.add(x);
          next.push(x);
          out.push(...this.endpointsOf(x));
        }
      }
      frontier = next;
    }
    return dedupeEndpoints(out);
  }

  /**
   * Файл вызывает что-то, импортированное из target, и сам не часть api-слоя
   * (агрегаторы модулей вида `gradeBook: gradeBookModule(axios)` — не потребители).
   */
  private callsInto(rel: string, target: string): boolean {
    if (/(^|\/)(api|router)\//i.test(rel)) return false;
    const e = this.ix.files[rel];
    if (!e?.facts) return false;
    const locals = new Set(Object.entries(e.bindings).filter(([, f]) => f === target).map(([l]) => l));
    return e.facts.calls.some((c) => locals.has(c.chain[0]!.replace(/\(\)$/, '')));
  }

  /** Эндпоинты по фрагменту URL и файлы, которые их вызывают. */
  apiConsumers(q: string): { ep: Endpoint; consumers: string[] }[] {
    const n = q.toLowerCase();
    const eps: Endpoint[] = [];
    for (const [rel, e] of Object.entries(this.ix.files)) {
      for (const c of e.facts?.apiCalls ?? []) if (c.url.toLowerCase().includes(n)) eps.push({ ...c, file: rel });
    }
    return eps.map((ep) => {
      const consumers: string[] = [];
      const importers = new Set(this.isHub(ep.file) ? [] : (this.rdeps.get(ep.file) ?? []));
      for (const rel of Object.keys(this.ix.files)) {
        if (importers.has(rel) && this.callsInto(rel, ep.file)) {
          consumers.push(rel);
          continue;
        }
        // Сам api-модуль — не потребитель; vuex-экшен с прямым axios — да.
        if (rel === ep.file && /(^|\/)api\//.test(rel)) continue;
        if (this.endpointsOf(rel).some((x) => x.file === ep.file && x.line === ep.line)) consumers.push(rel);
      }
      return { ep, consumers };
    });
  }
}

function dedupeEndpoints(xs: Endpoint[]): Endpoint[] {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = `${x.method} ${x.url}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
