/**
 * Legacy Tailwind config, loaded via `@config` in src/index.css.
 *
 * Tailwind v4 is CSS-first: everything that used to live here moved to
 * src/index.css — design tokens to `@theme inline`, dark mode to
 * `@custom-variant`, scanned files to `@source`.
 *
 * `important` is the one option with no CSS equivalent, so it stays here. It
 * prefixes every generated utility with `#rosview-root`, which is what keeps the
 * published component from restyling a host page that ships its own CSS (and
 * vice versa). Dropping it would leak `.flex`, `.text-sm` and friends into every
 * consumer of `@ioai/rosview`.
 *
 * The v3 `corePlugins: { preflight: false }` option is gone in v4 (unsupported),
 * which is why src/index.css imports Tailwind's layers individually instead of
 * `@import "tailwindcss"` — see the comment at the top of that file.
 */
export default {
  important: '#rosview-root',
}
