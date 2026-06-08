/**
 * Patches shadcn-nuxt's components-dir registration. The upstream
 * module does:
 *   dirs.unshift({ path: componentsPath, extensions: [] })
 * — an empty extensions array means "scan every file", which causes
 * the sibling `index.ts` barrels to be registered as a second
 * component under the folder's PascalCase name, colliding with the
 * sibling `Button.vue`. Result: a "Two component files resolving to
 * the same name" warning at every boot.
 *
 * We can't change shadcn-nuxt's call. Instead we re-run the same hook
 * AFTER it, find any dir pointing at our UI directory, and restrict
 * its extensions to `.vue`. The barrels still get parsed by
 * shadcn-nuxt's separate `addComponent` loop (which reads index.ts
 * exports explicitly), so nothing breaks downstream.
 */
import { defineNuxtModule } from '@nuxt/kit'

export default defineNuxtModule({
  meta: { name: 'repobuddy:dedupe-components' },
  setup(_options, nuxt) {
    nuxt.hook('components:dirs', (dirs) => {
      for (const d of dirs) {
        if (
          typeof d === 'object'
          && typeof d.path === 'string'
          && d.path.includes('components/ui')
        ) {
          d.extensions = ['vue']
        }
      }
    })
  },
})
