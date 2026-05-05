import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
    },
    rules: {
      // Catch missed-dep bugs in useMemo / useCallback / useEffect.
      // Was off by default; the ListCardPicker rarity-filter bug
      // (filters.selectedRarities referenced inside a useMemo whose
      // dep array didn't include it) would have been caught
      // immediately had this been enabled. Deliberate narrow deps
      // opt out per-line with
      //   // eslint-disable-next-line react-hooks/exhaustive-deps
      // and a comment explaining the choice.
      'react-hooks/exhaustive-deps': 'error',
    },
  },
])
