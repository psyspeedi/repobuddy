# @repobuddy/nav

Локальный навигатор по фронтенду без LLM. Отвечает на вопрос, с которого
агент начинает почти каждую задачу по UI: **где в коде живёт то, что видно на
экране, и какие ручки его кормят.**

    текст на экране → ключ i18n → место использования → … → компонент роута → роут (meta, роли)
                                                     ↘ api: метод, URL, файл:строка → серверный обработчик

Зачем: замер по 43 рабочим сессиям показал, что около половины объёма
результатов инструментов уходит на ориентирование, в основном grep по
идентификаторам и тексту интерфейса и перечитывание роутера и локалей. Одна
команда заменяет цепочку из 5–10 поисков и выдаёт 1–2 КБ вместо десятков.

## Команды

    rb-nav text "Оценки за занятия"   ключи и вшитый текст → компоненты → роуты → api
    rb-nav route grade-book           роут: компонент, родители, meta, дети, api
    rb-nav file GradeBook.vue         в каких роутах живёт файл и какие api дёргает
    rb-nav api journal/attendances    эндпоинт → кто вызывает → экраны; серверный обработчик
    rb-nav index [--force] | stats

`--repo <dir>` — корень проекта (по умолчанию ближайший вверх с
`package.json`), `--json` — машиночитаемый вывод. Запуск без сборки на
node ≥ 22.6: `node packages/nav/src/cli.ts …`.

Индекс лежит в `~/.cache/rb-nav/` (переопределяется `RB_NAV_CACHE`) и
обновляется инкрементально по mtime при каждом запросе. На 2,7 тыс. файлов
полная сборка занимает около 1 с, запрос — 0,3 с.

## Что поддерживается

Стек определяется по `package.json`, ничего настраивать не нужно.

| Слой | Поддержка |
|---|---|
| Файлы | `.vue` (script, script setup, шаблон, `<i18n>`), `.svelte` (Svelte 4/5), `.astro`, `.ts/.tsx/.js/.jsx`, HTML-шаблоны Angular (`templateUrl` и inline) |
| Роуты по конфигу | vue-router, react-router (объекты, `createBrowserRouter`, JSX `<Route>` с гардами), Angular (`provideRouter`, `RouterModule.forRoot/forChild`, `loadChildren`, `loadComponent`), React Router v7 `app/routes.ts` |
| Роуты по файлам | Next (app и pages router, группы, слоты, layout, `route.ts`, `pages/api`), Nuxt 2/3/4 и `unplugin-vue-router`/`vite-plugin-pages`, SvelteKit (`+page/+layout/+server`, `+page.ts`), Remix flat routes, Astro, Gatsby, SolidStart, Qwik City, TanStack Router, Expo Router |
| Серверные ручки | Next, Nuxt `server/api`, SvelteKit `+server`, Remix resource routes, Astro/Solid endpoints — связываются с клиентскими вызовами по URL |
| i18n | vue-i18n, @nuxtjs/i18n, i18next/react-i18next/next-i18next (`ns:key`), next-intl, react-intl, Lingui, svelte-i18n, typesafe-i18n, Paraglide, ngx-translate, Transloco, Angular i18n (XLIFF); собственные обёртки вида `useGetTranslation(prefix)` |
| Форматы словарей | JSON, YAML (в т.ч. Rails-стиль с корнем-языком), JS/TS (`export default`, `module.exports`, `defineI18nLocale`), `.po`, XLIFF; `public/locales`, `messages/`, `assets/i18n` |
| Без i18n | видимый текст шаблонов, JSX, текстовые атрибуты и любые строки с пробелами (`toast('Saved')`) |
| Api | axios и любые клиенты с `.get/.post/…`, `axios(config)`, `fetch`, `$fetch`, `useFetch`, `ky`, `useSWR`, Angular HttpClient, GraphQL (`gql` → имя операции), цепочки `api.modules.x.getY()`, деструктуризация, прямые вызовы импортированных функций |
| Связи компонентов | импорты с алиасами `tsconfig`/`jsconfig` и фреймворков (`$lib`, `~/`, `@/`), глобальная регистрация, автоимпорт компонентов и composables Nuxt/unplugin, селекторы Angular |

## Как устроено

Конкретные обёртки перевода и api не зашиты — вместо них общие закономерности:

- **Ключ используется в файле**, если там есть строка с ключом целиком или
  строки `P` и `L`, из которых он складывается (`P.L`). Так ловятся
  `useGetTranslation(prefix)` + `t('key')`, `useTranslations('ns')`,
  `` `${prefix}.key` `` с константой и варианты с суффиксом (`P.L.default`).
  Ключ-фраза (gettext) ищется и в видимом тексте.
- **Префикс ключа — путь файла локали** внутри `locales/<lang>/`:
  `pages/taxDeduction.json` → `pages.taxDeduction.*`. Словари всех языков
  загружаются: поиск идёт по любому переводу.
- **Выражения из любых шаблонов** (Vue, Svelte, Astro, Angular) вырезаются и
  проходят через тот же TS-обходчик, что и скрипты.
- **Роуты по конфигу** разбираются через спреды, константы, импорты,
  реэкспорты и вложенные объекты-конфиги путей. Компонент роута: `import()`,
  константа, статический импорт, `lazy`, JSX-элемент (сквозь обёртки-гарды).
- **Api** — вызовы с URL-подобным аргументом и имя метода вокруг них.
  Потребитель сопоставляется по последнему звену цепочки вызова и сегментам
  пути модуля. Клиентский URL сопоставляется с серверной ручкой по шаблону
  пути.

Необязательный `.rbnav.json` в корне проекта:
`{ "lang": "ru", "aliases": { "~/*": "src/*" }, "componentDirs": ["src/ui"] }`.

## Известные ограничения

- vuex `dispatch('ns/action')` и `mapActions` не отслеживаются: в phoenix у
  4% эндпоинтов потребитель не найден.
- Роуты, сгенерированные в рантайме (`.map()` по константам,
  `import.meta.glob`, `require.context`, `addRoute`), попадают в дерево без
  компонента или не попадают вовсе.
- Ключи, собранные полностью динамически (`t(item.description)`), не
  находятся — только те, где хотя бы части ключа лежат строками.
- Layout, подключаемый из guard'а (`afterEach`), не связан с роутами — для
  таких элементов выводится путь импортов до точки входа.
- Pug и другие препроцессоры шаблонов не разбираются.

Проверено на phoenix/frontend и lk/frontend (Vue 3, vuex + pinia +
vue-query), на открытых проектах — elk (Nuxt 4, 40+ языков), next-intl
example (Next app router), Vitesse (vue-router 5, .md-страницы), SvelteKit
realworld, Angular realworld, Remix indie-stack, bulletproof-react — и на
фикстурах для каждого стека из таблицы (`test/fixtures`, 26 тестов).
Индексация elk (430 файлов) — 0,35 с, phoenix (2,7 тыс.) — около 1 с.
