/**
 * Where the keywords come from.
 *
 * Every source returns the same shape and, critically, declares what kind of
 * number it is giving you:
 *
 *   volume   — absolute monthly searches. Only Keyword Planner has this.
 *   demand   — a relative ranking with no absolute scale.
 *
 * That distinction is the whole reason this file exists. Autocomplete ordering
 * is real signal — Google sorts suggestions by how often people actually type
 * them — but it is NOT a volume, and a pipeline that quietly treats a rank-based
 * score as "searches per month" produces a content plan built on a number that
 * was invented three functions ago.
 */

const SUGGEST = 'https://suggestqueries.google.com/complete/search'

/** a–z, plus the question and comparison words that surface intent, not just nouns. */
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz'.split('')
const QUESTIONS = ['how', 'what', 'why', 'when', 'where', 'which', 'is', 'can', 'do', 'does', 'should', 'are']
const MODIFIERS = ['best', 'free', 'near me', 'vs', 'for', 'with', 'without', 'cheap', 'app', 'guide']

async function suggest(query, { gl, hl }) {
  const url = `${SUGGEST}?client=firefox&hl=${encodeURIComponent(hl)}&gl=${encodeURIComponent(gl)}&q=${encodeURIComponent(query)}`
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)' } })
  if (!res.ok) throw new Error(`suggest ${res.status} for "${query}"`)
  const body = await res.json()
  return Array.isArray(body?.[1]) ? body[1] : []
}

const sleep = (msValue) => new Promise((resolve) => setTimeout(resolve, msValue))

/**
 * Expand a seed into the queries people actually type.
 *
 * Each suffix is a separate request, so a seed costs ~50 requests. They are
 * paced rather than fired in parallel: this is an undocumented endpoint and
 * hammering it gets you rate-limited halfway through a run, which produces a
 * half-harvest that looks like a complete one.
 */
export async function autocompleteHarvest(seeds, { gl = 'au', hl = 'en', paceMs = 120, onProgress } = {}) {
  const hits = new Map()
  const record = (phrase, rank, seed) => {
    const key = phrase.toLowerCase().trim()
    if (!key) return
    const prev = hits.get(key) ?? { phrase: key, appearances: 0, bestRank: 99, seeds: new Set() }
    prev.appearances += 1
    prev.bestRank = Math.min(prev.bestRank, rank)
    prev.seeds.add(seed)
    hits.set(key, prev)
  }

  const suffixes = ['', ...ALPHABET.map((c) => ` ${c}`), ...MODIFIERS.map((m) => ` ${m}`)]
  let done = 0
  const total = seeds.length * (suffixes.length + QUESTIONS.length)

  for (const seed of seeds) {
    for (const suffix of suffixes) {
      try {
        const results = await suggest(`${seed}${suffix}`, { gl, hl })
        results.forEach((phrase, index) => record(phrase, index, seed))
      } catch {
        // One failed expansion is not worth losing the harvest over; the phrase
        // will almost certainly surface from a neighbouring suffix anyway.
      }
      done++
      onProgress?.(done, total)
      await sleep(paceMs)
    }
    // Question-led queries are where the long-tail, answerable posts live, and
    // they rarely appear from alphabet expansion alone.
    for (const question of QUESTIONS) {
      try {
        const results = await suggest(`${question} ${seed}`, { gl, hl })
        results.forEach((phrase, index) => record(phrase, index, seed))
      } catch {
        /* same */
      }
      done++
      onProgress?.(done, total)
      await sleep(paceMs)
    }
  }

  return [...hits.values()].map((h) => ({
    phrase: h.phrase,
    // Honest naming. `demand` is ordinal: higher means it surfaced more often
    // and higher up across independent expansions. It is not searches/month and
    // must never be rendered as one.
    metric: 'demand',
    demand: Math.round(h.appearances * 10 + (10 - Math.min(h.bestRank, 10)) * 4),
    appearances: h.appearances,
    bestRank: h.bestRank,
    seeds: [...h.seeds],
  }))
}

/**
 * Google Ads Keyword Planner — real absolute volumes.
 *
 * Deliberately unimplemented rather than faked. As of 2026-10-23 the developer
 * token on this machine is at Explorer access, and generateKeywordIdeas answers:
 *
 *   authorization_error: This method is not allowed for use with explorer
 *   access. Please apply for basic or standard access.
 *
 * When the token is upgraded, this becomes a real adapter returning
 * `{ metric: 'volume', volume: <avg_monthly_searches> }` and everything
 * downstream keeps working, because the pipeline already branches on `metric`.
 */
export async function keywordPlannerHarvest() {
  throw new Error(
    [
      'Keyword Planner needs Basic access on the Google Ads developer token.',
      'The current token is Explorer level, which blocks generateKeywordIdeas.',
      'Until it is upgraded, run with --source autocomplete and treat the',
      'numbers as relative demand, never as monthly search volume.',
    ].join('\n')
  )
}

export const SOURCES = {
  autocomplete: autocompleteHarvest,
  ads: keywordPlannerHarvest,
}
