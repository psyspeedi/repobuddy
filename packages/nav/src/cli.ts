#!/usr/bin/env node
// rb-nav: навигация по фронту — текст на экране → ключ → компонент → роут → api.
import fs from 'node:fs';
import path from 'node:path';
import { buildIndex } from './indexer.ts';
import { Nav } from './query.ts';
import { apiAnswer, fileAnswer, render, routeAnswer, textAnswer } from './answer.ts';

const USAGE = `rb-nav — навигация по фронту без LLM: Vue/Nuxt, React/Next/Remix, Svelte/SvelteKit, Angular, Astro и др.

  rb-nav text "<текст с экрана>"   ключи i18n и вшитый текст → компоненты → роуты → api
  rb-nav route <путь|имя|файл>     роут: компонент, родители, meta, дети, api
  rb-nav file <путь>               в каких роутах живёт файл и какие api дёргает
  rb-nav api <фрагмент url>        эндпоинт → кто вызывает → экраны; серверный обработчик
  rb-nav index [--force]           построить/обновить индекс
  rb-nav stats                     что нашлось в проекте
  rb-nav mcp                       MCP-сервер (stdio) для Claude Code и других агентов

  --repo <dir>   корень проекта (по умолчанию — ближайший вверх с package.json)
  --json         машиночитаемый вывод (тот же ответ, что отдаёт MCP)

Ответ всегда начинается со статуса: found, dynamic_candidates, key_unused,
fuzzy_only, not_found, unsupported — и для «пустых» статусов объясняет, что
проверено и куда смотреть дальше.`;

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

function stats(nav: Nav): string {
  const ix = nav.ix;
  const files = Object.values(ix.files);
  const api = files.reduce((n, f) => n + (f.facts?.apiCalls.length ?? 0), 0);
  const kinds = { page: 0, layout: 0, server: 0 };
  for (const r of ix.routes) kinds[r.kind ?? 'page']++;
  return [
    `корень ${ix.root}`,
    `стек: ${ix.stack.join(', ') || '—'}; языки: ${ix.langs.join(', ') || '—'}`,
    `экранов ${kinds.page}, layout ${kinds.layout}, серверных ручек ${kinds.server}; автоимпортов ${Object.keys(ix.autoImports ?? {}).length}`,
    `файлов ${files.length}, язык локали ${ix.lang ?? '—'}, ключей ${Object.keys(ix.keys).length}`,
    `роутов ${ix.routes.length}, с компонентом ${ix.routes.filter((r) => r.component).length}`,
    `http-вызовов ${api}, глобальных компонентов ${Object.keys(ix.globals).length}`,
  ].join('\n');
}

async function main(): Promise<void> {
  const a = parseArgs(process.argv.slice(2));
  if (!a.cmd || a.cmd === 'help' || a.cmd === '--help') {
    console.log(USAGE);
    return;
  }
  if (a.cmd === 'mcp') {
    if (a.repo) process.env.RB_NAV_ROOT = path.resolve(a.repo);
    await import('./mcp.ts');
    return;
  }
  const root = a.repo ? path.resolve(a.repo) : findRoot(process.cwd());
  const { index, stats: st } = buildIndex(root, { force: a.force });
  const nav = new Nav(index);
  const q = a.rest.join(' ');
  let answer: Parameters<typeof render>[0];
  switch (a.cmd) {
    case 'index':
      console.log(`индекс ${root}: файлов ${st.total}, разобрано ${st.parsed}, удалено ${st.removed}, ошибок ${st.failed.length}, ${st.ms} мс`);
      for (const f of st.failed.slice(0, 10)) console.log(`  ! ${f}`);
      return;
    case 'stats':
      console.log(stats(nav));
      return;
    case 'text':
      answer = textAnswer(nav, q);
      break;
    case 'route':
      answer = routeAnswer(nav, q);
      break;
    case 'file':
      answer = fileAnswer(nav, root, q);
      break;
    case 'api':
      answer = apiAnswer(nav, q);
      break;
    default:
      console.error(`неизвестная команда ${a.cmd}\n\n${USAGE}`);
      process.exit(2);
  }
  console.log(a.json ? JSON.stringify(answer, null, 2) : render(answer));
}

await main();
