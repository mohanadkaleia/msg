import type { Config } from 'tailwindcss'

// ENG-136 "Ranin" design tokens — the app-wide color system. Every component
// styles itself with these semantic utilities (no hardcoded slate/white/indigo
// palettes remain), and dark mode is live via the `[data-theme]` attribute.
//
// TOKEN MECHANISM: every semantic color is defined once in `src/style.css` as a
// CSS custom property holding SPACE-SEPARATED RGB CHANNELS (e.g. `--c-accent: 91
// 103 228`), NOT a full `rgb(...)`/hex string. We surface each to Tailwind as
// `rgb(var(--c-NAME) / <alpha-value>)`. Tailwind substitutes `<alpha-value>` when
// it expands an opacity modifier, so `bg-accent/50`, `text-primary/70`, etc. all
// keep working — a full-color var would break those modifiers. The light/dark
// values live in `:root` / `[data-theme="dark"]` blocks, so flipping `data-theme`
// re-themes every token-styled component with zero class changes.
//
// CLASS-NAME MAPPING (verify the generated utility names match the design spec):
//   background          -> bg-background / text-background
//   surface             -> bg-surface
//   surface-elevated    -> bg-surface-elevated   (flat key, chosen over nested)
//   surface-hover       -> hover:bg-surface-hover (interactive hover that lifts
//                          on any surface — in dark it is LIGHTER than
//                          surface-elevated, where plain surface would darken)
//   accent              -> bg-accent / text-accent / border-accent / ring-accent
//   accent-fg           -> text-accent-fg        (foreground on an accent fill)
//   accent-subtle       -> bg-accent-subtle      (tinted active/hover surface)
//   danger/warning/success/sync-pending -> bg-*/text-*/border-*
//   danger-fg           -> text-danger-fg        (foreground on a danger fill;
//                          white in both themes, unlike accent-fg which goes
//                          near-black in dark)
//   subtle / strong     -> border-subtle / border-strong  (TOP-LEVEL keys, so the
//                          class is `border-subtle`, avoiding the `border-border`
//                          doubling you'd get from a nested `border.subtle` key)
//   primary/secondary/muted -> text-primary / text-secondary / text-muted
//
// The stock Tailwind palettes (slate-*, indigo-*, …) are still generated but
// app code should not reach for them — new UI styles itself with the semantic
// tokens above so it themes correctly.
export default {
  content: ['./index.html', './src/**/*.{vue,ts}'],
  // Dark mode is driven by an explicit attribute selector, not the media query,
  // so the theme system controls it: useTheme resolves the persisted
  // 'light'|'dark'|'system' preference and the index.html bootstrap script sets
  // data-theme pre-paint. `selector` strategy name kept for Tailwind 3.4.4+.
  darkMode: ['selector', '[data-theme="dark"]'],
  theme: {
    extend: {
      colors: {
        background: 'rgb(var(--c-background) / <alpha-value>)',
        surface: 'rgb(var(--c-surface) / <alpha-value>)',
        'surface-elevated': 'rgb(var(--c-surface-elevated) / <alpha-value>)',
        'surface-hover': 'rgb(var(--c-surface-hover) / <alpha-value>)',
        accent: 'rgb(var(--c-accent) / <alpha-value>)',
        'accent-fg': 'rgb(var(--c-accent-fg) / <alpha-value>)',
        'accent-subtle': 'rgb(var(--c-accent-subtle) / <alpha-value>)',
        danger: 'rgb(var(--c-danger) / <alpha-value>)',
        'danger-fg': 'rgb(var(--c-danger-fg) / <alpha-value>)',
        warning: 'rgb(var(--c-warning) / <alpha-value>)',
        success: 'rgb(var(--c-success) / <alpha-value>)',
        'sync-pending': 'rgb(var(--c-sync-pending) / <alpha-value>)',
        // Border keys — top-level so utilities read `border-subtle`/`border-strong`.
        subtle: 'rgb(var(--c-border-subtle) / <alpha-value>)',
        strong: 'rgb(var(--c-border-strong) / <alpha-value>)',
        // Text keys — top-level so utilities read `text-primary`/`text-secondary`/
        // `text-muted`.
        primary: 'rgb(var(--c-text-primary) / <alpha-value>)',
        secondary: 'rgb(var(--c-text-secondary) / <alpha-value>)',
        muted: 'rgb(var(--c-text-muted) / <alpha-value>)',
      },
      // Anti-bubbly radii — deliberately no xl/2xl. DEFAULT drives bare `rounded`.
      borderRadius: {
        sm: '3px',
        DEFAULT: '4px',
        md: '6px',
        lg: '8px',
      },
      // Type scale: DELIBERATELY NOT overriding Tailwind's named steps here.
      // Existing components use `text-sm`/`text-base`/`text-lg`/`text-xl`, and
      // Tailwind's defaults ship as [size, line-height] tuples — redefining them
      // with bare px values would change both size AND line-height (a visible
      // regression, violating PR-A's zero-visual-change rule). The Ranin compact
      // scale is 11/12/13/14/16/20px; the primitives express it with arbitrary
      // utilities (e.g. `text-[13px]`, `text-[11px]`) so no global step is
      // touched. A dedicated typography sweep can formalize this in a later PR.
    },
  },
  plugins: [],
} satisfies Config
