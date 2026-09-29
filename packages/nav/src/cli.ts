#!/usr/bin/env node
// rb-nav: навигация по фронту — текст на экране → ключ → компонент → роут → api.
import fs from 'node:fs';
import path from 'node:path';
import { buildIndex } from './indexer.ts';
import { Nav, type Endpoint, type RouteHit } from './query.ts';
import type { RouteRec } from './routes.ts';

const USAGE = `rb-nav — навигация по фронту без LLM: Vue/Nuxt, React/Next/Remix, Svelte/SvelteKit, Angular, Astro и др.

  rb-nav text "<текст с экрана>"   ключи i18n и вшитый текст → компоненты → роуты → api
  rb-nav route <путь|имя|файл>     роут: компонент, родители, meta, дети, api
  rb-nav file <путь>               в каких роутах живёт файл и какие api дёргает
  rb-nav api <фрагмент url>        эндпоинт → кто вызывает → на каких экранах
  rb-nav index [--force]           построить/обновить индекс
  rb-nav stats                     что нашлось в проекте

  --repo <dir>   корень проекта (по умолчанию — ближайший вверх с package.json)
  --json         машиночитаемый вывод`;

interface Args {
  cmd: string;
  rest: string[];
  repo: string | null;
  json: boolean;
  force: boolean;
}

function parseArgs(argv: string[]): Args {
  const a: Args = { cmd: '', rest: [], repo: null, json: false, force: false };
  for (let i = 0; i < argv.length; i++) {
    const x = argv[i]!;
    if (x === '--repo') a.repo = argv[++i] ?? null;
    else if (x === '--json') a.json = true;
    else if (x === '--force') a.force = true;
    else if (!a.cmd) a.cmd = x;
    else a.rest.push(x);
  }
  return a;
}

function findRoot(start: string): string {
  for (let d = path.resolve(start); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'package.json'))) return d;
    if (path.dirname(d) === d) return path.resolve(start);
  }
}

const out: string[] = [];
const p = (s = '') => out.push(s);

function routeLabel(r: RouteRec): string {
  const kind = r.kind === 'layout' ? '  [layout]' : r.kind === 'server' ? `  [server ${(r.methods ?? []).join(',') || '*'}]` : '';
  const where = r.kind && r.line === 1 ? r.file : `${r.file}:${r.line}`;
  return `${r.path}${kind}${r.name ? `  name=${r.name}` : ''}  (${where})`;
}

function epLabel(e: Endpoint): string {
  return `${e.method} ${e.url}${e.owner ? `  ${e.owner}()` : ''}  ${e.file}:${e.line}`;
}

function viaLabel(h: RouteHit): string {
  if (h.via.length <= 1) return '';
  return h.via.map((f) => path.basename(f)).join(' → ');
}

function printRoutes(nav: Nav, file: string, indent: string, limit = 3): void {
  const { hits, total } = nav.routesFor(file, limit);
  if (!hits.length) {
    const top = nav.pathToTop(file);
    if (top.length > 1) p(`${indent}роута нет — глобальный элемент: ${top.join(' → ')}`);
    else p(`${indent}роута нет, импортов нет (${nav.fanIn(file)} входящих) — возможно, мёртвый код или подключается динамически`);
    return;
  }
  for (const h of hits) {
    p(`${indent}роут ${routeLabel(h.route)}${h.viaParent ? '  (дочерний: файл в родительской странице)' : ''}`);
    const v = viaLabel(h);
    if (v) p(`${indent}  через ${v}`);
    if (h.route.meta) p(`${indent}  meta ${h.route.meta}`);
  }
  if (total > hits.length) p(`${indent}… и ещё ${total - hits.length} роутов (общий компонент)`);
}

function printApi(nav: Nav, file: string, indent: string, limit = 6): void {
  const eps = nav.endpointsNear(file, 2);
  if (!eps.length) return;
  p(`${indent}api:`);
  for (const e of eps.slice(0, limit)) p(`${indent}  ${epLabel(e)}`);
  if (eps.length > limit) p(`${indent}  … и ещё ${eps.length - limit}`);
}

