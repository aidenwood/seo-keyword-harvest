#!/usr/bin/env node
/**
 * Push every site's live sitemap to IndexNow.
 *
 *   node indexnow.mjs            # all configured sites, changed URLs only
 *   node indexnow.mjs --all      # resubmit everything, ignoring the cache
 *   node indexnow.mjs austrails  # one site
 *
 * Why this exists: IndexNow gets a URL in front of Bing, DuckDuckGo, Ecosia and
 * Yandex within hours instead of waiting on a crawl that, for a new domain with
 * no backlinks, may be weeks away. Two of these sites had a key committed on
 * 2026-09-08 and never submitted once — the key is useless on its own, and
 * "remember to submit after deploying" is not a process.
 *
 * Why one script rather than a copy in each repo: four copies of the same
 * submitter is four versions of it the first time one gets fixed. This reads
 * every site's *live* sitemap, so it works regardless of which repo deployed,
 * and it catches a site whose build forgot to run anything at all.
 *
 * Zero dependencies. Node 18+.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const CACHE = path.join(here, 'out', '.indexnow-cache.json')
const ENDPOINT = 'https://api.indexnow.org/indexnow'
/** IndexNow's documented ceiling per request. */
const MAX_URLS = 10_000

const SITEMAPS = ['/sitemap.xml', '/sitemap-0.xml', '/sitemap-index.xml']

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'aidxn-indexnow/1.0' } })
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res.text()
}

/**
 * Collect every <loc> a site publishes, following a sitemap index one level
 * down. One level is enough for every generator in use here, and recursing
 * blindly on an untrusted document is how a submitter ends up in a loop.
 */
async function collectUrls(origin) {
  for (const candidate of SITEMAPS) {
    let body
    try {
      body = await fetchText(`${origin}${candidate}`)
    } catch {
      continue
    }
    if (!body.includes('<loc>')) continue
    const locs = [...body.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim())
    const isIndex = body.includes('<sitemapindex')
    if (!isIndex) return locs
    const nested = []
    for (const child of locs) {
      try {
        const childBody = await fetchText(child)
        nested.push(...[...childBody.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim()))
      } catch {
        /* a child sitemap that 404s is worth skipping, not worth aborting over */
      }
    }
    if (nested.length) return nested
  }
  throw new Error(`No readable sitemap at ${origin} (tried ${SITEMAPS.join(', ')})`)
}

/** The key file must be live and contain the key, or IndexNow rejects the batch. */
async function verifyKey(origin, key) {
  const text = (await fetchText(`${origin}/${key}.txt`)).trim()
  if (text !== key) throw new Error(`Key file at ${origin}/${key}.txt does not contain the key`)
}

async function submit(host, key, urls) {
  const body = JSON.stringify({
    host,
    key,
    keyLocation: `https://${host}/${key}.txt`,
    urlList: urls.slice(0, MAX_URLS),
  })
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body,
  })
  // 200 accepted, 202 accepted-pending-key-check. Both are success.
  if (res.status !== 200 && res.status !== 202) {
    throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  }
  return res.status
}

const readCache = () => {
  try {
    return JSON.parse(readFileSync(CACHE, 'utf8'))
  } catch {
    return {}
  }
}

const args = process.argv.slice(2)
const force = args.includes('--all')
const names = args.filter((a) => !a.startsWith('--'))

const projects = JSON.parse(readFileSync(path.join(here, 'config/projects.json'), 'utf8'))
const cache = readCache()
let submitted = 0
let failures = 0

for (const [name, project] of Object.entries(projects)) {
  if (names.length && !names.includes(name)) continue
  if (!project.indexNowKey) {
    process.stderr.write(`  ${name.padEnd(13)} skipped — no indexNowKey in config\n`)
    continue
  }
  const origin = project.site.replace(/\/$/, '')
  const host = new URL(origin).host
  try {
    await verifyKey(origin, project.indexNowKey)
    const urls = await collectUrls(origin)
    // Submitting an unchanged list every run trains the endpoint to ignore you.
    const digest = createHash('sha256').update(urls.sort().join('\n')).digest('hex').slice(0, 16)
    if (!force && cache[name] === digest) {
      process.stderr.write(`  ${name.padEnd(13)} unchanged — ${urls.length} URLs, nothing to send\n`)
      continue
    }
    const status = await submit(host, project.indexNowKey, urls)
    cache[name] = digest
    submitted += urls.length
    process.stderr.write(`  ${name.padEnd(13)} HTTP ${status}  ${urls.length} URLs\n`)
  } catch (error) {
    failures++
    process.stderr.write(`  ${name.padEnd(13)} FAILED — ${error.message}\n`)
  }
}

mkdirSync(path.dirname(CACHE), { recursive: true })
writeFileSync(CACHE, `${JSON.stringify(cache, null, 2)}\n`)
process.stderr.write(`\n${submitted} URL(s) submitted, ${failures} site(s) failed\n`)
if (failures) process.exitCode = 1
