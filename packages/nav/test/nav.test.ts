import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.RB_NAV_CACHE = fs.mkdtempSync(path.join(os.tmpdir(), 'rb-nav-test-'));

const { buildIndex } = await import('../src/indexer.ts');
const { Nav } = await import('../src/query.ts');

const here = path.dirname(fileURLToPath(import.meta.url));
const vue = new Nav(buildIndex(path.join(here, 'fixtures/vue-app'), { force: true }).index);
const react = new Nav(buildIndex(path.join(here, 'fixtures/react-app'), { force: true }).index);

const routePaths = (nav: InstanceType<typeof Nav>, file: string) => nav.routesFor(file).hits.map((h) => h.route.path).sort();

test('префикс ключа берётся из пути файла локали', () => {
  assert.equal(vue.ix.keys['common.tabs.grades']?.value, 'Оценки за занятия');
  assert.equal(vue.ix.keys['pages.group.reports.vk.chats']?.value, 'Чаты сообщества ВКонтакте');
  assert.equal(vue.ix.keys['pages.group.title']?.line, 2);
});

test('дерево роутов: спреды, константа-компонент, реэкспорт из index, enum-имена, дети', () => {
  const byPath = Object.fromEntries(vue.ix.routes.map((r) => [r.path, r]));
  assert.equal(byPath['/']?.component, 'src/views/Home.vue');
  assert.equal(byPath['/']?.name, 'home');
  const group = byPath['/teacher/groups/:groupId(\\d+)'];
  assert.equal(group?.component, 'src/views/Group/GroupPage.vue');
  assert.equal(group?.name, 'teacherGroup');
  assert.match(group?.meta ?? '', /permissions: \['TEACHER'\]/);
  const grades = byPath['/teacher/groups/:groupId(\\d+)/grades'];
  assert.equal(grades?.component, 'src/components/GradesTab.vue');
  assert.equal(vue.ix.routes[grades!.parent!], group);
});

test('текст → ключ через useGetTranslation(prefix) + t(key)', () => {
  const [k] = vue.keysByText('оценки ЗА занятия');
  assert.equal(k?.key, 'common.tabs.grades');
  const uses = vue.usagesOfKey('common.tabs.grades');
  assert.deepEqual(uses.map((u) => [u.file, u.line, u.how]), [['src/components/GradesTab.vue', 3, 'prefix+key']]);
});

test('ключ из шаблонной строки с префиксом-константой', () => {
  const uses = vue.usagesOfKey('pages.group.reports.vk.chats');
  assert.deepEqual(uses.map((u) => u.file), ['src/views/Group/GroupPage.vue']);
});

test('варианты ключа с суффиксом (P.L.default) и префикс в константе', () => {
  const uses = vue.usagesOfKey('pages.group.banner.sign.default');
  assert.deepEqual(uses.map((u) => u.file), ['src/components/SignBanner.vue']);
});

test('компонент → роуты через импорты, кратчайший путь', () => {
  assert.deepEqual(routePaths(vue, 'src/components/SignBanner.vue'), ['/teacher/groups/:groupId(\\d+)']);
  assert.deepEqual(routePaths(vue, 'src/components/GradesTab.vue'), ['/teacher/groups/:groupId(\\d+)', '/teacher/groups/:groupId(\\d+)/grades']);
  const hit = vue.routesFor('src/components/SignBanner.vue').hits[0]!;
  assert.deepEqual(hit.via, ['src/components/SignBanner.vue', 'src/views/Group/GroupPage.vue']);
});

test('глобальный компонент связывается по тегу шаблона', () => {
  assert.deepEqual(routePaths(vue, 'src/components/MButton.vue'), ['/teacher/groups/:groupId(\\d+)', '/teacher/groups/:groupId(\\d+)/grades']);
});

test('элемент layout без роута — путь до верхнего уровня', () => {
  assert.equal(vue.routesFor('src/components/RevertButton.vue').hits.length, 0);
  assert.deepEqual(vue.pathToTop('src/components/RevertButton.vue'), [
    'src/components/RevertButton.vue', 'src/layouts/Layout.vue', 'src/App.vue', 'src/main.ts',
  ]);
  assert.equal(vue.textInCode('вернуться в админку')[0]?.file, 'src/components/RevertButton.vue');
});

test('api: цепочка вызова и деструктуризация сопоставляются с методом модуля', () => {
  const g = vue.endpointsOf('src/views/Group/GroupPage.vue').map((e) => `${e.method} ${e.url}`);
  assert.deepEqual(g, ['GET /v3/teacher/groups/{id}']);
  const t = vue.endpointsOf('src/components/GradesTab.vue').map((e) => `${e.method} ${e.url}`);
  assert.deepEqual(t, ['GET /v3/teacher/groups/{id}/grades']);
  const all = vue.apiConsumers('/v3/teacher').map((x) => [x.ep.owner, x.consumers]);
  assert.deepEqual(all, [
    ['getGroup', ['src/views/Group/GroupPage.vue']],
    ['getGrades', ['src/components/GradesTab.vue']],
    ['saveReport', []],
  ]);
});

test('тесты и спеки не попадают в индекс', () => {
  assert.equal(vue.ix.files['src/components/GradesTab.spec.ts'], undefined);
  assert.equal(vue.apiConsumers('should/not').length, 0);
});

test('запись роута находится по строке вшитого meta.title', () => {
  const hit = vue.textInCode('Группа').find((h) => h.file.startsWith('src/router/'));
  assert.ok(hit);
  assert.equal(vue.routeAtLine(hit.file, hit.line)?.name, 'teacherGroup');
});

test('react: пути из объекта-конфига, lazy-роут, потребители api по импорту', () => {
  assert.deepEqual(react.ix.routes.map((r) => [r.path, r.component]), [
    ['/app', null],
    ['/app/discussions/:discussionId', 'src/app/discussion.tsx'],
  ]);
  const [c] = react.apiConsumers('/comments');
  assert.deepEqual(c?.consumers, ['src/features/comments/components/comments-list.tsx']);
  assert.deepEqual(routePaths(react, 'src/features/comments/components/comments-list.tsx'), ['/app/discussions/:discussionId']);
});

test('react без i18n: видимый текст JSX и текстовые атрибуты на любом языке', () => {
  const [a] = react.textInCode('no comments yet');
  assert.deepEqual([a?.file, a?.line], ['src/features/comments/components/comments-list.tsx', 6]);
  assert.equal(react.textInCode('Discussion comments')[0]?.line, 5);
  assert.equal(react.keysByText('comments').length, 0);
});
