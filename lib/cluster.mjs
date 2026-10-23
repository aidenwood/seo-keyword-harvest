/**
 * Turning a flat list of phrases into a content plan.
 *
 * A harvest of 900 phrases is not 900 posts. Most of them are the same question
 * asked five ways, and publishing one post per phrase is how you end up with a
 * thin-content farm that gets suppressed wholesale. The job here is to collapse
 * them into clusters where one genuinely useful article can serve the whole
 * group, and then to throw away the clusters that aren't worth writing.
 */

const STOP = new Set([
  'a', 'an', 'the', 'to', 'for', 'of', 'in', 'on', 'at', 'is', 'are', 'and', 'or',
  'my', 'your', 'you', 'i', 'it', 'with', 'without', 'near', 'me', 'do', 'does',
  'can', 'how', 'what', 'why', 'when', 'where', 'which', 'should', 'best', 'vs',
])

const tokens = (phrase) =>
  phrase
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP.has(word))

/**
 * How much of the HEAD's meaning a candidate shares.
 *
 * Measured against the head's token count, never against whichever side happens
 * to be shorter. Dividing by the shorter side means a one-token cluster matches
 * literally everything (1/1 = 1.0), which is how a first attempt at this put 332
 * phrases in a single "cluster" and called it a content plan.
 */
function overlap(candidate, headTokens) {
  const set = new Set(candidate)
  const shared = headTokens.filter((word) => set.has(word))
  return { ratio: shared.length / headTokens.length, shared: shared.length }
}

/**
 * Greedy clustering by shared content words. Deliberately simple: phrases are
 * three to six words long, so anything fancier adds dependencies and
 * nondeterminism for an outcome a human still has to sanity-check.
 *
 * Seeded by demand order, so the highest-signal phrase in a cluster becomes its
 * head — which is also the phrase the post's title should answer.
 */
export function cluster(keywords, { threshold = 0.6, minShared = 2 } = {}) {
  const sorted = [...keywords].sort((a, b) => (b.demand ?? b.volume ?? 0) - (a.demand ?? a.volume ?? 0))
  const clusters = []

  for (const keyword of sorted) {
    const words = tokens(keyword.phrase)
    if (!words.length) continue

    // The head's tokens are FIXED for the life of the cluster. A cluster that
    // renegotiates its own definition as members join is the same mistake as a
    // batch job that reloads its config mid-run: it drifts, and nothing errors.
    let best = null
    for (const candidate of clusters) {
      const { ratio, shared } = overlap(words, candidate.tokens)
      // A single-token head can only cluster on an exact token match, so
      // "hiking" doesn't become a bucket that swallows the whole harvest.
      const need = candidate.tokens.length === 1 ? 1 : minShared
      if (ratio >= threshold && shared >= need && (!best || ratio > best.ratio)) best = { candidate, ratio }
    }

    if (best) best.candidate.members.push(keyword)
    else clusters.push({ head: keyword, tokens: words, members: [keyword] })
  }

  return clusters
    .map((c) => ({
      id: c.head.phrase.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60),
      head: c.head.phrase,
      metric: c.head.metric ?? 'demand',
      score: c.members.reduce((sum, m) => sum + (m.demand ?? m.volume ?? 0), 0),
      size: c.members.length,
      members: c.members.map((m) => m.phrase),
    }))
    .sort((a, b) => b.score - a.score)
}

/**
 * The filter that stops this becoming a content farm.
 *
 * A cluster earns a post only if it is a real question with real pull. Singleton
 * clusters are usually noise — one autocomplete stray — and navigational or
 * brand-chasing phrases are things we cannot and should not rank for.
 */
/**
 * Does this cluster belong to the project's subject at all?
 *
 * Seeds are ambiguous in ways that only show up downstream. "apple silicon"
 * expands to *"can you use frozen apples for cider"*. "render farm" reaches
 * *"do server farm recycle water"*. "transcription" collects
 * *"transcription vs reverse transcription"*, which is molecular biology.
 * Every one of those shares a token with its seed, so token overlap cannot
 * catch them — the phrase is genuinely about something else.
 *
 * `requireAny` is the project's narrow domain vocabulary. A cluster has to
 * contain at least one of those terms to count as on-subject. Narrow is the
 * operative word: "macbook" as a required term keeps *"what generation is
 * macbook air 2020"*, while "apple silicon" and "ai video" do not.
 */
function onSubject(phrase, requireAny) {
  if (!requireAny.length) return true
  return requireAny.some((term) => phrase.includes(term))
}

export function worthWriting(clusters, { minSize = 2, minScore = 30, exclude = [], blockTerms = [], requireAny = [] } = {}) {
  const blocked = [...exclude, ...blockTerms].map((term) => term.toLowerCase())
  const required = requireAny.map((term) => term.toLowerCase())
  return clusters.filter((c) => {
    if (c.size < minSize) return false
    if (c.score < minScore) return false
    if (!onSubject(c.head, required)) return false
    // A blocked term anywhere in the cluster's own phrases kills it, not just in
    // the head. An Australian hiking site harvesting "waterfall hike zion" or
    // "walks with kids hampshire" has found real demand that is real for
    // somebody else — writing it is how a useful site becomes a content farm.
    if (blocked.some((term) => c.head.includes(term))) return false
    // "near me" is a location-page job: one page per place, driven by data.
    // One blog post serving 200 "near me" phrases helps nobody and ranks for
    // none of them. These are split out by `locationPages` below instead.
    if (isLocationIntent(c.head)) return false
    return true
  })
}

const LOCATION_INTENT = /\bnear me\b|\bnearby\b|\bclose to me\b|\baround me\b/

export function isLocationIntent(phrase) {
  return LOCATION_INTENT.test(phrase)
}

/**
 * The clusters that want a page per place rather than an article. Returned
 * separately so the volume is visible — it is usually the largest demand on the
 * board and it is the one thing a blog post cannot capture.
 */
export function locationPages(clusters, { exclude = [], blockTerms = [] } = {}) {
  const blocked = [...exclude, ...blockTerms].map((term) => term.toLowerCase())
  return clusters
    .filter((c) => isLocationIntent(c.head))
    .filter((c) => !blocked.some((term) => c.head.includes(term)))
    .map((c) => ({ ...c, kind: 'location-pages', note: 'Programmatic: one page per place, from trail data. Not a blog post.' }))
}
