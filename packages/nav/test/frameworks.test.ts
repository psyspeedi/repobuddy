import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.RB_NAV_CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-nav-fw-'));

const { buildIndex, nuxtComponentName } = await import('../src/indexer.ts');
const { Nav } = await import('../src/query.ts');

const here = path.dirname(fileURLToPath(import.meta.url));
const load = (name: string) => {
  const { index, stats } = buildIndex(path.join(here, 'fixtures', name), { force: true });
  assert.deepEqual(stats.failed, [], `${name}: ошибки разбора`);
  return new Nav(index);
};
type NavT = InstanceType<typeof Nav>;

/** Ключ по тексту → файл использования → пути роутов. */
function trace(nav: NavT, text: string): { key: string; usage: string; routes: string[] } {
  const [k] = nav.keysByText(text);
  assert.ok(k, `ключ для «${text}» не найден`);
  const [u] = nav.usagesOfKey(k.key);
  assert.ok(u, `использование ${k.key} не найдено`);
  return { key: k.key, usage: `${u.file}:${u.line}`, routes: nav.routesFor(u.file).hits.map((h) => h.route.path).sort() };
}

const eps = (nav: NavT, file: string) => nav.endpointsNear(file).map((e) => `${e.method} ${e.url}`);

test('next: app router, группы и слоты, next-intl, route handlers', () => {
  const nav = load('next-app');
  assert.deepEqual(trace(nav, 'купить сейчас'), {
    key: 'Product.buy',
    usage: 'src/components/BuyButton.tsx:5',
    routes: ['/:locale/products/:id'],
  });
  // Поиск по переводу на другой язык находит тот же ключ.
  assert.equal(nav.keysByText('Buy now')[0]?.key, 'Product.buy');
  const page = nav.ix.routes.find((r) => r.path === '/:locale/products/:id')!;
  assert.equal(nav.ix.routes[page.parent!]?.kind, 'layout');
  const api = nav.ix.routes.find((r) => r.kind === 'server')!;
  assert.deepEqual([api.path, api.methods], ['/api/products/:id', ['GET', 'DELETE']]);
  assert.deepEqual(nav.handlersFor('/api/products/{params.id}').map((r) => r.file), ['src/app/api/products/[id]/route.ts']);
  assert.ok(!nav.ix.routes.some((r) => r.file.includes('_private')), 'приватные папки — не роуты');
});

test('nuxt: yaml-локали, автоимпорт компонентов и composables, вложенные страницы, server/api', () => {
  const nav = load('nuxt-app');
  assert.equal(nav.ix.keys['cart.checkout']?.line, 3);
  assert.deepEqual(trace(nav, 'оформить заказ').routes, ['/cart']);
  // <BaseButton> без импорта → components/base/BaseButton.vue.
  assert.deepEqual(nav.routesFor('components/base/BaseButton.vue').hits.map((h) => h.route.path), ['/cart']);
  // useCart() без импорта → composables/useCart.ts → $fetch.
  assert.deepEqual(eps(nav, 'pages/cart.vue'), ['GET /api/cart']);
  assert.deepEqual(nav.handlersFor('/api/cart').map((r) => r.methods), [['GET']]);
  const child = nav.ix.routes.find((r) => r.path === '/users/:id')!;
  assert.equal(nav.ix.routes[child.parent!]?.path, '/users');
  assert.ok(nav.ix.routes.some((r) => r.kind === 'layout' && r.path === 'layout:default'));
  assert.equal(nav.textInCode('подвал сайта')[0]?.file, 'layouts/default.vue');
});

test('nuxt: имена автоимпортируемых компонентов по пути', () => {
  assert.equal(nuxtComponentName(['base', 'foo', 'Button']), 'BaseFooButton');
  assert.equal(nuxtComponentName(['base', 'BaseButton']), 'BaseButton');
  assert.equal(nuxtComponentName(['form', 'input', 'index']), 'FormInput');
  assert.equal(nuxtComponentName(['TheHeader']), 'TheHeader');
});

