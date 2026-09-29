// Структурированные ответы навигатора — общие для CLI и MCP. Пустой результат
// никогда не бывает просто пустым: статус, что проверено, ближайшие совпадения,
// динамические кандидаты и что делать дальше. Агент не должен читать «0» как
// «этого в коде нет».
import path from 'node:path';
import { norm, underDynPrefix, type Endpoint, type Nav, type RouteHit, type UsageHit } from './query.ts';
import type { RouteRec } from './routes.ts';

export type Status = 'found' | 'dynamic_candidates' | 'key_unused' | 'fuzzy_only' | 'not_found' | 'unsupported';

export interface RouteRef {
  path: string;
  name: string | null;
  kind: string;
  at: string;
  via: string[];
  viaParent?: boolean;
  meta?: string | null;
}

export interface Place {
  at: string;
  how?: UsageHit['how'];
  routes: RouteRef[];
  routesTotal: number;
  /** Нет роута: цепочка импортов до верхнего уровня (layout, App). */
  global?: string[];
  api: string[];
  /** Для вшитого текста в роутере: чья это запись (meta.title). */
  routeRecord?: RouteRef;
}

export interface KeyHit {
  key: string;
  value: string;
  lang: string | null;
  at: string;
  usages: Place[];
  usagesTotal: number;
}

export interface Near {
  what: string;
  value: string;
  at: string;
  score: number;
}

export interface TextAnswer {
  tool: 'text';
  query: string;
  status: Status;
  keys: KeyHit[];
  hardcoded: Place[];
  near: Near[];
  dynamic: { prefix: string; at: string; keys: string[] }[];
  searched: string;
  hint: string;
}

// ---------------- нечёткое сравнение ----------------

const RU_END = /(иями|ями|ами|иях|ях|ах|ого|его|ому|ему|ыми|ими|ской|ский|ская|ское|ские|ость|ости|ый|ий|ой|ая|яя|ое|ее|ые|ие|ую|юю|ов|ев|ей|ам|ям|ом|ем|а|я|о|е|ы|и|у|ю|ь)$/;
const EN_END = /(ings|ing|ed|es|s)$/;

const STOP = new Set([
  'за', 'из', 'на', 'по', 'от', 'до', 'во', 'со', 'не', 'ни', 'но', 'же', 'ли', 'бы', 'как', 'что', 'это', 'для', 'при', 'или',
  'the', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are', 'be', 'at', 'by', 'an', 'as', 'it', 'you', 'your',
]);

/** Слова без окончаний и служебных слов: «Оценки за урок» ≈ «Оценок за уроки». */
export function stems(s: string): string[] {
  return norm(s)
    .replace(/\{[^}]*\}|\d+/g, ' ')
    .split(/[^\p{L}]+/u)
    .filter((w) => w.length >= 2 && !STOP.has(w))
    .map((w) => {
      const base = /[а-я]/.test(w) ? w.replace(RU_END, '') : w.replace(EN_END, '');
      return (base.length >= 3 ? base : w).slice(0, 6);
    });
}

/** Редкость основы по словарю проекта: «оценк» весит больше частого «урок». */
const idfCache = new WeakMap<object, Map<string, number>>();
function idfOf(nav: Nav): (w: string) => number {
  let m = idfCache.get(nav.ix);
  if (!m) {
    const df = new Map<string, number>();
    const vals = Object.values(nav.ix.keys);
    for (const v of vals) for (const w of new Set(stems(v.value))) df.set(w, (df.get(w) ?? 0) + 1);
    m = new Map([...df].map(([w, n]) => [w, Math.log(1 + vals.length / n)]));
    idfCache.set(nav.ix, m);
  }
  const max = Math.log(1 + Math.max(1, Object.keys(nav.ix.keys).length));
  return (w) => m!.get(w) ?? max;
}

/** Взвешенный по редкости коэффициент Дайса; вхождение запроса — только для строк сопоставимой длины. */
export function similarity(q: string[], v: string[], idf: (w: string) => number = () => 1): number {
  if (!q.length || !v.length) return 0;
  const vs = new Set(v);
  const sum = (xs: string[]) => xs.reduce((n, w) => n + idf(w), 0);
  const inter = q.filter((w) => vs.has(w));
  const dice = (2 * sum(inter)) / (sum(q) + sum(v));
  const contained = q.length >= 2 && v.length <= q.length * 3 ? sum(inter) / sum(q) : 0;
  return Math.max(dice, contained * 0.85);
}

