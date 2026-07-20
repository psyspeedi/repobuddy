/**
 * vue-i18n runtime options for @nuxtjs/i18n.
 *
 * Russian needs three plural forms and vue-i18n's built-in rule only
 * knows the two-form English shape, so "Отстаёт на 1 коммитов" is what
 * you get without this.
 */
export default defineI18nConfig(() => ({
  legacy: false,
  pluralRules: {
    /**
     * choices: "коммит | коммита | коммитов"
     *   0 → 1, 21, 31 …      (ends in 1, but not 11)
     *   1 → 2-4, 22-24 …     (ends in 2-4, but not 12-14)
     *   2 → 0, 5-20, 25-30 … (everything else)
     */
    ru: (choice: number, choicesLength: number): number => {
      const n = Math.abs(choice)
      const mod10 = n % 10
      const mod100 = n % 100
      if (choicesLength < 3) return n === 1 ? 0 : 1
      if (mod10 === 1 && mod100 !== 11) return 0
      if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 1
      return 2
    },
  },
}))
