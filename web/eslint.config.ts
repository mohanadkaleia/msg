import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import pluginVue from 'eslint-plugin-vue'
import tseslint from 'typescript-eslint'

// Flat config (D-6): JS recommended + typed TS-ESLint + vue3-recommended, with
// eslint-config-prettier LAST so stylistic rules Prettier owns are disabled.
// Prettier stays a separate `format:check` step (no eslint-plugin-prettier) so
// lint is fast and the two reports never overlap.
export default tseslint.config(
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'playwright-report/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  ...pluginVue.configs['flat/recommended'],
  {
    files: ['**/*.{ts,vue}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.vue'],
      },
    },
  },
  {
    // <script> blocks in .vue files are parsed by vue-eslint-parser, which
    // delegates TS parsing to @typescript-eslint/parser.
    files: ['**/*.vue'],
    languageOptions: {
      parserOptions: {
        parser: tseslint.parser,
      },
    },
  },
  {
    // Config files run under Node tooling, not typed against the app project.
    files: ['*.config.{ts,js}'],
    ...tseslint.configs.disableTypeChecked,
  },
  prettier,
)