/** «Выполнено 5 из 10» содержит шаблон «{some} из {total}». */
function templateInside(value: string, q: string): boolean {
  if (!/\{[^}]+\}/.test(value)) return false;
  const lit = norm(value).replace(/\{[^}]*\}/g, '').replace(/[^\p{L}]+/gu, '');
  if (lit.length < 2) return false;
  const re = new RegExp(norm(value).replace(/[.+?^$()|[\]\\*]/g, '\\$&').replace(/\\?\{[^}]*\\?\}/g, '.+?'));
  return re.test(norm(q));
}

// ---------------- сборка ответов ----------------

function routeRef(nav: Nav, r: RouteRec, h?: RouteHit): RouteRef {
  return {
    path: r.path,
    name: r.name,
    kind: r.kind ?? 'page',
    at: r.kind && r.line === 1 ? r.file : `${r.file}:${r.line}`,
    via: h ? h.via.map((f) => path.basename(f)) : [],
    viaParent: h?.viaParent,
    meta: r.meta,
  };
}

function place(nav: Nav, file: string, line: number, how?: UsageHit['how']): Place {
  const rr = nav.routeAtLine(file, line);
  if (rr) return { at: `${file}:${line}`, how, routes: [], routesTotal: 0, api: [], routeRecord: routeRef(nav, rr) };
  const { hits, total } = nav.routesFor(file, 4);
  const p: Place = {
    at: `${file}:${line}`,
    how,
    routes: hits.map((h) => routeRef(nav, h.route, h)),
    routesTotal: total,
    api: nav.endpointsNear(file, 2).slice(0, 5).map(epLabel),
  };
  if (!hits.length) {
    const top = nav.pathToTop(file);
    if (top.length > 1) p.global = top;
  }
  return p;
}

export function epLabel(e: Endpoint): string {
  return `${e.method} ${e.url}${e.owner ? ` ${e.owner}()` : ''} — ${e.file}:${e.line}`;
}

function searchedLine(nav: Nav): string {
  const files = Object.keys(nav.ix.files).length;
  const keys = Object.keys(nav.ix.keys).length;
  const langs = nav.ix.langs.length ? nav.ix.langs.slice(0, 6).join(', ') + (nav.ix.langs.length > 6 ? '…' : '') : 'нет словарей';
  return `${keys} ключей (${langs}) и видимый текст ${files} файлов; стек: ${nav.ix.stack.join(', ') || 'не определён'}`;
}

function unsupported(nav: Nav): boolean {
  return nav.ix.routes.length === 0 && Object.keys(nav.ix.keys).length === 0 && Object.keys(nav.ix.files).length < 5;
}

