# Sift

Five design and AI reads a week, chosen for where you are going. Sift reads trusted sources every Monday, and picks five for your role, your career goal and your topics. When you finish the five, you are done for the week.

Live at https://yeochoi.github.io/sift/. Open it in Safari and choose Add to Home Screen.

## How it works

1. **Every Monday, the same for everyone.** `.github/workflows/weekly.yml` runs `scripts/weekly.mjs`. It reads the sources in `data/sources.json`, keeps posts from the last 8 days, and sends them to Claude. Claude merges the same story from several sources, writes a three point summary and a why line per topic, and tags each one. The pool goes to `data/latest.json` and `data/weeks/<week>.json`.
2. **On the phone, per person.** `pick.js` scores the pool with your settings and picks five. The big story of the week first, then three from your topics, each from a different topic when it can, then one from outside your topics. No AI call happens in the app.

Settings and read marks stay on the phone in local storage.

## Set up

- Add a Claude API key under Settings, Secrets and variables, Actions, as `ANTHROPIC_API_KEY`.
- Turn on GitHub Pages from the main branch.
- Run the job once by hand from the Actions tab, Weekly picks, Run workflow. Until then the app shows a hand picked sample week.
- `node scripts/weekly.mjs --dry` only reads the sources and prints what it found.

## Edit

- Sources in `data/sources.json`. A site with no feed can use `page`, a pattern for article links on its home page.
- Topics, roles, goals and the topic recommendations in `data/topics.json`.
- `design-system/` is the one source for colours, type and rules. Edit `tokens.json` or `README.md` there, then run `node scripts/build-design-system.mjs`.
- Design canvas https://claude.ai/artifact/H3jSSoq2Lag1MJUaxWqroY
