// Sift weekly job. Runs in GitHub Actions once a week.
// 1. Reads every source in data/sources.json and keeps posts from the last 8 days.
// 2. Sends them to Claude, which merges the same story, summarises and tags each one.
// 3. Saves the pool to data/weeks/<week>.json, data/latest.json and data/index.json.
// The app picks five per person from the pool. No AI call happens in the app.
// Run with: ANTHROPIC_API_KEY=... node scripts/weekly.mjs
// Add --dry to only fetch and print what was found, without calling Claude.
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const DATA = path.join(root, 'data')
const DRY = process.argv.includes('--dry')
const MODEL = process.env.SIFT_MODEL || 'claude-sonnet-5-5'
const DAYS = 8
const PER_SOURCE = 12
const TEXT_LIMIT = { article: 1800, digest: 9000 }

const readJSON = (p) => JSON.parse(fs.readFileSync(path.join(DATA, p), 'utf8'))
const { sources } = readJSON('sources.json')
const { topics } = readJSON('topics.json')
const THIS_WEEK = weekId(new Date())
// Urls used in earlier weeks, so pages without dates do not repeat. A rerun in the same week may use them again.
const seenFile = fs.existsSync(path.join(DATA, 'seen.json')) ? readJSON('seen.json') : {}
const SEEN_MAP = new Map(Array.isArray(seenFile) ? seenFile.map((u) => [u, THIS_WEEK]) : Object.entries(seenFile))
const SEEN = { has: (u) => SEEN_MAP.has(u) && SEEN_MAP.get(u) !== THIS_WEEK, add: (u) => { if (!SEEN_MAP.has(u)) SEEN_MAP.set(u, THIS_WEEK) } }

// ISO week id like 2026-W48, for the Monday the job runs.
function weekId(d) {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const y = t.getUTCFullYear()
  const w = Math.ceil(((t - Date.UTC(y, 0, 1)) / 86400000 + 1) / 7)
  return `${y}-W${String(w).padStart(2, '0')}`
}

// Feeds
const UA = 'Mozilla/5.0 (compatible; SiftWeekly/1.0; +https://yeochoi.github.io/sift/)'
async function get(url) {
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, text/html;q=0.8' }, redirect: 'follow', signal: AbortSignal.timeout(20000) })
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res.text()
}
const decode = (s) => s
  .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
// HTML to plain text, keeping links as "text (url)" so digests keep their story links.
const toText = (html) => decode(decode(html))
  .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, t) => `${t.replace(/<[^>]+>/g, '')} (${href})`)
  .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
  .replace(/<\/(p|li|h\d|div|br)>|<br\s*\/?>/gi, '\n')
  .replace(/<[^>]+>/g, ' ')
  .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim()