export function textAnswer(nav: Nav, q: string): TextAnswer {
  const a: TextAnswer = { tool: 'text', query: q, status: 'not_found', keys: [], hardcoded: [], near: [], dynamic: [], searched: searchedLine(nav), hint: '' };
  if (unsupported(nav)) {
    a.status = 'unsupported';
    a.hint = 'Навигатор не распознал проект (нет роутов, словарей и исходников). Проверь корень репозитория (параметр repo) или ищи grep.';
    return a;
  }
  const n = norm(q);
  // Строка экрана длиннее значения («… промежутка (3)», соседний текст) — значение целиком внутри.
  const inside = Object.entries(nav.ix.keys)
    .filter(([, v]) => {
      const nv = norm(v.value);
      return nv.length >= 6 && nv.length >= n.length * 0.6 && nv.length < n.length && n.includes(nv);
    })
    .map(([key, v]) => ({ key, value: v.value, file: v.file, line: v.line, lang: null as string | null }));
  const exactKeys = [...nav.keysByText(q, 12), ...inside].filter((k) => {
    if (inside.includes(k as (typeof inside)[number])) return true;
    // Точное совпадение с учётом плейсхолдеров ({n} ↔ любое значение) или вхождение.
    const nv = norm(k.value);
    if (nv.includes(n)) return true;
    const re = new RegExp('^' + nv.replace(/[.+?^$()|[\]\\*]/g, '\\$&').replace(/\\\{[^}]*\\\}|\{[^}]*\}/g, '.+') + '$');
    return re.test(n);
  });
  for (const k of exactKeys.slice(0, 6)) {
    const us = nav.usagesOfKey(k.key);
    a.keys.push({
      key: k.key,
      value: k.value,
      lang: k.lang,
      at: `${k.file}:${k.line}`,
      usages: us.slice(0, 4).map((u) => place(nav, u.file, u.line, u.how)),
      usagesTotal: us.length,
    });
  }
  for (const h of nav.textInCode(q, 12).slice(0, 6)) a.hardcoded.push(place(nav, h.file, h.line));

  const realUse = a.keys.some((k) => k.usages.some((u) => u.how !== 'dynamic'));
  const dynUse = a.keys.some((k) => k.usages.some((u) => u.how === 'dynamic'));
  if (realUse || a.hardcoded.length) a.status = 'found';
  else if (dynUse) a.status = 'dynamic_candidates';
  else if (a.keys.length) a.status = 'key_unused';

  if (a.status !== 'found') {
    // Ближайшие совпадения: словари (все языки) и видимый текст.
    const qs = stems(q);
    const idf = idfOf(nav);
    // В запросе были числа или служебные слова, а осталось одно слово — совпадение по нему слабое.
    const words = norm(q).split(/[^\p{L}\d]+/u).filter(Boolean).length;
    const cap = qs.length === 1 && words > 1 ? 0.8 : 1;
    const score = (val: string) => (templateInside(val, q) ? 0.95 : Math.min(cap, similarity(qs, stems(val), idf)));
    const near: Near[] = [];
    for (const [key, v] of Object.entries(nav.ix.keys)) {
      for (const [val, at] of [[v.value, `${v.file}:${v.line}`], ...Object.values(v.alts ?? {}).map((x) => [x.value, `${x.file}:${x.line}`])] as [string, string][]) {
        const s = score(val);
        if (s >= 0.5) near.push({ what: `ключ ${key}`, value: val, at, score: s });
      }
    }
    for (const [rel, e] of Object.entries(nav.ix.files)) {
      for (const t of e.facts?.texts ?? []) {
        const s = score(t.t);
        if (s >= 0.5) near.push({ what: 'текст', value: t.t, at: `${rel}:${t.line}`, score: s });
      }
    }
    // Одинаковое значение под разными ключами — одна строка: в пятёрку попадают разные варианты.
    const byValue = new Map<string, Near & { more: number }>();
    for (const x of near.sort((p, q2) => q2.score - p.score)) {
      const k = norm(x.value);
      const had = byValue.get(k);
      if (had) had.more++;
      else byValue.set(k, { ...x, more: 0 });
    }
    const exactSet = new Set(a.keys.map((k) => k.key));
    a.near = [...byValue.values()].filter((x) => !exactSet.has(x.what.slice(5).split(' ')[0]!)).slice(0, 7).map((x) => (x.more ? { ...x, what: `${x.what} (+${x.more} с тем же текстом)` } : x));
    // Динамические ключи: префикс, под которым лежат ключи, похожие на запрос.
    // Динамику выводим только из точных ключей и очень близких: иначе случайное «Урок» даст ложный след.
    const nearKeys = a.near.filter((x) => x.what.startsWith('ключ ') && x.score >= 0.85).map((x) => x.what.slice(5).split(' ')[0]!);
    const cand = [...a.keys.map((k) => k.key), ...nearKeys];
    const dyn = new Map<string, { prefix: string; at: string; keys: Set<string> }>();
    for (const [rel, e] of Object.entries(nav.ix.files)) {
      for (const [pre, line] of Object.entries(e.facts?.dynPrefixes ?? {})) {
        for (const k of cand) {
          if (!underDynPrefix(k, pre, e.facts?.argStrings)) continue;
          const id = `${pre}\0${rel}`;
          const d = dyn.get(id) ?? { prefix: pre, at: `${rel}:${line}`, keys: new Set<string>() };
          d.keys.add(k);
          dyn.set(id, d);
        }
      }
    }
    a.dynamic = [...dyn.values()].slice(0, 5).map((d) => ({ prefix: d.prefix, at: d.at, keys: [...d.keys] }));
    if (a.status === 'not_found' && a.dynamic.length) a.status = 'dynamic_candidates';
    if (a.status === 'not_found' && a.near.length) a.status = 'fuzzy_only';
  }

  a.hint = {
    found: '',
    dynamic_candidates: 'Ключ собирается динамически (префикс + переменная). Открой указанные места: значение переменной определяет ключ.',
    key_unused: 'Ключ есть в словаре, но ни одного использования не найдено: либо мёртвый, либо собирается целиком из данных (t(item.label)) — ищи grep по последнему сегменту ключа.',
    fuzzy_only: 'Точного совпадения нет. Ниже — ближайшие по словам: вероятно, текст на экране отформатирован иначе (падеж, пунктуация, подстановка чисел).',
    not_found: 'Не найдено ни в словарях, ни в видимом тексте кода. Скорее всего это данные с сервера (имя, название, дата): открой nav_route для экрана и смотри его api. Если уверен, что текст статичный, — grep: возможно, шаблон на препроцессоре (pug) или файл вне индекса.',
    unsupported: a.hint,
  }[a.status];
  return a;
}

