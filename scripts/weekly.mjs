// Sift weekly job. Runs in GitHub Actions once a week.
// 1. Reads every source in data/sources.json and keeps posts from the last 8 days.
// 2. Claude merges the same story, tags and scores each one and writes the briefing. Then the top items get a full summary.
// 3. Saves the pool to data/weeks/<week>.json, data/latest.json and data/index.json.
// The app picks five per person from the pool. No AI call happens in the app.
// Run with: ANTHROPIC_API_KEY=... node scripts/weekly.mjs
// Add --dry to only fetch and print what was found, without calling Claude.
import fs from 'node:fs'
import path from 'node:path'

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..')
const DATA = path.join(root, 'data')
const DRY = process.argv.includes('--dry')
const DAYS = 8
const PER_SOURCE = 12
const TEXT_LIMIT = { article: 900, digest: 9000 }

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
// Stage 1, Sonnet. Short text of every post. Merge, tag, score, a one line gist, and the weekly briefing.
// Stage 2, Haiku. Full text of the top items only. A summary good enough to skip the article.
// Both go through the Batch API, which costs half and is fine for a job that runs at night.
const TRIAGE_MODEL = process.env.SIFT_TRIAGE_MODEL || 'claude-sonnet-5-5'
const SUMMARY_MODEL = process.env.SIFT_SUMMARY_MODEL || 'claude-haiku-5-5'
const DETAIL_COUNT = 10
const FULL_LIMIT = 24000
const NO_PUNCT = 'No colons, semicolons or dashes.'

const POOL_TOOL = {
  name: 'save_pool',
  description: 'Save this week\'s pool of stories and the briefing for Sift.',
  input_schema: {
    type: 'object',
    required: ['brief', 'items'],
    properties: {
      brief: { type: 'string', description: `The week in three or four plain sentences for product designers and PMs. Tell what happened across the most important items, linked into one story, not a list. Only facts from the posts. ${NO_PUNCT}` },
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['n', 'title', 'url', 'source', 'topics', 'kind', 'gist', 'summary', 'why', 'importance', 'practical', 'roles', 'mentions'],
          properties: {
            n: { type: 'array', items: { type: 'integer' }, description: 'The [numbers] of the input posts this item comes from.' },
            title: { type: 'string', description: `Plain, short title in sentence case. Rewrite clickbait. ${NO_PUNCT}` },
            url: { type: 'string', description: 'The link to the original story, never to a TLDR issue page when the story has its own link.' },
            source: { type: 'string', description: 'Name of the site the url belongs to, like Smashing Magazine.' },
            published: { type: ['string', 'null'], description: 'ISO date of the post if known.' },
            topics: { type: 'array', items: { type: 'string' }, description: 'One to three topic ids, the best first.' },
            kind: { type: 'string', enum: ['try', 'know'], description: 'try when a designer can use it this week, a pattern, method, tool or guide. know when it is news or context.' },
            gist: { type: 'string', description: `What the piece says, in one sentence under 25 words. ${NO_PUNCT}` },
            summary: { type: 'array', items: { type: 'string' }, minItems: 3, maxItems: 3, description: `Three short points, each under 14 words. ${NO_PUNCT}` },
            why: { type: 'object', additionalProperties: { type: 'string' }, description: `Exactly two keys. The first topic id, and general. One sentence each, under 25 words, on why it matters. ${NO_PUNCT}` },
            importance: { type: 'integer', minimum: 1, maximum: 5, description: 'How much the field will talk about this. 5 is a major launch or shift.' },
            practical: { type: 'integer', minimum: 1, maximum: 5, description: 'How directly a practitioner can use it.' },
            roles: { type: 'array', items: { type: 'string', enum: ['designer', 'pm', 'researcher', 'lead'] } },
            mentions: { type: 'integer', minimum: 1, description: 'How many input posts covered the same story.' }
          }
        }
      }
    }
  }
}

const DETAIL_TOOL = {
  name: 'save_summary',
  description: 'Save the summary of one article.',
  input_schema: {
    type: 'object',
    required: ['points', 'takeaway'],
    properties: {
      points: {
        type: 'array', minItems: 3, maxItems: 6,
        items: {
          type: 'object', required: ['head', 'text'],
          properties: {
            head: { type: 'string', description: `The point in a few words, sentence case. ${NO_PUNCT}` },
            text: { type: 'string', description: `Two or three sentences that explain it with the article's own facts, examples, numbers and reasoning, so a reader does not need the article. ${NO_PUNCT}` }
          }
        }
      },
      takeaway: { type: 'string', description: `One or two sentences on what a product designer could do with this. ${NO_PUNCT}` }
    }
  }
}