const tag = (block, name) => {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'))
  return m ? m[1].trim() : ''
}
function parseFeed(xml) {
  const items = []
  const blocks = xml.match(/<item[\s>][\s\S]*?<\/item>/gi) || xml.match(/<entry[\s>][\s\S]*?<\/entry>/gi) || []
  for (const b of blocks) {
    const title = toText(tag(b, 'title'))
    let link = decode(tag(b, 'link'))
    if (!link) { const m = b.match(/<link[^>]*href="([^"]+)"[^>]*\/?>/i); link = m ? decode(m[1]) : '' }
    const date = tag(b, 'pubDate') || tag(b, 'published') || tag(b, 'updated') || tag(b, 'dc:date')
    const body = tag(b, 'content:encoded') || tag(b, 'content') || tag(b, 'description') || tag(b, 'summary')
    if (title && link) items.push({ title, url: link.trim(), date: date ? new Date(decode(date)).toISOString() : null, text: toText(body) })
  }
  return items
}
async function readSource(src) {
  const tried = []
  const urls = [...(src.feeds || [])]
  for (let i = 0; i < urls.length; i++) {
    try {
      const xml = await get(urls[i])
      const items = parseFeed(xml)
      if (items.length) return { items, feed: urls[i] }
      tried.push(`${urls[i]} had no items`)
    } catch (e) { tried.push(e.message) }
    // After the listed feeds, look for a feed link on the home page once.
    if (i === urls.length - 1 && !src._looked) {
      src._looked = true
      try {
        const html = await get(src.home)
        const m = html.match(/<link[^>]+type="application\/(?:rss|atom)\+xml"[^>]*>/i)
        const href = m && m[0].match(/href="([^"]+)"/i)
        if (href) urls.push(new URL(decode(href[1]), src.home).href)
      } catch (e) { tried.push(e.message) }
    }
  }
  // No feed. Read article links from the home page and take ones not seen in earlier weeks.
  if (src.page) {
    try {
      const html = await get(src.home)
      const re = new RegExp(src.page)
      const found = new Map()
      for (const m of html.matchAll(/<a\s[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
        const url = new URL(decode(m[1]), src.home).href.replace(/#.*$/, '')
        const title = toText(m[2])
        if (re.test(new URL(url).pathname + new URL(url).search) && title.length > 12 && !found.has(url) && !SEEN.has(url)) found.set(url, title)
      }
      const items = []
      for (const [url, title] of [...found].slice(0, 6)) {
        let text = ''
        try {
          const page = await get(url)
          const desc = page.match(/<meta[^>]+(?:property="og:description"|name="description")[^>]+content="([^"]*)"/i)
          const paras = (page.match(/<p[\s>][\s\S]*?<\/p>/gi) || []).slice(0, 8).map(toText).join('\n')
          text = `${desc ? decode(desc[1]) : ''}\n${paras}`.trim()
        } catch { /* keep the title alone */ }
        items.push({ title, url, date: null, text })
      }
      if (items.length) return { items, feed: `page ${src.home}` }
      tried.push('no new article links on home')
    } catch (e) { tried.push(e.message) }
  }
  return { items: [], feed: null, error: tried.join(' | ') }
}

// Claude
const POOL_TOOL = {
  name: 'save_pool',
  description: 'Save this week\'s pool of stories for Sift.',
  input_schema: {
    type: 'object',
    required: ['items'],
    properties: {
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['title', 'url', 'source', 'topics', 'kind', 'summary', 'why', 'importance', 'practical', 'roles', 'mentions'],
          properties: {
            title: { type: 'string', description: 'Plain, short title in sentence case. Rewrite clickbait. No colons, semicolons or dashes.' },
            url: { type: 'string', description: 'The link to the original story, never to a TLDR issue page when the story has its own link.' },
            source: { type: 'string', description: 'Name of the source the url belongs to, like Smashing Magazine. For a digest story, the site the link goes to.' },
            via: { type: 'array', items: { type: 'string' }, description: 'Source ids from the input that covered this story.' },
            published: { type: ['string', 'null'], description: 'ISO date of the post if known.' },
            topics: { type: 'array', items: { type: 'string' }, description: 'One to three topic ids, the best first.' },
            kind: { type: 'string', enum: ['try', 'know'], description: 'try when a designer can use it this week, a pattern, method, tool or guide. know when it is news or context to be aware of.' },
            summary: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3, description: 'Three short points in plain English, each under 14 words, only from what the text says. No colons, semicolons or dashes.' },
            why: { type: 'object', additionalProperties: { type: 'string' }, description: 'For each of its topic ids, one sentence on why this matters to someone following that topic. Add key general for anyone in product design. Plain English, under 30 words, no colons, semicolons or dashes.' },
            importance: { type: 'integer', minimum: 1, maximum: 5, description: 'How much the field will talk about this. 5 is a major launch or shift.' },
            practical: { type: 'integer', minimum: 1, maximum: 5, description: 'How directly a practitioner can use it.' },
            roles: { type: 'array', items: { type: 'string', enum: ['designer', 'pm', 'researcher', 'lead'] }, description: 'Roles it is most useful for.' },
            mentions: { type: 'integer', minimum: 1, description: 'How many input entries covered the same story.' }
          }
        }
      }
    }
  }
}

function prompt(candidates) {
  const topicList = topics.map((t) => `${t.id} = ${t.name}`).join('\n')
  return `You curate Sift, a weekly reading list for product designers, product managers and UX researchers.

Below are posts from trusted sources from the last ${DAYS} days. Entries from digest sources like TLDR hold many short stories each. Split those into separate stories and keep only ones about product design, UX, research, design tools or AI products. Skip gadget rumours, phone colours, funding rounds with no product angle, job ads and sponsor blocks.

Merge entries that are the same story into one item, set mentions to how many entries covered it, and list their source ids in via. Prefer the original article url over a digest.

Return up to 50 items, the most worth a busy practitioner's time first. Use only these topic ids.
${topicList}

Write every summary point and why sentence in your own words from the given text. Never invent facts, numbers or quotes. If the text is too thin to summarise, leave the item out.

Call the save_pool tool once with all the items. Do not answer in text.

POSTS
${candidates.map((c, i) => `[${i + 1}] source=${c.sourceId} (${c.sourceName}) kind=${c.kind} date=${c.date || 'unknown'}\ntitle: ${c.title}\nurl: ${c.url}\ntext: ${c.text}`).join('\n\n')}`
}

