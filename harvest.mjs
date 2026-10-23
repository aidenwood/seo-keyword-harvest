#!/usr/bin/env node
/**
 * Harvest → cluster → a nightshift-ready work queue.
 *
 *   node harvest.mjs austrails
 *   node harvest.mjs austrails --source ads      # once the Ads token is upgraded
 *   node harvest.mjs --all
 *
 * Writes three files per project into out/:
 *   <project>.keywords.json  every phrase, with its signal
 *   <project>.clusters.json  the collapsed content plan
 *   <project>.queue.jsonl    --items for `nightshift start`
 *
 * Zero dependencies. Node 18+ (needs global fetch).
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { cluster, locationPages, worthWriting } from './lib/cluster.mjs'
import { SOURCES } from './lib/sources.mjs'

const here = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.join(here, 'out')

function parseArgs(argv) {
  const positional = []
  const flags = {}
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2)
      const value = argv[i + 1]
      if (value === undefined || value.startsWith('--')) flags[key] = true
      else {
        flags[key] = value
        i++
      }
    } else positional.push(argv[i])
  }
  return { positional, flags }
}

async function run(name, project, sourceName) {
  const harvest = SOURCES[sourceName]
  if (!harvest) throw new Error(`Unknown --source "${sourceName}". Use: ${Object.keys(SOURCES).join(', ')}`)

  process.stderr.write(`\n${name} — ${project.seeds.length} seeds, geo ${project.gl}\n`)
  const keywords = await harvest(project.seeds, {
    gl: project.gl,
    hl: project.hl,
    onProgress: (done, total) => {
      if (done % 25 === 0 || done === total) process.stderr.write(`\r  ${done}/${total} expansions`)
    },
  })
  process.stderr.write('\n')

  const clusters = cluster(keywords)
  const filters = { exclude: project.exclude ?? [], blockTerms: project.blockTerms ?? [] }
  const keepers = worthWriting(clusters, filters)
  const places = locationPages(clusters, filters)

  mkdirSync(OUT, { recursive: true })
  writeFileSync(path.join(OUT, `${name}.keywords.json`), `${JSON.stringify(keywords.sort((a, b) => b.demand - a.demand), null, 2)}\n`)
  writeFileSync(path.join(OUT, `${name}.clusters.json`), `${JSON.stringify(keepers, null, 2)}\n`)
  // Kept separate on purpose: these are the biggest demand on the board and the
  // one thing an article cannot serve. Burying them in the post queue would
  // mean writing one piece that ranks for none of them.
  writeFileSync(path.join(OUT, `${name}.location-pages.json`), `${JSON.stringify(places, null, 2)}\n`)

  // The queue each item carries everything the writer needs, so the overnight
  // run never has to come back here to find out what a cluster was about.
  const queue = keepers.map((c) => ({
    id: c.id,
    task: c.head,
    project: name,
    site: project.site,
    metric: c.metric,
    score: c.score,
    covers: c.members.slice(0, 12),
  }))
  writeFileSync(path.join(OUT, `${name}.queue.jsonl`), `${queue.map((q) => JSON.stringify(q)).join('\n')}\n`)

  const label = keywords[0]?.metric === 'volume' ? 'monthly searches' : 'relative demand (NOT volume)'
  process.stderr.write(`  ${keywords.length} phrases → ${clusters.length} clusters → ${keepers.length} posts + ${places.length} location-page sets\n`)
  process.stderr.write(`  signal: ${label}\n`)
  for (const c of keepers.slice(0, 8)) {
    process.stderr.write(`    ${String(c.score).padStart(5)}  ${c.head}  (${c.size} phrases)\n`)
  }
  return { name, phrases: keywords.length, clusters: clusters.length, posts: keepers.length, locationPageSets: places.length }
}

const { positional, flags } = parseArgs(process.argv.slice(2))
const projects = JSON.parse(readFileSync(path.join(here, 'config/projects.json'), 'utf8'))
const source = flags.source === true || !flags.source ? 'autocomplete' : String(flags.source)
const names = flags.all ? Object.keys(projects) : positional

if (!names.length) {
  console.error(`Usage: node harvest.mjs <project…|--all> [--source autocomplete|ads]\n\nProjects: ${Object.keys(projects).join(', ')}`)
  process.exit(1)
}

const summary = []
for (const name of names) {
  if (!projects[name]) throw new Error(`No project "${name}" in config/projects.json`)
  summary.push(await run(name, projects[name], source))
}

process.stderr.write('\n')
console.log(JSON.stringify(summary, null, 2))