export interface RouteAnswer {
  tool: 'route';
  query: string;
  status: Status;
  routes: (RouteRef & { component: string | null; parents: string[]; children: string[]; api: string[]; redirect: string | null })[];
  near: string[];
  hint: string;
}

export function routeAnswer(nav: Nav, q: string): RouteAnswer {
  const rs = nav.findRoutes(q);
  const a: RouteAnswer = { tool: 'route', query: q, status: rs.length ? 'found' : 'not_found', routes: [], near: [], hint: '' };
  for (const r of rs.slice(0, 8)) {
    const kids = nav.ix.routes.filter((x) => x.parent !== null && nav.ix.routes[x.parent] === r);
    a.routes.push({
      ...routeRef(nav, r),
      component: r.component,
      redirect: r.redirect,
      parents: nav.routeChain(r).slice(0, -1).map((x) => x.path),
      children: kids.map((k) => k.path),
      api: r.component ? nav.endpointsNear(r.component, 3).slice(0, 10).map(epLabel) : [],
    });
  }
  if (!rs.length) {
    if (unsupported(nav) || !nav.ix.routes.length) {
      a.status = nav.ix.routes.length ? 'not_found' : 'unsupported';
      a.hint = 'Роутов в проекте не найдено: роутер может собираться в рантайме (import.meta.glob, addRoute) или стек не поддержан. Ищи конфиг роутера grep по «routes».';
      return a;
    }
    const qs = q.toLowerCase().split(/[^a-z0-9а-я]+/).filter(Boolean);
    a.near = nav.ix.routes
      .map((r) => ({ r, s: qs.filter((w) => r.path.toLowerCase().includes(w) || (r.name ?? '').toLowerCase().includes(w)).length }))
      .filter((x) => x.s > 0)
      .sort((x, y) => y.s - x.s)
      .slice(0, 8)
      .map((x) => `${x.r.path}${x.r.name ? ` (${x.r.name})` : ''}`);
    a.status = a.near.length ? 'fuzzy_only' : 'not_found';
    a.hint = a.near.length ? 'Точного роута нет, похожие ниже.' : `Роута нет среди ${nav.ix.routes.length}. Ищи по имени компонента экрана (nav_file) или по тексту (nav_text).`;
  }
  return a;
}

export interface FileAnswer {
  tool: 'file';
  query: string;
  status: Status;
  file: string | null;
  candidates: string[];
  fanIn: number;
  place: Place | null;
  hint: string;
}