async function askClaude(candidates) {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('ANTHROPIC_API_KEY is missing. Add it under Settings, Secrets and variables, Actions.')
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 32000,
      tools: [POOL_TOOL],
      tool_choice: { type: 'auto' },
      messages: [{ role: 'user', content: prompt(candidates) }]
    }),
    signal: AbortSignal.timeout(600000)
  })
  const body = await res.json()
  if (!res.ok) throw new Error(`Claude API ${res.status} ${JSON.stringify(body.error || body)}`)
  const use = (body.content || []).find((b) => b.type === 'tool_use' && b.name === 'save_pool')
  if (use) return { items: use.input.items || [], usage: body.usage }
  // Some models answer in text. Take the JSON from the text instead.
  const text = (body.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  const m = text.match(/\{[\s\S]*"items"[\s\S]*\}/)
  if (m) { try { return { items: JSON.parse(m[0]).items || [], usage: body.usage } } catch {} }
  throw new Error(`Claude did not return the pool. Stop reason ${body.stop_reason}. ${text.slice(0, 300)}`)
}

// Keep only fields and values the app understands.
function clean(items) {
  const ids = new Set(topics.map((t) => t.id))
  const seen = new Set()
  return items
    .map((it) => ({ ...it, topics: (it.topics || []).filter((t) => ids.has(t)).slice(0, 3) }))
    .filter((it) => it.url && it.title && it.topics.length && Array.isArray(it.summary) && it.summary.length)
    .filter((it) => { const k = it.url.replace(/[?#].*$/, '').replace(/\/$/, ''); if (seen.has(k)) return false; seen.add(k); return true })
    .map((it, i) => ({
      id: `${String(i + 1).padStart(2, '0')}-${it.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/-$/, '')}`,
      title: it.title, url: it.url, source: it.source, via: it.via || [], published: it.published || null,
      topics: it.topics, kind: it.kind === 'try' ? 'try' : 'know', summary: it.summary.slice(0, 3), why: it.why || {},
      importance: Math.min(5, Math.max(1, it.importance | 0)), practical: Math.min(5, Math.max(1, it.practical | 0)),
      roles: it.roles || [], mentions: Math.max(1, it.mentions | 0)
    }))
}

async function main() {
  const now = new Date()
  const since = now - DAYS * 86400000
  const status = []
  const candidates = []
  for (const src of sources) {
    const r = await readSource(src)
    const fresh = r.items.filter((it) => (!it.date || new Date(it.date) >= since) && !SEEN.has(it.url)).slice(0, PER_SOURCE)
    status.push({ id: src.id, name: src.name, feed: r.feed, found: r.items.length, kept: fresh.length, error: r.error || null })
    if (src.kind === 'digest') {
      // A digest feed often has only the headlines. Read the issue page for the stories and their links.
      for (const it of fresh) {
        if (it.text.length > 1500) continue
        try {
          const html = await get(it.url)
          const body = html.match(/<main[\s\S]*?<\/main>/i) || html.match(/<body[\s\S]*?<\/body>/i)
          const t = toText(body ? body[0] : html)
          if (t.length > it.text.length) it.text = t
        } catch { /* keep the feed text */ }
      }
    }
    for (const it of fresh) candidates.push({ ...it, sourceId: src.id, sourceName: src.name, kind: src.kind, text: it.text.slice(0, TEXT_LIMIT[src.kind] || 1800) })
  }
  console.table(status.map(({ id, kept, found, error }) => ({ id, kept, found, error: error ? error.slice(0, 80) : '' })))
  if (DRY) return
  if (!candidates.length) throw new Error('No posts found in any source this week.')

  const { items, usage } = await askClaude(candidates)
  const pool = clean(items)
  const week = weekId(now)
  const out = { week, created: now.toISOString(), model: MODEL, sample: false, sources: status, usage, items: pool }
  fs.mkdirSync(path.join(DATA, 'weeks'), { recursive: true })
  fs.writeFileSync(path.join(DATA, 'weeks', `${week}.json`), JSON.stringify(out, null, 1))
  fs.writeFileSync(path.join(DATA, 'latest.json'), JSON.stringify(out, null, 1))
  const weeks = fs.readdirSync(path.join(DATA, 'weeks')).filter((f) => /^\d{4}-W\d\d\.json$/.test(f)).map((f) => f.replace('.json', '')).sort().reverse()
  for (const c of candidates) SEEN.add(c.url)
  fs.writeFileSync(path.join(DATA, 'seen.json'), JSON.stringify(Object.fromEntries([...SEEN_MAP].slice(-3000))))
  fs.writeFileSync(path.join(DATA, 'index.json'), JSON.stringify({ latest: week, weeks }, null, 1))
  console.log(`${week}: ${pool.length} items from ${candidates.length} posts`)
}

export { parseFeed, toText, weekId, clean, readSource, askClaude }
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname)) {
  main().catch((e) => { console.error(e.message); process.exit(1) })
}
