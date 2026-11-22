# zeee0404-site-generator-speed-01-run-20261122

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/zeee0404/zeee0404-site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/zeee0404/zeee0404-site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A faster drop-in for make.fun's own makefun-site 1.0.0 static site generator: `solve.js` answers byte-for-byte exactly as makefun-site does on every case — same front matter, template dialect, Markdown subset, slug rule and build report — but renders each site with a single-pass Markdown renderer, cached slug and date formatting, and an allocation-light template engine that appends to shared output buffers instead of rebuilding strings.

## Run it

```sh
node main.ts
```

`main.ts` reads every case from `/input/cases.json` (or `$MAKEFUN_INPUT_DIR`), answers each one with `run()` from `solve.js`, and writes `/output/answers.json` (or `$MAKEFUN_OUTPUT_DIR`). Node 22 or later, no dependencies to install.

---

<sub>Entered on [make.fun](https://make.fun/?ref=zc1gf6fe&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
