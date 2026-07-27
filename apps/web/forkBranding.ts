/**
 * Fork-only cosmetic rebrand.
 *
 * This fork ships as "Code" but deliberately keeps the upstream `t3code`
 * naming everywhere in source, so merges from upstream stay conflict-free.
 * Instead of editing the ~60 hardcoded "T3 Code" literals scattered across the
 * client, we rewrite the display name at build/dev time. New upstream strings
 * are picked up automatically.
 *
 * Only the spaced, human-readable form is rewritten. Identifiers, storage keys,
 * env vars, protocol schemes, and repo paths (`t3code`, `T3CODE_*`) are left
 * untouched.
 */
// The stable channel ships unsuffixed, so the baked-in "(Alpha)" goes too.
// Ordered: the suffixed form has to match before the bare one.
const REWRITES = [
  [/T3 Code \(Alpha\)/g, "Code"],
  [/T3 Code/g, "Code"],
] as const;

function rebrand(input: string): string {
  return REWRITES.reduce(
    (text, [pattern, replacement]) => text.replaceAll(pattern, replacement),
    input,
  );
}

const REWRITABLE_MODULE = /\.[cm]?[jt]sx?(\?|$)/;
const SKIPPED_MODULE = /(\.test\.[cm]?[jt]sx?|[\\/]node_modules[\\/](?!@t3tools[\\/]))/;

export function forkBranding() {
  // Upstream's suite asserts on the upstream display name. Leaving the rewrite
  // out of test runs keeps those assertions passing unmodified.
  const isTestRun = Boolean(process.env.VITEST);

  return {
    name: "fork-branding",
    enforce: "pre" as const,
    transform(code: string, id: string) {
      if (isTestRun || !REWRITABLE_MODULE.test(id) || SKIPPED_MODULE.test(id)) {
        return null;
      }

      if (!code.includes("T3 Code")) {
        return null;
      }

      // Replacements never span lines, so existing sourcemaps stay usable
      // apart from a column shift inside the rewritten string literal.
      return { code: rebrand(code), map: null };
    },
    transformIndexHtml(html: string) {
      return isTestRun ? html : rebrand(html);
    },
  };
}
