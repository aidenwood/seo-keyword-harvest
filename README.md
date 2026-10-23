# seo-keyword-harvest

Turn a handful of seed terms into a **clustered content plan**, using real search
demand — and never inventing a number it can't back.

Zero dependencies. Node 18+.

```bash
node harvest.mjs austrails
node harvest.mjs --all
```

## The honest-metrics rule

Every source declares what kind of number it returns:

| metric | meaning | source |
|---|---|---|
| `volume` | absolute monthly searches | Google Ads Keyword Planner |
| `demand` | relative ranking, **no absolute scale** | Google autocomplete |

Autocomplete ordering is real signal — Google sorts suggestions by how often
people actually type them — but it is *not* a volume. A pipeline that quietly
renders a rank-derived score as "searches per month" is reporting a number that
was invented three functions ago. This tool refuses to do that, and prints which
metric it used on every run.

The Keyword Planner adapter is deliberately **unimplemented rather than faked**.
It throws with the real reason:

```
Keyword Planner needs Basic access on the Google Ads developer token.
The current token is Explorer level, which blocks generateKeywordIdeas.
```

When the token is upgraded, that adapter returns `{metric:'volume'}` and
everything downstream keeps working — the pipeline already branches on `metric`.

## What it does

1. **Expand.** Each seed is queried against autocomplete with a–z, question
   words (`how`, `what`, `why`, `can`…) and intent modifiers (`best`, `free`,
   `vs`, `near me`…). ~50 requests per seed, paced — hammering an undocumented
   endpoint gets you rate-limited halfway, which yields a half-harvest that
   looks complete.
2. **Cluster.** Phrases are collapsed by shared content words against a **fixed**
   head, never a shrinking intersection. Dividing by the shorter side lets a
   one-token cluster match everything — that bug put 332 phrases in a single
   "cluster" on the first run.
3. **Filter.** The part that stops this becoming a content farm:
   - singletons and low-score clusters are dropped
   - `blockTerms` kills foreign geographies and off-intent phrases (an
     Australian hiking site harvesting *"waterfall hike zion"* has found real
     demand that belongs to somebody else's site)
   - **`near me` clusters are routed to location pages, not posts.** One article
     cannot serve 191 "near me" phrases and will rank for none of them. They are
     a programmatic-SEO job and are written to a separate file so the volume
     stays visible.

## Output

```
out/<project>.keywords.json       every phrase with its signal
out/<project>.clusters.json       the content plan
out/<project>.location-pages.json the programmatic job, kept separate
out/<project>.queue.jsonl         --items for `nightshift start`
```

Pairs with [nightshift](https://github.com/aidenwood/nightshift):

```bash
node harvest.mjs austrails
nightshift start blog-night --until 07:00 \
  --items out/austrails.queue.jsonl \
  --freeze house-style.md
```

## IndexNow — same-day indexing on Bing, DuckDuckGo, Ecosia and Yandex

```bash
node indexnow.mjs            # all sites, changed URLs only
node indexnow.mjs --all      # resubmit everything
node indexnow.mjs austrails  # one site
```

Google ignores IndexNow, but Bing's index feeds DuckDuckGo and Ecosia, and
submission lands in hours rather than waiting on a crawl that — for a new domain
with no backlinks — can be weeks away.

It reads each site's **live** sitemap rather than a local build, so it works no
matter which repo deployed last and it catches a site whose build skipped a
step. The key file is verified before anything is sent, because IndexNow
silently rejects a batch whose key does not resolve.

Changed URLs only, by default: a digest of each site's URL list is cached, and
resubmitting an identical list every run is how you train the endpoint to ignore
you. `--all` overrides it.

**One script, not one per repo.** Four copies of the same submitter become four
versions of it the moment one gets fixed. Two of these sites had a key committed
in September and had never submitted once — the key is useless on its own, and
"remember to submit after deploying" is not a process.

## Config

`config/projects.json` — seeds, geo/language, and the exclusion lists:

```json
{
  "austrails": {
    "site": "https://austrails.aidxn.com",
    "gl": "au", "hl": "en",
    "seeds": ["hiking trails australia", "offline hiking maps"],
    "exclude": ["alltrails", "komoot"],
    "blockTerms": ["zion", "appalachian", "lake district"]
  }
}
```

`exclude` is for competitors you can't outrank and shouldn't chase.
`blockTerms` is for demand that is real, but real for somebody else.

## License

MIT
