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
  how: 'key' | 'prefix+key' | 'text' | 'dynamic';
}

export interface RouteHit {
  route: RouteRec;
  /** Роут найден как дочерний: файл виден через родительскую страницу. */
  viaParent?: boolean;
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
      // Автоимпорт Nuxt: useFoo() без import → composables/useFoo.ts.
      for (const c of e.facts?.calls ?? []) {
        if (c.chain.length !== 1) continue;
        const name = c.chain[0]!.replace(/\(\)$/, '');
        const target = ix.autoImports?.[name];
        if (target && target !== rel && !e.bindings[name]) d.add(target);
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
      // +page.ts и т.п.: неявная зависимость страницы от своего загрузчика.
      for (const x of r.extra ?? []) {
        this.deps.get(r.component)?.push(x);
        if (!this.rdeps.has(x)) this.rdeps.set(x, []);
        this.rdeps.get(x)!.push(r.component);
      }
    });
  }

  /** Серверные ручки, чей путь совпадает с URL клиента (параметры — как *). */
  handlersFor(url: string): RouteRec[] {
    const u = normUrl(url);
    return this.ix.routes.filter((r) => r.kind === 'server' && urlMatches(u, normUrl(r.path)));
  }

  serverRoutes(q: string): RouteRec[] {
    const n = q.toLowerCase();
    return this.ix.routes.filter((r) => r.kind === 'server' && (r.path.toLowerCase().includes(n) || r.file.toLowerCase().includes(n)));
  }

  /** a реэкспортирует b (index.ts модулей). */
  private reexports(a: string, b: string): boolean {
    const e = this.ix.files[a];
    return !!e && e.deps.includes(b) && /(^|\/)index\.[cm]?[jt]s$/.test(a);
  }

  isUiFile(rel: string): boolean {
    return /\.(vue|svelte|astro|tsx|jsx|html)$/.test(rel) || this.routeByComp.has(rel) || /\.component\.[jt]s$/.test(rel);
  }

  isHub(rel: string): boolean {
    return (this.rdeps.get(rel)?.length ?? 0) >= HUB_FANIN;
  }

  fanIn(rel: string): number {
    return this.rdeps.get(rel)?.length ?? 0;
  }

  // ---- текст и ключи ----

  keysByText(q: string, limit = 12): { key: string; value: string; file: string; line: number; lang: string | null }[] {
    const n = norm(q);
    const hits: { key: string; value: string; file: string; line: number; lang: string | null; score: number }[] = [];
    for (const [key, v] of Object.entries(this.ix.keys)) {
      // Основной язык, затем переводы: показываем file:line того, где совпало.
      const variants: { value: string; file: string; line: number; lang: string | null }[] = [
        { value: v.value, file: v.file, line: v.line, lang: null },
        ...Object.entries(v.alts ?? {}).map(([lang, a]) => ({ ...a, lang })),
      ];
      let best: (typeof hits)[number] | null = null;
      for (const x of variants) {
        const nv = norm(x.value);
        const pos = nv.indexOf(n);
        if (pos < 0) continue;
        const wordStart = pos === 0 || /[\s\p{P}]/u.test(nv[pos - 1]!);
        // В чужих языках подстрока внутри слова — шум («Bio» в «Ulubione»).
        if (x.lang && !wordStart) continue;
        const score = (nv === n ? 0 : 1) + (wordStart ? 0 : 0.8) + nv.length / 1000 + (pos === 0 ? 0 : 0.3) + (x.lang ? 0.5 : 0);
        if (!best || score < best.score) best = { key, value: x.value, file: x.file, line: x.line, lang: x.lang, score };
      }
      if (!best && norm(key) === n) best = { key, value: v.value, file: v.file, line: v.line, lang: null, score: 0.1 };
      if (best) hits.push(best);
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
    // P.L.default / P.L.ano_student: сокращаем, только если у родителя есть вариант default.
    const parent = segs.slice(0, -1).join('.');
    if (segs.length > 2 && (this.ix.keys[parent + '.default'] || segs[segs.length - 1] === 'default')) variants.push(parent);
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
        // Хвост должен быть аргументом вызова t('x'): иначе это класс, поле объекта или имя в словаре.
        const args = new Set(e.facts?.argStrings ?? []);
        for (let i = 1; i < parts.length && !hit; i++) {
          const p = parts.slice(0, i).join('.');
          const l = parts.slice(i).join('.');
          if (p in s && l in s && args.has(l)) hit = { file: rel, line: s[l]!, how: 'prefix+key' };
        }
        if (hit) break;
      }
      // Ключ-фраза (gettext, Lingui): <Trans>Save changes</Trans> — видимый текст.
      if (!hit && /\s/.test(key) && e.facts) {
        const nk = norm(key);
        const t = e.facts.texts.find((x) => norm(x.t) === nk);
        if (t) hit = { file: rel, line: t.line, how: 'key' };
      }
      if (!hit && e.facts?.dynPrefixes) {
        for (const [pre, line] of Object.entries(e.facts.dynPrefixes)) {
          if (key.startsWith(pre + '.')) {
            hit = { file: rel, line, how: 'dynamic' };
            break;
          }
        }
      }
      if (hit) out.push(hit);
    }
    // Точные совпадения — первыми, динамические — последними.
    const rank = { key: 0, 'prefix+key': 1, text: 2, dynamic: 3 } as const;
    return out.sort((a, b) => rank[a.how] - rank[b.how]);
  }

  /** Вшитый текст: видимый текст шаблонов/JSX, затем любые строковые литералы. */
  textInCode(q: string, limit = 20): UsageHit[] {
    const n = norm(q);
    const out: UsageHit[] = [];
    const seen = new Set<string>();
    for (const [rel, e] of Object.entries(this.ix.files)) {
      let inFile = 0;
      for (const t of e.facts?.texts ?? []) {
        if (norm(t.t).includes(n)) {
          out.push({ file: rel, line: t.line, how: 'text' });
          seen.add(rel);
          if (++inFile >= 3) break;
        }
      }
      if (out.length >= limit) return out;
    }
    // toast('Saved'), t('Save changes') в gettext-стиле — строки, а не текст шаблона.
    if (n.length >= 4) {
      for (const [rel, e] of Object.entries(this.ix.files)) {
        if (seen.has(rel) || !e.facts) continue;
        for (const [str, line] of Object.entries(e.facts.strings)) {
          if (str.includes(' ') && norm(str).includes(n)) {
            out.push({ file: rel, line, how: 'text' });
            break;
          }
        }
        if (out.length >= limit) break;
      }
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
    // Через баррель (index.ts с реэкспортами) идём только к тем, кто берёт из него нужный символ.
    const via = new Map<string, Set<string> | null>();
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
          // Родитель рендерит детей через <router-view>/<NuxtPage>/<Outlet> — виден и на их URL.
          for (const c of this.descendants(i)) {
            if (seenRoutes.has(c)) continue;
            seenRoutes.add(c);
            found.push({ route: this.ix.routes[c]!, via: [...via], viaParent: true });
          }
        }
      }
      const curE = this.ix.files[cur];
      const filter = via.get(cur) ?? null;
      for (const up of this.rdeps.get(cur) ?? []) {
        if (prev.has(up)) continue;
        // Не поднимаемся через роутер: там всё со всем.
        if (/(^|\/)router\//.test(up)) continue;
        // Хаб (стор, i18n, плагин — его импортирует почти всё): роуты за ним случайны.
        if (up !== file && this.isHub(up) && !this.ix.files[up]?.reexports) continue;
        // Из барреля — только к импортёрам нужных символов.
        if (filter && !(this.ix.files[up]?.importedNames?.[cur] ?? []).some((n) => filter.has(n) || n === '*')) continue;
        const upE = this.ix.files[up];
        const re = upE?.reexports?.[cur];
        if (re) {
          const names = re.includes('*') ? (curE?.facts?.exportNames ?? []) : re;
          via.set(up, new Set(names));
        }
        prev.set(up, cur);
        queue.push(up);
      }
    }
    return { hits: found.slice(0, limit), total: found.length };
  }

  private childrenCache: Map<number, number[]> | null = null;

  descendants(i: number): number[] {
    if (!this.childrenCache) {
      this.childrenCache = new Map();
      this.ix.routes.forEach((r, j) => {
        if (r.parent === null || r.kind === 'server') return;
        if (!this.childrenCache!.has(r.parent)) this.childrenCache!.set(r.parent, []);
        this.childrenCache!.get(r.parent)!.push(j);
      });
    }
    const out: number[] = [];
    const stack = [...(this.childrenCache.get(i) ?? [])];
    while (stack.length && out.length < 200) {
      const j = stack.pop()!;
      out.push(j);
      stack.push(...(this.childrenCache.get(j) ?? []));
    }
    return out;
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
      const head = call.chain[0]!.replace(/\(.*\)$/, '');
      // Голова цепочки — импортированный символ (сервис из DI, модуль, composable):
      // тогда файл известен точно, и угадывать по словам не нужно.
      const bound = e.bindings[head];
      if (bound && call.chain.length >= 2) {
        const exact = cands.filter((c) => c.file === bound || this.reexports(bound, c.file));
        if (exact.length) {
          out.push(...exact);
          continue;
        }
      }
      // this.x.method() без связи с сервисом (signal, локальный объект) — не потребитель.
      if (head === 'this') continue;
      // Слова цепочки без самого метода: api.modules.v3.student.gradeBook.getX → student, grade, book.
      const words = new Set(call.chain.slice(0, -1).flatMap((s) => wordsOf(s)));
      let best: Endpoint[] = [];
      let bestScore = -1;
      for (const c of cands) {
        const fw = new Set(wordsOf(c.file));
        let score = [...words].filter((w) => fw.has(w)).length;
        // useSignIn().oauth — функция-владелец объявлена в файле эндпоинта.
        if (this.ix.files[c.file]?.facts?.exportNames.includes(head)) score += 2;
        if (score > bestScore) [best, bestScore] = [[c], score];
        else if (score === bestScore) best.push(c);
      }
      // Есть получатель, но ни одного совпадения по словам — не угадываем.
      if (bestScore === 0 && (cands.length > 1 || call.chain.length >= 2)) continue;
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
  private callsInto(rel: string, target: string, owner: string | null): boolean {
    if (/(^|\/)(api|router)\//i.test(rel)) return false;
    const e = this.ix.files[rel];
    if (!e?.facts) return false;
    const locals = new Set(Object.entries(e.bindings).filter(([, f]) => f === target).map(([l]) => l));
    return e.facts.calls.some((c) => {
      if (!locals.has(c.chain[0]!.replace(/\(.*\)$/, ''))) return false;
      // useComments() — импортированная функция-обёртка: файл целиком потребитель.
      if (c.chain.length === 1) return true;
      // userService.login() — через объект сервиса: нужен именно метод-владелец эндпоинта.
      return !owner || c.chain[c.chain.length - 1]!.replace(/\(\)$/, '') === owner;
    });
  }

  /** GraphQL: операцию не вызывают, а передают в useQuery — достаточно импорта. */
  private importsName(rel: string, target: string): boolean {
    if (/(^|\/)(api|router)\//i.test(rel)) return false;
    const e = this.ix.files[rel];
    return !!e && Object.values(e.bindings).includes(target);
  }

  /** Эндпоинты по фрагменту URL и файлы, которые их вызывают. */
  apiConsumers(q: string): { ep: Endpoint; consumers: string[] }[] {
    const n = q.toLowerCase();
    const eps: Endpoint[] = [];
    // Исходящие вызовы из серверных ручек — не клиентский api.
    const serverFiles = new Set(this.ix.routes.filter((r) => r.kind === 'server').map((r) => r.file));
    for (const [rel, e] of Object.entries(this.ix.files)) {
      if (serverFiles.has(rel) || /(^|\/)server\//.test(rel)) continue;
      for (const c of e.facts?.apiCalls ?? []) if (c.url.toLowerCase().includes(n)) eps.push({ ...c, file: rel });
    }
    return eps.map((ep) => {
      const consumers: string[] = [];
      const importers = new Set(this.isHub(ep.file) ? [] : (this.rdeps.get(ep.file) ?? []));
      const gql = /^(QUERY|MUTATION|SUBSCRIPTION)$/.test(ep.method);
      let selfFallback = false;
      for (const rel of Object.keys(this.ix.files)) {
        if (importers.has(rel) && (gql ? this.importsName(rel, ep.file) : this.callsInto(rel, ep.file, ep.owner))) {
          consumers.push(rel);
          continue;
        }
        // Файл-источник — потребитель, только если это экран или компонент (fetch прямо в
        // странице); api-модуль, сервис или стор с методом-обёрткой — нет.
        if (rel === ep.file && (gql || !this.isUiFile(rel))) {
          selfFallback = !gql && !/(^|\/)api\//.test(rel);
          continue;
        }
        if (this.endpointsOf(rel).some((x) => x.file === ep.file && x.line === ep.line)) consumers.push(rel);
      }
      // Никто не найден (vuex-экшен, dispatch по строке) — показываем хотя бы, где живёт вызов.
      if (!consumers.length && selfFallback) consumers.push(ep.file);
      return { ep, consumers };
    });
  }
}

const GENERIC_WORDS = new Set(['this', 'api', 'apis', 'module', 'modules', 'service', 'services', 'index', 'ts', 'js', 'tsx', 'jsx', 'vue', 'src', 'app', 'use', 'store', 'stores', 'query', 'queries', 'lib', 'core', 'http', 'client', 'shared', 'common', 'features', 'feature']);

/** articleService → [article]; features/articles/articles.service.ts → [article]. */
function wordsOf(s: string): string[] {
  return s
    .replace(/\(\)/g, '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 1 && !GENERIC_WORDS.has(w))
    .map((w) => (w.length > 3 && w.endsWith('s') ? w.slice(0, -1) : w));
}

function normUrl(u: string): string {
  return (
    u
      .replace(/^https?:\/\/[^/]+/, '')
      .split('?')[0]!
      .replace(/\{[^}]*\}|:\w+\*?\??|\[[^\]]+\]|\$\{[^}]*\}/g, '*')
      .replace(/\/+$/, '') || '/'
  );
}

/** Клиентский URL может быть без /api-префикса baseURL и с плейсхолдерами. */
function urlMatches(client: string, server: string): boolean {
  const re = new RegExp('(^|/)' + server.replace(/[.+?^$()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]+') + '$');
  const c = client.replace(/\*/g, 'x');
  return re.test(c) || re.test('/api' + c);
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
