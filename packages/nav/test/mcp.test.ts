import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = path.dirname(fileURLToPath(import.meta.url));

async function connect(cwd: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(here, '../src/cli.ts'), 'mcp'],
    cwd,
    env: { ...process.env, RB_NAV_CACHE: fs.mkdtempSync(path.join(os.tmpdir(), 'rb-nav-mcp-')) } as Record<string, string>,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test', version: '0' });
  await client.connect(transport);
  return client;
}

const text = (r: any) => (r.content as { text: string }[]).map((c) => c.text).join('\n');

test('mcp: инструменты, статусы found / fuzzy_only / not_found, корень из cwd и из repo', async () => {
  const client = await connect(path.join(here, 'fixtures/vue-app'));
  try {
    const { tools } = await client.listTools();
    assert.deepEqual(tools.map((t) => t.name).sort(), ['nav_api', 'nav_file', 'nav_route', 'nav_text']);
    assert.ok(tools.every((t) => t.annotations?.readOnlyHint));

    const found = text(await client.callTool({ name: 'nav_text', arguments: { text: 'Оценки за занятия' } }));
    assert.match(found, /^статус: found/);
    assert.match(found, /common\.tabs\.grades/);
    assert.match(found, /\/teacher\/groups/);

    const fuzzy = text(await client.callTool({ name: 'nav_text', arguments: { text: 'Оценка за занятие' } }));
    assert.match(fuzzy, /^статус: fuzzy_only/);
    assert.match(fuzzy, /common\.tabs\.grades/);

    const none = text(await client.callTool({ name: 'nav_text', arguments: { text: 'Иванов Пётр Сергеевич' } }));
    assert.match(none, /^статус: not_found/);
    assert.match(none, /проверено: \d+ ключей/);
    assert.match(none, /данные с сервера/);

    const api = text(await client.callTool({ name: 'nav_api', arguments: { url: '/v3/teacher/groups' } }));
    assert.match(api, /GroupPage\.vue/);

    // repo: другой проект из того же сервера.
    const react = text(await client.callTool({ name: 'nav_route', arguments: { route: 'discussions', repo: path.join(here, 'fixtures/react-app') } }));
    assert.match(react, /^статус: found/);
    assert.match(react, /\/app\/discussions/);
  } finally {
    await client.close();
  }
});

test('mcp: динамический ключ и неиспользуемый ключ — отдельные статусы с подсказками', async () => {
  const client = await connect(path.join(here, 'fixtures/vue-app'));
  try {
    const dyn = text(await client.callTool({ name: 'nav_text', arguments: { text: 'Заказ закрыт' } }));
    assert.match(dyn, /^статус: dynamic_candidates/);
    assert.match(dyn, /status\.closed/);
    assert.match(dyn, /OrderStatus\.vue/);
    assert.match(dyn, /динамический ключ/);

    const unused = text(await client.callTool({ name: 'nav_text', arguments: { text: 'Никому не нужная надпись' } }));
    assert.match(unused, /^статус: key_unused/);
    assert.match(unused, /legacy\.unused/);
    assert.match(unused, /либо мёртвый, либо собирается целиком из данных/);

    const noRoute = text(await client.callTool({ name: 'nav_route', arguments: { route: '/nowhere' } }));
    assert.match(noRoute, /^статус: (not_found|fuzzy_only)/);
    assert.match(noRoute, /что дальше/);
  } finally {
    await client.close();
  }
});