test('sveltekit: svelte-i18n, paraglide, $lib, +page.ts, +server.ts, группы', () => {
  const nav = load('sveltekit-app');
  assert.deepEqual(trace(nav, 'профиль в меню'), {
    key: 'nav.profile',
    usage: 'src/routes/(app)/profile/[id]/+page.svelte:8',
    routes: ['/profile/:id'],
  });
  assert.deepEqual(trace(nav, 'привет, мир').key, 'hello_world');
  assert.deepEqual(eps(nav, 'src/routes/(app)/profile/[id]/+page.svelte'), ['GET /api/users/{params.id}']);
  assert.deepEqual(nav.handlersFor('/api/users/{params.id}').map((r) => r.file), ['src/routes/api/users/[id]/+server.ts']);
  // Avatar через $lib и alt-текст.
  assert.deepEqual(nav.routesFor('src/lib/Avatar.svelte').hits.map((h) => h.route.path), ['/profile/:id']);
  assert.equal(nav.textInCode('аватар пользователя')[0]?.line, 5);
});

test('angular: provideRouter, loadChildren + forChild, loadComponent, templateUrl, селекторы, пайпы', () => {
  const nav = load('angular-app');
  const paths = nav.ix.routes.map((r) => `${r.path} ${r.component ?? r.redirect ?? '-'}`);
  assert.ok(paths.includes('/ src/app/home/home.component.ts'));
  assert.ok(paths.includes('/orders src/app/orders/orders-list/orders-list.component.ts'));
  assert.ok(paths.includes('/orders/:id src/app/orders/order-details.component.ts'));
  assert.ok(paths.includes('/profile src/app/profile/profile.component.ts'));
  assert.deepEqual(trace(nav, 'заказов пока нет'), {
    key: 'ORDERS.EMPTY',
    usage: 'src/app/orders/orders-list/orders-list.component.html:3',
    routes: ['/orders'],
  });
  assert.equal(nav.usagesOfKey('ORDERS.TITLE')[0]?.line, 1);
  // Компонент, подключённый только селектором <app-order-row>.
  assert.deepEqual(nav.routesFor('src/app/orders/order-row/order-row.component.ts').hits.map((h) => h.route.path), ['/orders']);
  // HttpClient в сервисе, внедрённом через конструктор.
  assert.deepEqual(eps(nav, 'src/app/orders/orders-list/orders-list.component.ts'), ['GET /api/orders']);
  // Control flow @if — не видимый текст.
  assert.ok(!nav.textInCode('@if').length);
});

test('remix: плоские роуты, pathless, resource routes, i18next ns:key из public/locales', () => {
  const nav = load('remix-app');
  const byFile = Object.fromEntries(nav.ix.routes.map((r) => [r.file, `${r.path} ${r.kind}`]));
  assert.deepEqual(byFile, {
    'app/routes/_index.tsx': '/ page',
    'app/routes/users.$id.tsx': '/users/:id page',
    'app/routes/_auth.login.tsx': '/login page',
    'app/routes/api.health.ts': '/api/health server',
  });
  assert.deepEqual(trace(nav, 'добро пожаловать'), { key: 'common.greeting', usage: 'app/routes/_index.tsx:4', routes: ['/'] });
});

test('react: JSX-роуты с гардом, react-intl, lingui .po, graphql, axios(config)', () => {
  const nav = load('react-jsx');
  const settings = nav.ix.routes.find((r) => r.path === '/settings');
  assert.equal(settings?.component, 'src/Settings.tsx');
  assert.equal(nav.ix.routes[settings!.parent!]?.component, 'src/Layout.tsx');
  assert.deepEqual(trace(nav, 'настройки профиля').routes, ['/settings']);
  assert.deepEqual(trace(nav, 'сохранить изменения'), { key: 'Save changes', usage: 'src/Settings.tsx:13', routes: ['/settings'] });
  assert.deepEqual(eps(nav, 'src/Settings.tsx').sort(), ['PUT /api/settings', 'QUERY GetMe']);
  assert.deepEqual(nav.apiConsumers('GetMe')[0]?.consumers, ['src/Settings.tsx']);
});

test('astro: страницы, выражения в разметке, endpoints', () => {
  const nav = load('astro-app');
  assert.deepEqual(trace(nav, 'блог компании'), { key: 'blog.title', usage: 'src/pages/blog/[slug].astro:6', routes: ['/blog/:slug'] });
  assert.deepEqual(nav.routesFor('src/components/Card.astro').hits.map((h) => h.route.path), ['/blog/:slug']);
  assert.deepEqual(nav.ix.routes.filter((r) => r.kind === 'server').map((r) => r.path), ['/api/posts']);
});

test('vue: ключи из <i18n>-блока компонента', () => {
  const nav = load('vue-app');
  const [k] = nav.keysByText('локальный привет');
  assert.deepEqual([k?.key, k?.file], ['hello', 'src/components/LocalI18n.vue']);
  assert.equal(nav.keysByText('Local hello').length, 0);
});
