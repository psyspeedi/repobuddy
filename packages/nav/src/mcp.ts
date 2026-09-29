#!/usr/bin/env node
// MCP-сервер rb-nav (stdio). Индекс держится в памяти и догоняет изменения
// файлов при каждом вызове (инкрементально, ~0,1–0,3 с).
import fs from 'node:fs';
import path from 'node:path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { buildIndex, type NavIndex } from './indexer.ts';
import { Nav } from './query.ts';
import { apiAnswer, fileAnswer, render, routeAnswer, textAnswer } from './answer.ts';

const cache = new Map<string, { ix: NavIndex; nav: Nav }>();

function findRoot(start: string): string {
  for (let d = path.resolve(start); ; d = path.dirname(d)) {
    if (fs.existsSync(path.join(d, 'package.json'))) return d;
    if (path.dirname(d) === d) return path.resolve(start);
  }
}

function navFor(repo?: string): { nav: Nav; root: string } {
  const base = process.env.RB_NAV_ROOT || process.cwd();
  const root = findRoot(repo ? path.resolve(base, repo) : base);
  const { index } = buildIndex(root);
  const hit = cache.get(root);
  if (hit && hit.ix === index) return { nav: hit.nav, root };
  const nav = new Nav(index);
  cache.set(root, { ix: index, nav });
  return { nav, root };
}

const repoArg = z
  .string()
  .optional()
  .describe('Корень фронтенд-проекта (каталог с package.json), абсолютный или относительный. По умолчанию — текущий проект.');

const READ_THE_STATUS =
  'Ответ начинается со «статус:». found — найдено; dynamic_candidates — ключ собирается динамически, открой указанные места; ' +
  'key_unused — ключ в словаре есть, использований нет; fuzzy_only — точного нет, показаны похожие; not_found — не найдено, ' +
  'и строка «проверено» говорит, где искали, а «что дальше» — куда смотреть; unsupported — проект не распознан. ' +
  'Не делай вывод «этого нет в коде» по not_found без чтения подсказки.';

const server = new McpServer({ name: 'rb-nav', version: '0.1.0' });

server.registerTool(
  'nav_text',
  {
    title: 'Где в коде текст с экрана',
    description:
      'Находит, где в коде фронтенда живёт текст, который видно на экране (кнопка, заголовок, подсказка, сообщение), — ' +
      'через ключ i18n или вшитый текст: файл:строка использования, компоненты по цепочке импортов, роут (путь, meta, роли) и api, ' +
      'которые дёргает этот экран. Используй ПЕРВЫМ, когда задача описана через интерфейс («на странице X кнопка Y», скриншот, ' +
      'текст из постановки или от тестировщика), вместо grep по тексту, локалям и роутеру. Работает с Vue/Nuxt, React/Next/Remix, ' +
      'Svelte/SvelteKit, Angular, Astro, с i18n и без. ' +
      READ_THE_STATUS,
    inputSchema: { text: z.string().min(2).describe('Текст как на экране; можно фрагмент.'), repo: repoArg },
    annotations: { readOnlyHint: true },
  },
  async ({ text, repo }) => {
    const { nav } = navFor(repo);
    return { content: [{ type: 'text', text: render(textAnswer(nav, text)) }] };
  },
);

server.registerTool(
  'nav_route',
  {
    title: 'Что за экран по адресу',
    description:
      'Роут по фрагменту пути, имени роута или файлу компонента: компонент экрана, родительские роуты и layout, meta (роли, ' +
      'заголовок), дочерние роуты и api, которые экран вызывает. Используй, когда известен URL экрана или его имя. ' +
      READ_THE_STATUS,
    inputSchema: { route: z.string().describe('Фрагмент пути (/student/grade-book), имя роута или имя файла компонента.'), repo: repoArg },
    annotations: { readOnlyHint: true },
  },
  async ({ route, repo }) => {
    const { nav } = navFor(repo);
    return { content: [{ type: 'text', text: render(routeAnswer(nav, route)) }] };
  },
);

server.registerTool(
  'nav_file',
  {
    title: 'На каких экранах файл',
    description:
      'Для файла фронтенда: на каких экранах (роутах) он показывается и через какую цепочку импортов, или что он глобальный ' +
      '(layout/App/плагин), и какие api рядом. Используй перед правкой компонента, чтобы знать, что заденешь. ' +
      READ_THE_STATUS,
    inputSchema: { file: z.string().describe('Путь к файлу (относительно проекта или абсолютный) или уникальная часть имени.'), repo: repoArg },
    annotations: { readOnlyHint: true },
  },
  async ({ file, repo }) => {
    const { nav, root } = navFor(repo);
    return { content: [{ type: 'text', text: render(fileAnswer(nav, root, file)) }] };
  },
);

server.registerTool(
  'nav_api',
  {
    title: 'Кто вызывает ручку',
    description:
      'По фрагменту URL или имени метода api: где объявлен вызов (метод, URL, файл:строка), кто его вызывает (сторы, запросы, ' +
      'компоненты), на каких экранах, и серверный обработчик, если он в этом же проекте (Next/Nuxt/SvelteKit/Remix). ' +
      'Используй, чтобы найти экран по ручке из задачи или понять, какую ручку подменять при проверке. ' +
      READ_THE_STATUS,
    inputSchema: { url: z.string().describe('Фрагмент URL (journal/attendances) или имя метода.'), repo: repoArg },
    annotations: { readOnlyHint: true },
  },
  async ({ url, repo }) => {
    const { nav } = navFor(repo);
    return { content: [{ type: 'text', text: render(apiAnswer(nav, url)) }] };
  },
);

await server.connect(new StdioServerTransport());