function triagePrompt(candidates) {
  const topicList = topics.map((t) => `${t.id} = ${t.name}`).join('\n')
  return `You curate Sift, a weekly reading list for product designers, product managers and UX researchers.

Below are posts from trusted sources from the last ${DAYS} days. Entries from digest sources like TLDR hold many short stories each. Split those into separate stories and keep only ones about product design, UX, research, design tools or AI products. Skip gadget rumours, phone colours, funding rounds with no product angle, job ads and sponsor blocks.

Merge posts that are the same story into one item and set mentions to how many posts covered it. Prefer the original article url over a digest.

Return up to 30 items, the most worth a busy practitioner's time first. Use only these topic ids.
${topicList}

Write everything in your own words from the given text. Never invent facts, numbers or quotes. If the text is too thin, leave the item out.

Then write the brief, the week in three or four sentences.

Call the save_pool tool once. Do not answer in text.

POSTS
${candidates.map((c, i) => `[${i + 1}] source=${c.sourceId} (${c.sourceName}) kind=${c.kind} date=${c.date || 'unknown'}\ntitle: ${c.title}\nurl: ${c.url}\ntext: ${c.text}`).join('\n\n')}`
}

function detailPrompt(item, text) {
  return `Summarise this article for a busy product designer who will not open it. Keep the substance, the facts, examples, numbers, method and reasoning, so the summary can stand in for the article. Use plain English and your own words. Never add facts that are not in the text, and do not quote long passages.

Call the save_summary tool once. Do not answer in text.

TITLE ${item.title}
SOURCE ${item.source}

ARTICLE
${text}`
}

