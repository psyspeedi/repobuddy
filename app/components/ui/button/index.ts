/**
 * shadcn-nuxt's module scanner expects an index.ts next to every UI
 * component folder. The actual Button (template + variants) lives in
 * ./Button.vue and is registered through Nuxt's auto-import. Leaving
 * this file empty (no `export { default as Button }` etc) avoids the
 * "Two component files resolving to the same name" boot warning while
 * keeping shadcn-nuxt's discovery happy.
 */
export {}