function cmdText(nav: Nav, q: string, json: boolean): void {
  const keys = nav.keysByText(q);
  const hard = nav.textInCode(q);
  if (json) {
    const res = {
      query: q,
      keys: keys.map((k) => ({
        ...k,
        usages: nav.usagesOfKey(k.key).slice(0, 8).map((u) => ({ ...u, routes: nav.routesFor(u.file, 3).hits, api: nav.endpointsNear(u.file) })),
      })),
      hardcoded: hard.map((h) => ({ ...h, route: nav.routeAtLine(h.file, h.line), routes: nav.routesFor(h.file, 3).hits })),
    };
    p(JSON.stringify(res, null, 2));
    return;
  }
  p(`«${q}»: ключей ${keys.length}, вшитым текстом ${hard.length}`);
  keys.slice(0, 6).forEach((k) => {
    p();
    p(`${k.key} = «${k.value}»${k.lang ? ` [${k.lang}]` : ''}  (${k.file}:${k.line})`);
    const us = nav.usagesOfKey(k.key);
    if (!us.length) p('  не используется (или ключ собирается динамически)');
    for (const u of us.slice(0, 4)) {
      p(`  ${u.file}:${u.line}${u.how === 'prefix+key' ? '  [префикс + ключ]' : u.how === 'dynamic' ? '  [динамический ключ: префикс + переменная]' : ''}`);
      printRoutes(nav, u.file, '    ');
      printApi(nav, u.file, '    ');
    }
    if (us.length > 4) p(`  … и ещё ${us.length - 4} мест: ${us.slice(4, 10).map((u) => path.basename(u.file)).join(', ')}`);
  });
  if (keys.length > 6) p(`\nещё ключи: ${keys.slice(6).map((k) => k.key).join(', ')}`);
  for (const h of hard.slice(0, 6)) {
    p();
    p(`вшито: ${h.file}:${h.line}`);
    const r = nav.routeAtLine(h.file, h.line);
    if (r) p(`    это запись роута ${routeLabel(r)}${r.component ? ` → ${r.component}` : ''}`);
    else {
      printRoutes(nav, h.file, '    ');
      printApi(nav, h.file, '    ');
    }
  }
}

function cmdRoute(nav: Nav, q: string, json: boolean): void {
  const rs = nav.findRoutes(q);
  if (json) {
    p(JSON.stringify(rs.map((r) => ({ ...r, chain: nav.routeChain(r).map((x) => x.path), api: r.component ? nav.endpointsNear(r.component) : [] })), null, 2));
    return;
  }
  if (!rs.length) p(`роутов по «${q}» нет`);
  for (const r of rs.slice(0, 8)) {
    p(routeLabel(r));
    const chain = nav.routeChain(r);
    if (chain.length > 1) p(`  родители: ${chain.slice(0, -1).map((x) => x.path + (x.component ? ` [${path.basename(x.component)}]` : '')).join(' → ')}`);
    p(`  компонент: ${r.component ?? (r.redirect ? `редирект ${r.redirect}` : '—')}`);
    if (r.meta) p(`  meta ${r.meta}`);
    const kids = nav.ix.routes.filter((x) => x.parent !== null && nav.ix.routes[x.parent] === r);
    if (kids.length) p(`  дети: ${kids.map((k) => k.path.slice(r.path.length) || '""').join(', ')}`);
    if (r.component) printApi(nav, r.component, '  ', 10);
    p();
  }
  if (rs.length > 8) p(`… и ещё ${rs.length - 8}: ${rs.slice(8, 20).map((r) => r.path).join(', ')}`);
}

function cmdFile(nav: Nav, root: string, q: string, json: boolean): void {
  const abs = path.resolve(q);
  let rel = fs.existsSync(abs) ? path.relative(root, abs) : q;
  if (!nav.ix.files[rel]) {
    const cand = Object.keys(nav.ix.files).filter((f) => f.endsWith(q) || f.includes(q));
    if (cand.length !== 1) {
      p(cand.length ? `неоднозначно, варианты:\n  ${cand.slice(0, 15).join('\n  ')}` : `файл «${q}» не в индексе`);
      return;
    }
    rel = cand[0]!;
  }
  if (json) {
    p(JSON.stringify({ file: rel, fanIn: nav.fanIn(rel), routes: nav.routesFor(rel, 10), api: nav.endpointsNear(rel) }, null, 2));
    return;
  }
  p(`${rel}  (импортируют: ${nav.fanIn(rel)})`);
  printRoutes(nav, rel, '  ', 8);
  printApi(nav, rel, '  ', 12);
}