export function fileAnswer(nav: Nav, root: string, q: string): FileAnswer {
  const a: FileAnswer = { tool: 'file', query: q, status: 'not_found', file: null, candidates: [], fanIn: 0, place: null, hint: '' };
  const rel0 = path.isAbsolute(q) ? path.relative(root, q) : q;
  let rel = nav.ix.files[rel0] ? rel0 : null;
  if (!rel) {
    const cand = Object.keys(nav.ix.files).filter((f) => f.endsWith(rel0) || f.includes(rel0));
    if (cand.length === 1) rel = cand[0]!;
    else a.candidates = cand.slice(0, 15);
  }
  if (!rel) {
    a.status = a.candidates.length ? 'fuzzy_only' : 'not_found';
    a.hint = a.candidates.length
      ? 'Неоднозначно — уточни путь.'
      : 'Файла нет в индексе: он исключён (тесты, моки, scripts/, конфиги инструментов, каталоги рядом с src/) или расширение не поддержано.';
    return a;
  }
  a.status = 'found';
  a.file = rel;
  a.fanIn = nav.fanIn(rel);
  a.place = place(nav, rel, 1);
  if (!a.place.routes.length) {
    a.hint = a.place.global ? 'Роута нет: файл подключён глобально (layout/App/плагин) — виден на всех экранах, где есть этот layout.' : 'Роута нет и файл никто не импортирует: мёртвый код или подключается динамически по строке.';
  }
  return a;
}

export interface ApiAnswer {
  tool: 'api';
  query: string;
  status: Status;
  client: { endpoint: string; handlers: string[]; consumers: { file: string; routes: RouteRef[]; routesTotal: number }[] }[];
  server: RouteRef[];
  near: string[];
  hint: string;
}

export function apiAnswer(nav: Nav, q: string): ApiAnswer {
  const res = nav.apiConsumers(q);
  const server = nav.serverRoutes(q);
  const a: ApiAnswer = { tool: 'api', query: q, status: res.length || server.length ? 'found' : 'not_found', client: [], server: server.slice(0, 8).map((r) => routeRef(nav, r)), near: [], hint: '' };
  for (const { ep, consumers } of res.slice(0, 8)) {
    a.client.push({
      endpoint: epLabel(ep),
      handlers: nav.handlersFor(ep.url).slice(0, 2).map((h) => h.file),
      consumers: consumers.slice(0, 5).map((c) => {
        const { hits, total } = nav.routesFor(c, 3);
        return { file: c, routes: hits.map((h) => routeRef(nav, h.route, h)), routesTotal: total };
      }),
    });
  }
  if (a.status === 'not_found') {
    // attendance-list → attendance, list: слова URL, окончание множественного числа не мешает.
    const qs = q.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length >= 3).map((w) => w.replace(/s$/, ''));
    const all = nav.apiConsumers('');
    a.near = all
      .map(({ ep }) => ({ ep, s: qs.filter((w) => ep.url.toLowerCase().includes(w) || (ep.owner ?? '').toLowerCase().includes(w)).length }))
      .filter((x) => x.s > 0)
      .sort((x, y) => y.s - x.s)
      .slice(0, 8)
      .map((x) => epLabel(x.ep));
    a.status = a.near.length ? 'fuzzy_only' : 'not_found';
    a.hint = a.near.length
      ? 'Точного совпадения нет, похожие ниже. URL в коде бывает без baseURL (/api, /api/v1) или собирается из частей.'
      : `Среди ${all.length} клиентских вызовов такого нет. Возможно, URL целиком собирается в рантайме или вызов идёт через универсальную обёртку send(method, path) — ищи grep по последнему сегменту пути.`;
  } else if (a.client.length && a.client.every((c) => !c.consumers.length)) {
    a.hint = 'Вызов найден, потребителя нет: dispatch по вычисляемой строке, DI без типа или мёртвый метод.';
  }
  return a;
}

// ---------------- отрисовка ----------------

const STATUS_RU: Record<Status, string> = {
  found: 'найдено',
  dynamic_candidates: 'динамический ключ — точного использования нет',
  key_unused: 'ключ есть, использований нет',
  fuzzy_only: 'точного нет, есть похожие',
  not_found: 'не найдено',
  unsupported: 'проект не распознан',
};

