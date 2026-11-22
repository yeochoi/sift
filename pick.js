// Picks five reads for one person from a week's pool. Runs in the app, no AI call.
// Three from your topics, one big story of the week, one from outside your topics.
// The same pool and the same settings always give the same five.

const AI_TOPICS = new Set(['ai-interaction', 'trust', 'ai-prototyping', 'ai-quality', 'ai-travel-commerce'])

export function recommendTopics(meta, role, goal, count = 6) {
  const out = []
  for (const t of [...(meta.recommend.goal[goal] || []), ...(meta.recommend.role[role] || [])]) {
    if (!out.includes(t)) out.push(t)
    if (out.length === count) break
  }
  return out
}

function daysOld(item, created) {
  if (!item.published) return null
  return Math.max(0, (new Date(created) - new Date(item.published)) / 86400000)
}

// How well an item fits the person, before slots.
function base(item, user, created) {
  let s = item.importance * 0.8 + item.practical * 0.6 + Math.log2(item.mentions || 1)
  const age = daysOld(item, created)
  if (age !== null && age <= 8) s += 1
  if (user.role && item.roles?.includes(user.role)) s += 1
  if (user.years === 'under3') s += item.practical * 0.3
  if (user.years === 'over8') s += item.importance * 0.2
  if (user.goal === 'ai' && item.topics.some((t) => AI_TOPICS.has(t))) s += 0.5
  const words = (user.keywords || []).map((k) => k.trim().toLowerCase()).filter(Boolean)
  const text = `${item.title} ${item.summary.join(' ')}`.toLowerCase()
  if (words.some((w) => text.includes(w))) s += 2
  return s
}

// Which of the person's topics an item matches best, and how strongly.
function topicMatch(item, mine) {
  for (let i = 0; i < item.topics.length; i++) if (mine.includes(item.topics[i])) return { topic: item.topics[i], strength: i === 0 ? 3 : 2 }
  return null
}

const byScore = (a, b) => b.score - a.score || (a.item.id < b.item.id ? -1 : 1)

export function pickFive(pool, user, meta) {
  const created = pool.created
  const mine = user.topics || []
  const name = (id) => meta.topics.find((t) => t.id === id)?.name || id
  const scored = pool.items.map((item) => ({ item, b: base(item, user, created), m: topicMatch(item, mine) }))
  const taken = new Set()
  const picks = []
  const take = (entry, slot, label, why) => {
    taken.add(entry.item.id)
    picks.push({ id: entry.item.id, slot, label, why: why || entry.item.why.general || '' })
  }

  // 1. The big story of the week, whatever the topic. Chosen first so it is never used up as one of yours.
  const big = scored.filter((e) => !taken.has(e.item.id))
    .map((e) => ({ ...e, score: e.item.importance * 2 + (e.item.mentions || 1) * 1.5 + e.item.practical * 0.3 + (e.item.topics.includes('industry') ? 1 : 0) }))
    .sort(byScore)[0]
  if (big) take(big, 'big', 'Big this week', big.item.why.industry || big.item.why.general)

  // 2. Three from your topics, each from a different topic when possible.
  const mineList = scored.filter((e) => e.m && !taken.has(e.item.id)).map((e) => ({ ...e, score: e.b + e.m.strength * 2 })).sort(byScore)
  const usedTopics = new Set()
  const mineCount = () => picks.filter((p) => p.slot === 'mine').length
  for (const e of mineList) {
    if (mineCount() === 3) break
    if (usedTopics.has(e.m.topic)) continue
    usedTopics.add(e.m.topic)
    take(e, 'mine', name(e.m.topic), e.item.why[e.m.topic])
  }
  for (const e of mineList) {
    if (mineCount() === 3) break
    if (!taken.has(e.item.id)) take(e, 'mine', name(e.m.topic), e.item.why[e.m.topic])
  }

  // 3. One from outside your topics, so the week does not narrow over time.
  const bigTopic = big?.item.topics[0]
  const outside = scored.filter((e) => !taken.has(e.item.id) && !e.m)
    .map((e) => ({ ...e, score: e.b + (e.item.topics[0] === bigTopic ? -2 : 0) }))
    .sort(byScore)[0]
  if (outside) take(outside, 'outside', 'Outside your topics', outside.item.why.general)

  // Fill up to five from what is left when the pool is small.
  const rest = scored.filter((e) => !taken.has(e.item.id)).map((e) => ({ ...e, score: e.b })).sort(byScore)
  for (const e of rest) {
    if (picks.length >= 5) break
    take(e, e.m ? 'mine' : 'outside', e.m ? name(e.m.topic) : 'Outside your topics', e.m ? e.item.why[e.m.topic] : e.item.why.general)
  }
  const order = { mine: 0, big: 1, outside: 2 }
  return picks.slice(0, 5).sort((a, b) => order[a.slot] - order[b.slot])
}