function cmdApi(nav: Nav, q: string, json: boolean): void {
  const res = nav.apiConsumers(q);
  const servers = nav.serverRoutes(q);
  if (json) {
    p(JSON.stringify({
      client: res.map((r) => ({ ...r, handlers: nav.handlersFor(r.ep.url), routes: r.consumers.map((c) => ({ file: c, routes: nav.routesFor(c, 3).hits })) })),
      server: servers,
    }, null, 2));
    return;
  }
  if (!res.length && !servers.length) p(`эндпоинтов по «${q}» нет`);
  for (const s of servers.slice(0, 8)) p(`обработчик ${routeLabel(s)}`);
  if (servers.length) p();
  for (const { ep, consumers } of res.slice(0, 8)) {
    p(epLabel(ep));
    for (const h of nav.handlersFor(ep.url).slice(0, 2)) p(`  обрабатывает ${h.file}`);
    if (!consumers.length) p('  вызовов не найдено статически (dispatch по строке, mapActions, внедрение через DI — пока не отслеживается)');
    for (const c of consumers.slice(0, 5)) {
      p(`  вызывает ${c}`);
      printRoutes(nav, c, '    ', 2);
    }
    if (consumers.length > 5) p(`  … и ещё ${consumers.length - 5}`);
    p();
  }
}

function cmdStats(nav: Nav): void {
  const ix = nav.ix;
  const files = Object.values(ix.files);
  const api = files.reduce((n, f) => n + (f.facts?.apiCalls.length ?? 0), 0);
  p(`корень ${ix.root}`);
  p(`стек: ${ix.stack.join(', ') || '—'}; языки: ${ix.langs.join(', ') || '—'}`);
  const kinds = { page: 0, layout: 0, server: 0 };
  for (const r of ix.routes) kinds[r.kind ?? 'page']++;
  p(`экранов ${kinds.page}, layout ${kinds.layout}, серверных ручек ${kinds.server}; автоимпортов ${Object.keys(ix.autoImports ?? {}).length}`);
  p(`файлов ${files.length}, язык локали ${ix.lang ?? '—'}, ключей ${Object.keys(ix.keys).length}`);
  p(`роутов ${ix.routes.length}, с компонентом ${ix.routes.filter((r) => r.component).length}`);
  p(`http-вызовов ${api}, глобальных компонентов ${Object.keys(ix.globals).length}`);
}

function main(): void {
  const a = parseArgs(process.argv.slice(2));
  if (!a.cmd || a.cmd === 'help' || a.cmd === '--help') {
    console.log(USAGE);
    return;
  }
  const root = a.repo ? path.resolve(a.repo) : findRoot(process.cwd());
  const { index, stats } = buildIndex(root, { force: a.force });
  const nav = new Nav(index);
  const q = a.rest.join(' ');
  switch (a.cmd) {
    case 'index':
      p(`индекс ${root}: файлов ${stats.total}, разобрано ${stats.parsed}, удалено ${stats.removed}, ошибок ${stats.failed.length}, ${stats.ms} мс`);
      for (const f of stats.failed.slice(0, 10)) p(`  ! ${f}`);
      break;
    case 'text':
      cmdText(nav, q, a.json);
      break;
    case 'route':
      cmdRoute(nav, q, a.json);
      break;
    case 'file':
      cmdFile(nav, root, q, a.json);
      break;
    case 'api':
      cmdApi(nav, q, a.json);
      break;
    case 'stats':
      cmdStats(nav);
      break;
    default:
      console.error(`неизвестная команда ${a.cmd}\n\n${USAGE}`);
      process.exit(2);
  }
  console.log(out.join('\n'));
}

main();