function renderRoutes(p: Place, out: string[], ind: string): void {
  if (p.routeRecord) {
    out.push(`${ind}это запись роута ${p.routeRecord.path} (${p.routeRecord.at})`);
    return;
  }
  for (const r of p.routes) {
    out.push(`${ind}роут ${r.path}${r.kind !== 'page' ? ` [${r.kind}]` : ''}${r.name ? ` name=${r.name}` : ''} (${r.at})${r.viaParent ? ' — через родительскую страницу' : ''}`);
    if (r.via.length > 1) out.push(`${ind}  через ${r.via.join(' → ')}`);
    if (r.meta) out.push(`${ind}  meta ${r.meta}`);
  }
  if (p.routesTotal > p.routes.length) out.push(`${ind}… ещё ${p.routesTotal - p.routes.length} роутов (общий компонент)`);
  if (!p.routes.length && p.global) out.push(`${ind}роута нет — глобальный элемент: ${p.global.join(' → ')}`);
  if (!p.routes.length && !p.global) out.push(`${ind}роута нет, файл никто не импортирует`);
  if (p.api.length) out.push(`${ind}api: ${p.api.join('; ')}`);
}

export function render(a: TextAnswer | RouteAnswer | FileAnswer | ApiAnswer): string {
  const out: string[] = [`статус: ${a.status} (${STATUS_RU[a.status]})`];
  if (a.tool === 'text') {
    for (const k of a.keys) {
      out.push(`ключ ${k.key} = «${k.value}»${k.lang ? ` [${k.lang}]` : ''} (${k.at})`);
      if (!k.usages.length) out.push('  использований нет');
      for (const u of k.usages) {
        out.push(`  ${u.at}${u.how === 'prefix+key' ? ' [префикс + ключ]' : u.how === 'dynamic' ? ' [динамический ключ: префикс + переменная]' : ''}`);
        renderRoutes(u, out, '    ');
      }
      if (k.usagesTotal > k.usages.length) out.push(`  … ещё ${k.usagesTotal - k.usages.length} мест`);
    }
    for (const h of a.hardcoded) {
      out.push(`вшито: ${h.at}`);
      renderRoutes(h, out, '  ');
    }
    if (a.dynamic.length) {
      out.push('динамические кандидаты:');
      for (const d of a.dynamic) out.push(`  ${d.at} — префикс ${d.prefix}.*, подходят ключи: ${d.keys.join(', ')}`);
    }
    if (a.near.length) {
      out.push('похожие:');
      for (const x of a.near) out.push(`  ${x.what} «${x.value.slice(0, 100)}» (${x.at}) — сходство ${Math.round(x.score * 100)}%`);
    }
    if (a.status !== 'found') out.push(`проверено: ${a.searched}`);
  } else if (a.tool === 'route') {
    for (const r of a.routes) {
      out.push(`${r.path}${r.kind !== 'page' ? ` [${r.kind}]` : ''}${r.name ? ` name=${r.name}` : ''} (${r.at})`);
      if (r.parents.length) out.push(`  родители: ${r.parents.join(' → ')}`);
      out.push(`  компонент: ${r.component ?? (r.redirect ? `редирект ${r.redirect}` : '—')}`);
      if (r.meta) out.push(`  meta ${r.meta}`);
      if (r.children.length) out.push(`  дети: ${r.children.join(', ')}`);
      if (r.api.length) out.push(`  api: ${r.api.join('; ')}`);
    }
    if (a.near.length) out.push(`похожие роуты: ${a.near.join(', ')}`);
  } else if (a.tool === 'file') {
    if (a.file && a.place) {
      out.push(`${a.file} (импортируют: ${a.fanIn})`);
      renderRoutes(a.place, out, '  ');
    }
    if (a.candidates.length) out.push(`варианты: ${a.candidates.join(', ')}`);
  } else {
    for (const s of a.server) out.push(`обработчик ${s.path} [${s.kind}] (${s.at})`);
    for (const c of a.client) {
      out.push(c.endpoint);
      for (const h of c.handlers) out.push(`  обрабатывает ${h}`);
      if (!c.consumers.length) out.push('  потребителей не найдено');
      for (const x of c.consumers) {
        out.push(`  вызывает ${x.file}`);
        for (const r of x.routes) out.push(`    роут ${r.path}${r.kind !== 'page' ? ` [${r.kind}]` : ''} (${r.at})`);
        if (x.routesTotal > x.routes.length) out.push(`    … ещё ${x.routesTotal - x.routes.length} роутов`);
      }
    }
    if (a.near.length) {
      out.push('похожие:');
      for (const x of a.near) out.push(`  ${x}`);
    }
  }
  if (a.hint) out.push(`что дальше: ${a.hint}`);
  return out.join('\n');
}
