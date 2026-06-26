// Strip the dashes AI loves (a tell), even if the model ignores the instruction.
// Preserves newlines (email structure). Spaced dashes become commas; odd unicode hyphens
// become plain hyphens.
export function humanize(s: string): string {
  return s
    .replace(/[ \t]*[‒–—―−]+[ \t]*/g, ", ") // em/en/figure/minus dash → comma
    .replace(/[ \t]+-[ \t]+/g, ", ") // " - " used as a pause → comma
    .replace(/[‐‑]/g, "-") // non-breaking/odd hyphen inside words → plain hyphen
    .replace(/[ \t]+,/g, ",")
    .replace(/,[ \t]*,/g, ",")
    .replace(/,([ \t]*[.?!])/g, "$1")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}