const API = 'https://api.anthropic.com/v1'
function headers() {
  const key = process.env.ANTHROPIC_API_KEY
  if (!key) throw new Error('ANTHROPIC_API_KEY is missing. Add it under Settings, Secrets and variables, Actions.')
  return { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
}
const params = (model, content, tool, max) => ({
  model, max_tokens: max, thinking: { type: 'disabled' },
  tools: [tool], tool_choice: { type: 'auto' },
  messages: [{ role: 'user', content }]
})

// Reads the tool input from a reply, or JSON in its text when a model answers in text.
function toolInput(msg, name) {
  const use = (msg.content || []).find((b) => b.type === 'tool_use' && b.name === name)
  if (use) return use.input
  const text = (msg.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
  const m = text.match(/\{[\s\S]*\}/)
  if (m) { try { return JSON.parse(m[0]) } catch {} }
  throw new Error(`No ${name} in the reply. Stop reason ${msg.stop_reason}. ${text.slice(0, 200)}`)
}

async function direct(p) {
  const res = await fetch(`${API}/messages`, { method: 'POST', headers: headers(), body: JSON.stringify(p), signal: AbortSignal.timeout(600000) })
  const body = await res.json()
  // A model that does not take the thinking setting gets the same request without it.
  if (!res.ok && p.thinking && /thinking/i.test(JSON.stringify(body.error || ''))) { const { thinking, ...rest } = p; return direct(rest) }
  if (!res.ok) throw new Error(`Claude API ${res.status} ${JSON.stringify(body.error || body)}`)
  return body
}

// Sends requests as one batch and waits. If the batch is not done in time, it is cancelled and the rest run directly.
async function batch(requests, waitMinutes = 25) {
  const out = {}
  if (!requests.length) return out
  try {
    const res = await fetch(`${API}/messages/batches`, { method: 'POST', headers: headers(), body: JSON.stringify({ requests }) })
    const b = await res.json()
    if (!res.ok) throw new Error(`batch ${res.status} ${JSON.stringify(b.error || b)}`)
    const until = Date.now() + waitMinutes * 60000
    let state = b
    while (state.processing_status !== 'ended' && Date.now() < until) {
      await new Promise((r) => setTimeout(r, 20000))
      state = await (await fetch(`${API}/messages/batches/${b.id}`, { headers: headers() })).json()
    }
    if (state.processing_status === 'ended' && state.results_url) {
      const lines = (await (await fetch(state.results_url, { headers: headers() })).text()).split('\n').filter(Boolean)
      for (const l of lines) { const r = JSON.parse(l); if (r.result?.type === 'succeeded') out[r.custom_id] = r.result.message }
    } else {
      await fetch(`${API}/messages/batches/${b.id}/cancel`, { method: 'POST', headers: headers() }).catch(() => {})
      console.log('Batch was slow, running the rest directly')
    }
  } catch (e) { console.log(`Batch failed, running directly. ${e.message}`) }
  for (const r of requests) {
    if (out[r.custom_id]) continue
    try { out[r.custom_id] = { ...(await direct(r.params)), _direct: true } } catch (e) { console.log(`${r.custom_id} failed. ${e.message}`) }
  }
  return out
}

const addUsage = (total, u, model, batched) => {
  if (!u) return
  const k = model + (batched ? ' batch' : '')
  total[k] = total[k] || { input_tokens: 0, output_tokens: 0 }
  total[k].input_tokens += u.input_tokens || 0
  total[k].output_tokens += u.output_tokens || 0
}

// The whole article for stage 2. Feeds often hold it already, otherwise the page is read.
async function fullText(item, candidates) {
  const from = (item.n || []).map((i) => candidates[i - 1]).filter(Boolean)
  const best = from.map((c) => c.full || '').sort((a, b) => b.length - a.length)[0] || ''
  if (best.length > 3000 && from.some((c) => c.url === item.url)) return best.slice(0, FULL_LIMIT)
  try {
    const html = await get(item.url)
    const part = html.match(/<article[\s\S]*?<\/article>/i) || html.match(/<main[\s\S]*?<\/main>/i)
    const paras = ((part ? part[0] : html).match(/<(p|h2|h3|li)[\s>][\s\S]*?<\/\1>/gi) || []).map(toText).filter((t) => t.length > 30)
    const text = paras.join('\n')
    if (text.length > best.length) return text.slice(0, FULL_LIMIT)
  } catch { /* use what the feed had */ }
  return best.slice(0, FULL_LIMIT)
}

async function askClaude(candidates) {
  const usage = {}
  // Stage 1
  const t = await batch([{ custom_id: 'triage', params: params(TRIAGE_MODEL, triagePrompt(candidates), POOL_TOOL, 16000) }])
  if (!t.triage) throw new Error('Claude did not return the pool.')
  addUsage(usage, t.triage.usage, TRIAGE_MODEL, !t.triage._direct)
  const pool = toolInput(t.triage, 'save_pool')
  const items = pool.items || []

  // Stage 2, the top items by importance and usefulness, plus the best of each topic so every topic has one.
  const rank = (it) => (it.importance | 0) * 2 + (it.practical | 0) + (it.mentions | 0)
  const order = [...items].sort((a, b) => rank(b) - rank(a))
  const chosen = new Set()
  for (const tp of topics) { const best = order.find((it) => it.topics?.[0] === tp.id); if (best && chosen.size < DETAIL_COUNT) chosen.add(best) }
  for (const it of order) { if (chosen.size >= DETAIL_COUNT) break; chosen.add(it) }
  const reqs = []
  for (const [i, it] of [...chosen].entries()) {
    const text = await fullText(it, candidates)
    if (text.length < 800) continue
    it._key = `d${i}`
    reqs.push({ custom_id: it._key, params: params(SUMMARY_MODEL, detailPrompt(it, text), DETAIL_TOOL, 2000) })
  }
  const d = await batch(reqs)
  for (const it of items) {
    const msg = it._key && d[it._key]
    if (msg) {
      addUsage(usage, msg.usage, SUMMARY_MODEL, !msg._direct)
      try { const x = toolInput(msg, 'save_summary'); if (x.points?.length) it.detail = { points: x.points, takeaway: x.takeaway || '' } } catch {}
    }
    delete it._key
  }
  return { brief: pool.brief || '', items, usage }
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
      title: it.title, url: it.url, source: it.source, published: it.published || null,
      topics: it.topics, kind: it.kind === 'try' ? 'try' : 'know', gist: it.gist || '', summary: it.summary.slice(0, 3), why: it.why || {},
      ...(it.detail ? { detail: it.detail } : {}),
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
    for (const it of fresh) candidates.push({ ...it, sourceId: src.id, sourceName: src.name, kind: src.kind, full: it.text, text: it.text.slice(0, TEXT_LIMIT[src.kind] || 900) })
  }
  console.table(status.map(({ id, kept, found, error }) => ({ id, kept, found, error: error ? error.slice(0, 80) : '' })))
  if (DRY) return
  if (!candidates.length) throw new Error('No posts found in any source this week.')

  const { brief, items, usage } = await askClaude(candidates)
  const pool = clean(items)
  const week = weekId(now)
  const out = { week, created: now.toISOString(), model: { triage: TRIAGE_MODEL, summary: SUMMARY_MODEL }, sample: false, brief, sources: status, usage, items: pool }
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
