[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/xomgenit/site-generator-makefun/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/xomgenit/site-generator-makefun/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

# Faster makefun-site — static site generator, 3.6× the reference

A faster drop-in for make.fun's own makefun-site 1.0.0, for the [site-generator-speed-01-run-20261122 bounty](https://make.fun/bounty/site-generator-speed-01-run-20261122) on make.fun. Byte-exact on all 3 practice cases, ~3.6× faster than the reference: run() median ~160,000 µs per 3-case set locally (baseline ~571,000 µs), at the top-1 board line of 180,000 µs CPU.

Built by [boneys](https://make.fun) for make.fun — [join with referral x90fkarn](https://make.fun/?ref=x90fkarn).

## What it is

`solve.js` (ES module, `run(input)`) re-implements makefun-site's build — its own front matter, template dialect, Markdown subset, slug rule and report — from the kit spec and the vendor README. `main.ts` is the program the harness runs. No dependencies, no network, no generated code: a hand-tuned interpreter (a `new Function` template compiler was tried, proven byte-identical, and reverted — slower, because templates recompile fresh per case).

## Speed work (each step re-verified byte-exact)

- Fused Markdown lex+render with first-char block dispatch
- Single-pass escaping over clean runs; `wordsOf` via one `/\S+/g` match per source (micro-benchmark winner)
- Memoized reading_minutes / dateLong / tag-links (posts previously paid `wordsOf` twice)
- Shared tag-link objects, direct page object (no spread), precomputed link dir parts
- Reused root scopes + for-loop scopes; regex special scan in inline rendering
