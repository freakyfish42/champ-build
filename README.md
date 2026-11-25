# Champion builds: build.lømsland.no

A lean League of Legends build site for EUW. The front page is a sortable tier list of every champion by role. Click a champion to see its summoner spells (top 2 pairs), runes (top 2 pages), build (start, core, top 2 boots, other popular items), skill order (all 18 levels) and counters.

All stats are **EUW, Emerald+ ranked solo/duo, current patch**, from OP.GG.

## How it works

- `worker.js` is a Cloudflare Worker (`champ-build`). It serves the page and three JSON endpoints:
  - `/api/tierlist`: every champion per role (tier, win, pick and ban rate, games, rank change)
  - `/api/build?c=<champion>&p=<top|jungle|mid|adc|support>`: one champion's build. With no `p`, it uses the champion's most-played role.
  - `/api/champs`: the champion list from Riot Data Dragon
- `page.html` is the whole front end (no build step). It's bundled into the Worker as a text module.
- **Data:** the JSON op.gg's own EUW pages load (`lol-api-champion.op.gg/api/EUW/...`). If that fails, the Worker switches to OP.GG's official MCP feed (all regions), and the page says "all regions" instead of "EUW".
- **Icons and names:** Riot Data Dragon.
- **Builds kept ready:** a cron (`*/10 * * * *`) runs `warm()`, which refreshes the 10 oldest champion/role builds from op.gg and stores them in KV (binding `DATA`, namespace `champ-build-data`): one `chunk:*` value per run, an `idx` pointing each `Champion:role` at its chunk, and the tier list as `tl`. `/api/build` serves a stored build if it is under 12 h old, so a click doesn't wait on op.gg. A full cycle of every champion and role takes about 4–5 hours. Under 500 KV writes a day, within the free plan.
- **Caching:** EUW results are cached for 6 h (builds) and 3 h (tier list). Backup results are cached for only 10 min, so EUW comes back quickly after a blip.
- **Domain:** the Cloudflare Pages project `lomsland-build` forwards every request to the Worker through a service binding, with `build.xn--lmsland-q1a.no` as its custom domain. DNS is a CNAME at Webnode: `build.xn--lmsland-q1a.no → lomsland-build.pages.dev`.

## Notes on the data

- The support item (World Atlas) isn't in op.gg's start stats, so the Worker adds it in front of supports' starting potions and marks it as added.
- op.gg's skill order stops at level 15. The page fills levels 16–18 the standard way and shows those cells faded.
- "Other popular items" are sorted by how often they're bought, not by build order. op.gg's EUW data has no 4th/5th/6th slots.
- Runes: op.gg's two most played rune pages. Pick rate, games and win rate are for the whole page, and the runes shown are that page's most common setup. Names and icons come from Data Dragon `runesReforged.json`; stat shards are named in the Worker because Data Dragon doesn't list them.
- Counters use every EUW matchup with at least 40 games.

## Test

```sh
node test.mjs   # prints "ok: N checks passed"
```

The tests load `worker.js` with `page.html` inlined and mock op.gg and Data Dragon. The fixtures mirror real op.gg answers.

## Deploy

Upload both files to the Worker. The Pages project picks up the change by itself.

```
PUT /accounts/{account_id}/workers/scripts/champ-build   (multipart)
  metadata  = {"main_module":"worker.js","compatibility_date":"2025-01-01",
               "bindings":[{"type":"kv_namespace","name":"DATA","namespace_id":"8a21fd198bf540f4ae94cf1f9d2b488e"}]}
  worker.js = application/javascript+module
  page.html = text/plain
```

Always include the KV binding in the metadata, or the stored builds stop being used. The cron schedule is set once with `PUT /accounts/{account_id}/workers/scripts/champ-build/schedules` and body `[{"cron":"*/10 * * * *"}]`.

## Setup reports (`POST /api/report`)
The Champ Select Companion's "Check setup" sends its report here, only when the player clicks Yes. The Worker
forwards it as a file to a private Discord channel through the secret **DISCORD_WEBHOOK** (Workers → champ-build →
Settings → Variables and Secrets). No mentions can ping; 5 reports per address and 40 in total per hour (KV
counters, 1 h). Nothing else is stored. Without the secret it answers 503.
