import PAGE from './page.html';
// Champion Build — Cloudflare Worker for build.lømsland.no
// Tier list + champion builds for EUW Emerald+ ranked solo/duo, from the data op.gg's own EUW pages load.
// OP.GG's official MCP feed (all regions) is the backup when that source fails.

const OPGG = 'https://mcp-api.op.gg/mcp';
const TIER = 'emerald_plus';
const TTL = 6 * 3600; // seconds; builds change slowly within a patch
const POSITIONS = ['top', 'jungle', 'mid', 'adc', 'support'];

let KV = null; // Cloudflare KV (binding DATA): builds kept ready by the background refresh
const mem = new Map();
const memGet = k => { const h = mem.get(k); return h && h.exp > Date.now() ? h.v : undefined; };
const memSet = (k, v, sec) => { if (mem.size > 2000) mem.clear(); mem.set(k, { v, exp: Date.now() + sec * 1000 }); };

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

// ---- OP.GG answer format: "class X: a,b" header lines, then X(1,"two",[...],Y(...)) constructor calls ----
export function parseOpgg(text) {
  const h = {};
  const lines = String(text).split('\n');
  for (const line of lines) {
    const m = line.match(/^\s*class\s+([A-Z]\w*)\s*:\s*([\w ,]*)$/);
    if (m) h[m[1]] = m[2].split(',').map(x => x.trim()).filter(Boolean);
  }
  const s = lines.filter(l => !/^\s*class\s/.test(l)).join('\n').trim();
  let i = 0;
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const fail = () => { throw new Error('Unexpected OP.GG format at ' + i); };
  function list(close) {
    const out = []; ws();
    if (s[i] === close) { i++; return out; }
    for (;;) {
      out.push(val()); ws();
      if (s[i] === ',') { i++; continue; }
      if (s[i] === close) { i++; return out; }
      fail();
    }
  }
  function val() {
    ws();
    const c = s[i];
    if (c === '"') {
      i++; let str = '';
      while (i < s.length && s[i] !== '"') { if (s[i] === '\\') i++; str += s[i++]; }
      i++; return str;
    }
    if (c === '[') { i++; return list(']'); }
    const num = /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/i.exec(s.slice(i, i + 40));
    if (num) { i += num[0].length; return +num[0]; }
    const id = /^[A-Za-z_]\w*/.exec(s.slice(i, i + 80));
    if (!id) fail();
    i += id[0].length; ws();
    if (s[i] !== '(') { const L = { True: true, true: true, False: false, false: false, None: null, null: null }; return id[0] in L ? L[id[0]] : id[0]; }
    i++;
    const args = list(')');
    const fields = h[id[0]];
    if (!fields) return { _type: id[0], _args: args };
    const o = {};
    fields.forEach((f, k) => { if (k < args.length) o[f] = args[k]; });
    return o;
  }
  return val();
}

// "Nunu & Willump" → NUNU_WILLUMP, "Kai'Sa" → KAISA, "Dr. Mundo" → DR_MUNDO
export const ogName = n => String(n).normalize('NFD').replace(/[^A-Za-z0-9 ]/g, '').trim().replace(/\s+/g, '_').toUpperCase();
const norm = s => String(s).toLowerCase().normalize('NFD').replace(/[^a-z0-9]/g, '');

async function opgg(tool, args) {
  const post = async body => {
    const r = await fetch(OPGG, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    let t = await r.text(); const m = t.match(/^data: (.*)$/m); if (m) t = m[1];
    return JSON.parse(t);
  };
  await post({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'ChampBuild', version: '1.0' } } });
  const res = await post({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: { ...args, client_app: 'ChampBuild/1.0' } } });
  if (res.error) throw new Error(String(res.error.message || 'OP.GG error').slice(0, 200));
  const text = res.result && res.result.content && res.result.content.map(c => c.text || '').join('\n');
  if (!text || res.result.isError) throw new Error((text || 'OP.GG returned no data').slice(0, 200));
  return parseOpgg(text);
}

async function ddragon() {
  let v = memGet('dd'); if (v) return v;
  const versions = await (await fetch('https://ddragon.leagueoflegends.com/api/versions.json')).json();
  const data = await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${versions[0]}/data/en_US/champion.json`)).json();
  const list = Object.values(data.data).map(c => ({ id: c.id, name: c.name, key: c.key })).sort((a, b) => a.name.localeCompare(b.name));
  v = { version: versions[0], list };
  memSet('dd', v, TTL);
  return v;
}

// item names by id (OP.GG's EUW data only sends ids)
async function itemNames(version) {
  const k = 'it:' + version; let v = memGet(k); if (v) return v;
  v = {};
  try { const d = await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/item.json`)).json(); for (const [id, x] of Object.entries(d.data)) v[id] = x.name; } catch {}
  memSet(k, v, TTL);
  return v;
}

// rune trees and runes by id, from Data Dragon (icons are paths under /cdn/img/)
async function runeData(version) {
  const k = 'ru:' + version; let v = memGet(k); if (v) return v;
  v = {};
  try {
    const d = await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/runesReforged.json`)).json();
    for (const t of d) { v[t.id] = { name: t.name, icon: t.icon }; for (const s of t.slots || []) for (const r of s.runes || []) v[r.id] = { name: r.name, icon: r.icon }; }
  } catch {}
  memSet(k, v, TTL);
  return v;
}
const SHARDS = { 5001: 'Health Scaling', 5005: 'Attack Speed', 5007: 'Ability Haste', 5008: 'Adaptive Force', 5010: 'Move Speed', 5011: 'Health', 5013: 'Tenacity and Slow Resist' };

// summoner spell names and icons by numeric id (4 = Flash, 14 = Ignite, ...)
async function summs(version) {
  const k = 'su:' + version; let v = memGet(k); if (v) return v;
  v = {};
  try { const d = await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/summoner.json`)).json(); for (const s of Object.values(d.data)) v[s.key] = { name: s.name, img: s.image.full }; } catch {}
  memSet(k, v, TTL);
  return v;
}

async function spells(version, id) {
  const k = 'sp:' + version + ':' + id; let v = memGet(k); if (v) return v;
  try {
    const d = await (await fetch(`https://ddragon.leagueoflegends.com/cdn/${version}/data/en_US/champion/${id}.json`)).json();
    const c = d.data[id];
    v = c.spells.map((s, i) => ({ key: 'QWER'[i], name: s.name, img: s.image.full }));
    v.push({ key: 'P', name: c.passive.name, img: c.passive.image.full, passive: true });
  } catch { v = []; }
  memSet(k, v, TTL);
  return v;
}

const ITEM_F = '{ids[],ids_names[],pick_rate,play,win}';
const BUILD_FIELDS = [
  'data.summary.positions[].name', 'data.summary.positions[].stats.{play,role_rate,win_rate}',
  `data.starter_items.${ITEM_F}`, `data.boots.${ITEM_F}`, `data.core_items.${ITEM_F}`,
  `data.fourth_items[].${ITEM_F}`, `data.fifth_items[].${ITEM_F}`, `data.sixth_items[].${ITEM_F}`,
  'data.skills.{order[],pick_rate,play,win}', 'data.skill_masteries.{ids[],pick_rate,play,win}',
  'data.weak_counters[].{champion_name,counter_win_rate,my_win_rate,play}',
  'data.strong_counters[].{champion_name,counter_win_rate,my_win_rate,play}',
  'data.summoner_spells.{ids[],ids_names[],pick_rate,play,win}',
  'data.runes.{pick_rate,play,primary_page_id,primary_rune_ids[],secondary_page_id,secondary_rune_ids[],stat_mod_ids[],win}',
];
// OP.GG gives win rates as fractions; accept percentages too, in case that changes
const rate = x => (typeof x === 'number' && isFinite(x) ? (x > 1 ? x / 100 : x) : null);
const counters = (a, worstFirst) => (Array.isArray(a) ? a : [])
  .map(c => c && c.champion_name ? { name: c.champion_name, wr: rate(c.my_win_rate), play: c.play || 0 } : null)
  .filter(c => c && c.wr != null && c.play > 0)
  .sort((x, y) => worstFirst ? x.wr - y.wr : y.wr - x.wr)
  .slice(0, 6);

// ---- tier list (front page): OP.GG lane meta, every champion per role ----
const TL_POS = ['top', 'jungle', 'mid', 'adc', 'support'];
const TL_F = '{ban_rate,champion,pick_rate,play,rank,rank_prev,role_rate,tier,win,win_rate}';
export function shapeTier(raw, list) {
  const pos = (raw && raw.data && raw.data.positions) || {};
  const byN = {}; for (const c of list || []) { byN[norm(c.name)] = c; byN[norm(c.id)] = c; }
  const roles = {};
  for (const p of TL_POS) {
    roles[p] = (Array.isArray(pos[p]) ? pos[p] : []).map(e => {
      if (!e || !e.champion) return null;
      const c = byN[norm(e.champion)], rk = +e.rank, prev = +e.rank_prev;
      return { name: c ? c.name : String(e.champion), id: c ? c.id : '', tier: +e.tier || 0, wr: +e.play > 0 && +e.win > 0 ? +e.win / +e.play : rate(e.win_rate), pick: rate(e.pick_rate), ban: rate(e.ban_rate), play: +e.play || 0, trend: prev > 0 && rk > 0 ? prev - rk : null };
    }).filter(e => e && e.wr != null && e.play > 0);
  }
  return roles;
}
// ---- EUW data: the same source op.gg's own pages load, with the region in the address ----
const WEB = 'https://lol-api-champion.op.gg/api/EUW/champions/ranked';
const WEB_POS = { TOP: 'top', JUNGLE: 'jungle', MID: 'mid', ADC: 'adc', SUPPORT: 'support' };
const POS_WEB = { top: 'TOP', jungle: 'JUNGLE', mid: 'MID', adc: 'ADC', support: 'SUPPORT' };
const UA = { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36', accept: 'application/json' };
async function web(path) {
  const r = await fetch(WEB + path, { headers: UA, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error('op.gg EUW answered ' + r.status);
  const j = await r.json();
  if (!j || !j.data) throw new Error('op.gg EUW sent no data');
  return j;
}
const arr = a => (Array.isArray(a) ? a : []);
export const opggTime = m => { if (!m) return null; const s = m.analyzed_at || (m.cached_at ? String(m.cached_at).replace(' ', 'T') + '+09:00' : ''); const t = Date.parse(s); return isFinite(t) ? t : null; };
const keyMap = list => { const m = {}; for (const c of list || []) m[String(c.key)] = c; return m; };
export function shapeTierWeb(j, list) {
  const byKey = keyMap(list), roles = { top: [], jungle: [], mid: [], adc: [], support: [] };
  for (const ch of arr(j && j.data)) {
    const c = byKey[String(ch.id)]; if (!c) continue;
    for (const p of arr(ch.positions)) {
      const k = WEB_POS[p.name], st = p.stats || {}, td = st.tier_data || {};
      if (!k || !(st.play > 0)) continue;
      roles[k].push({ name: c.name, id: c.id, tier: +td.tier || +st.tier || 0, wr: rate(st.win_rate), pick: rate(st.pick_rate), ban: rate(st.ban_rate), play: +st.play, trend: td.rank_prev > 0 && td.rank > 0 ? td.rank_prev - td.rank : null });
    }
  }
  return roles;
}
const wItems = (x, N) => x && arr(x.ids).length
  ? { items: x.ids.map(id => ({ id, name: (N && N[id]) || '' })), wr: x.play ? x.win / x.play : null, pick: rate(x.pick_rate), play: x.play || 0 }
  : null;
export function shapeWeb(j, list, N) {
  const d = (j && j.data) || {}, byKey = keyMap(list);
  const roles = arr(d.summary && d.summary.positions).map(p => ({ p: WEB_POS[p.name], rate: p.stats ? p.stats.role_rate : null, wr: p.stats ? p.stats.win_rate : null, play: p.stats ? p.stats.play : 0 }))
    .filter(r => r.p).sort((a, b) => (b.rate || 0) - (a.rate || 0));
  // skill order: the top build of the top max order (what op.gg's page shows)
  const sm = arr(d.skill_masteries)[0], sk = (sm && arr(sm.builds)[0]) || arr(d.skills)[0];
  // counters: win = this champion's wins against that opponent; skip tiny samples
  const cs = arr(d.counters).map(c => { const ch = byKey[String(c.champion_id)]; return ch && c.play >= 40 ? { id: ch.id, name: ch.name, wr: c.win / c.play, play: c.play } : null; }).filter(Boolean);
  return {
    roles,
    starter: wItems(arr(d.starter_items)[0], N), boots: wItems(arr(d.boots)[0], N), boots2: wItems(arr(d.boots)[1], N), core: wItems(arr(d.core_items)[0], N),
    fourth: [], fifth: [], sixth: [],
    // other popular items: op.gg's most-bought later items, minus anything already in the core build or the boots
    late: (() => { const skip = new Set([...arr((arr(d.core_items)[0] || {}).ids), ...arr(d.boots).flatMap(x => arr(x.ids))].map(Number)); return arr(d.last_items).filter(x => arr(x.ids).length && !x.ids.some(i => skip.has(+i))).slice(0, 6).map(x => wItems(x, N)).filter(Boolean); })(),
    skills: sk && arr(sk.order).length ? { order: sk.order, wr: sk.play ? sk.win / sk.play : null, pick: rate(sk.pick_rate), play: sk.play || 0 } : null,
    max: sm && arr(sm.ids).length ? { order: sm.ids, wr: sm.play ? sm.win / sm.play : null, pick: rate(sm.pick_rate) } : null,
    counters: { weak: [...cs].sort((a, b) => a.wr - b.wr).slice(0, 6), strong: [...cs].sort((a, b) => b.wr - a.wr).slice(0, 6) },
    // every matchup with 40+ games (this champion's win rate against each), for the companion app's lane matchup
    vs: cs.map(c => ({ id: c.id, name: c.name, wr: Math.round(c.wr * 10000) / 10000, play: c.play })),
    runes: arr(d.rune_pages).slice(0, 2).map(p => { const b = arr(p.builds)[0] || p; return { primary: +p.primary_page_id, secondary: +p.secondary_page_id, keys: arr(b.primary_rune_ids).map(Number), subs: arr(b.secondary_rune_ids).map(Number), shards: arr(b.stat_mod_ids).map(Number), wr: p.play ? p.win / p.play : null, pick: rate(p.pick_rate), play: p.play || 0 }; }).filter(r => r.keys.length),
    summs: arr(d.summoner_spells).slice(0, 2).map(x => ({ ids: arr(x.ids).map(Number), wr: x.play ? x.win / x.play : null, pick: rate(x.pick_rate), play: x.play || 0 })).filter(x => x.ids.length),
  };
}
async function tierList(fresh) {
  let v = !fresh && memGet('tl4'); if (v) return v;
  if (KV && !fresh) { try { const s = await KV.get('tl', { type: 'json', cacheTtl: 300 }); if (s && s.region === 'EUW' && Date.now() - s.updated < 3 * 3600e3) { memSet('tl4', s, 600); return s; } } catch {} }
  const dd = await ddragon();
  try {
    const j = await web(`?tier=${TIER}`);
    v = { version: dd.version, patch: (j.meta && j.meta.version) || '', region: 'EUW', matches: (j.meta && j.meta.match_count) || 0, opggAt: opggTime(j.meta), roles: shapeTierWeb(j, dd.list), updated: Date.now() };
    if (!Object.values(v.roles).some(a => a.length)) throw new Error('op.gg EUW sent an empty tier list');
  } catch (e) {
    // backup: OP.GG's official feed (all regions, Emerald+)
    const raw = await opgg('lol_list_lane_meta_champions', { position: 'all', desired_output_fields: TL_POS.map(p => `data.positions.${p}[].${TL_F}`) });
    v = { version: dd.version, region: 'all', note: e.message, roles: shapeTier(raw, dd.list), updated: Date.now() };
    if (!Object.values(v.roles).some(a => a.length)) throw new HttpError(502, 'OP.GG returned an empty tier list.');
  }
  memSet('tl4', v, v.region === 'EUW' ? 3 * 3600 : 600);
  return v;
}

const items = x => x && Array.isArray(x.ids) && x.ids.length
  ? { items: x.ids.map((id, k) => ({ id, name: (x.ids_names || [])[k] || '' })), wr: x.play ? x.win / x.play : null, pick: x.pick_rate ?? null, play: x.play || 0 }
  : null;
const options = a => (Array.isArray(a) ? a : []).map(items).filter(Boolean).slice(0, 3);

export function shape(raw) {
  const d = (raw && raw.data) || {};
  const roles = ((d.summary && d.summary.positions) || []).map(p => ({
    p: String(p.name || '').toLowerCase(), rate: p.stats ? p.stats.role_rate : null, wr: p.stats ? p.stats.win_rate : null, play: p.stats ? p.stats.play : 0,
  })).filter(r => POSITIONS.includes(r.p)).sort((a, b) => (b.rate || 0) - (a.rate || 0));
  const sk = d.skills, mx = d.skill_masteries;
  return {
    roles,
    starter: items(d.starter_items), boots: items(d.boots), core: items(d.core_items),
    fourth: options(d.fourth_items), fifth: options(d.fifth_items), sixth: options(d.sixth_items),
    skills: sk && Array.isArray(sk.order) && sk.order.length ? { order: sk.order, wr: sk.play ? sk.win / sk.play : null, pick: sk.pick_rate ?? null, play: sk.play || 0 } : null,
    // weak = champions that beat this one; strong = champions this one beats
    counters: { weak: counters(d.weak_counters, true), strong: counters(d.strong_counters, false) },
    late: [],
    runes: d.runes && Array.isArray(d.runes.primary_rune_ids) && d.runes.primary_rune_ids.length ? [{ primary: +d.runes.primary_page_id, secondary: +d.runes.secondary_page_id, keys: d.runes.primary_rune_ids.map(Number), subs: arr(d.runes.secondary_rune_ids).map(Number), shards: arr(d.runes.stat_mod_ids).map(Number), wr: d.runes.play ? d.runes.win / d.runes.play : null, pick: rate(d.runes.pick_rate), play: d.runes.play || 0 }] : [],
    summs: d.summoner_spells && Array.isArray(d.summoner_spells.ids) && d.summoner_spells.ids.length ? [{ ids: d.summoner_spells.ids.map(Number), wr: d.summoner_spells.play ? d.summoner_spells.win / d.summoner_spells.play : null, pick: rate(d.summoner_spells.pick_rate), play: d.summoner_spells.play || 0 }] : [],
    max: mx && Array.isArray(mx.ids) && mx.ids.length ? { order: mx.ids, wr: mx.play ? mx.win / mx.play : null, pick: mx.pick_rate ?? null } : null,
  };
}

async function analysis(champ, position) {
  const k = `an4:${champ.id}:${position}`; let v = memGet(k); if (v) return v;
  let last;
  for (const name of [...new Set([ogName(champ.name), champ.id.toUpperCase()])]) {
    try {
      v = shape(await opgg('lol_get_champion_analysis', { game_mode: 'ranked', champion: name, position, tier: TIER, desired_output_fields: BUILD_FIELDS }));
      memSet(k, v, TTL);
      return v;
    } catch (e) { last = e; }
  }
  throw new HttpError(502, 'OP.GG had no data for ' + champ.name + (last ? ': ' + last.message : ''));
}

export async function build(cName, pos) {
  const dd = await ddragon();
  const q = norm(cName || '');
  if (!q) throw new HttpError(400, 'Type a champion name.');
  const champ = dd.list.find(c => norm(c.name) === q || norm(c.id) === q) || dd.list.find(c => norm(c.name).startsWith(q));
  if (!champ) throw new HttpError(404, `No champion called “${String(cName).slice(0, 40)}”.`);
  let position = POSITIONS.includes(pos) ? pos : '', a, region = 'EUW', note = '';
  try {
    if (!position) {
      // most played role, from the tier list
      const tl = await tierList(); let best = 0;
      for (const [p, list] of Object.entries(tl.roles)) for (const e of list) if (e.id === champ.id && e.play > best) { best = e.play; position = p; }
      if (!position) position = 'mid';
    }
    a = await analysisWeb(champ, position, dd);
  } catch (e) {
    region = 'all'; note = e.message; position = POSITIONS.includes(pos) ? pos : '';
    a = await analysis(champ, position || 'mid');
    if (!position) {
      position = (a.roles[0] && a.roles[0].p) || 'mid';
      if (position !== 'mid') a = await analysis(champ, position);
    }
  }
  // all the Riot name/icon lookups (and the tier list's op.gg time) at once instead of one after another
  const [tl, N, R, S, sp] = await Promise.all([
    region === 'EUW' ? tierList().catch(() => null) : null,
    position === 'support' ? itemNames(dd.version) : null,
    a.runes && a.runes.length ? runeData(dd.version) : null,
    a.summs && a.summs.length ? summs(dd.version) : null,
    spells(dd.version, champ.id),
  ]);
  // op.gg leaves the support item (World Atlas and its upgrades) out of starting items; supports always start with it
  const SUP = [3865, 3866, 3867, 3869, 3870, 3871, 3876, 3877];
  if (N && a.starter && !a.starter.items.some(i => SUP.includes(+i.id))) a = { ...a, starter: { ...a.starter, items: [{ id: 3865, name: N[3865] || 'World Atlas', added: true }, ...a.starter.items] } };
  // when op.gg last processed its EUW stats: the champion data only says when op.gg answered, so use the tier list's time
  if (tl && tl.region === 'EUW' && tl.opggAt) a = { ...a, opggAt: tl.opggAt };
  if (R) { const r1 = i => ({ id: i, name: (R[i] || {}).name || 'Rune ' + i, icon: (R[i] || {}).icon || '' });
    a = { ...a, runes: a.runes.map(x => ({ ...x, primary: r1(x.primary), secondary: r1(x.secondary), keys: x.keys.map(r1), subs: x.subs.map(r1), shards: x.shards.map(i => ({ id: i, name: SHARDS[i] || 'Shard ' + i })) })) }; }
  if (S) a = { ...a, summs: a.summs.map(x => ({ ...x, spells: x.ids.map(i => ({ id: i, name: (S[i] || {}).name || 'Spell ' + i, img: (S[i] || {}).img || '' })) })) };
  return { champion: champ.name, id: champ.id, version: dd.version, position, tier: TIER, region, note, ...a, spells: sp, updated: a.fetchedAt || Date.now() };
}

async function analysisWeb(champ, position, dd) {
  const k = `w6:${champ.id}:${position}`; let v = memGet(k); if (v) return v;
  if (!champ.key || !POS_WEB[position]) throw new Error('no EUW lookup for ' + champ.name);
  const [j, N] = await Promise.all([web(`/${champ.key}/${POS_WEB[position]}?tier=${TIER}`), itemNames(dd.version)]);
  v = { ...shapeWeb(j, dd.list, N), fetchedAt: Date.now() };
  if (!v.core && !v.skills && !v.summs.length) throw new Error('op.gg EUW has no build for ' + champ.name + ' ' + position);
  memSet(k, v, TTL);
  return v;
}

// ---- builds kept ready in KV ----
// A cron runs warm() every 10 minutes: it refreshes the WARM_BATCH champion/role builds that are oldest (or missing),
// stores them together in one KV value (a "chunk") and points the index at it. Reading a build is then
// two small KV reads instead of a round trip to op.gg.
const WARM_BATCH = 10;
const STORED_MAX_AGE = 12 * 3600e3;
export async function warm(env) {
  if (!env || !env.DATA) return { skipped: 'no KV' };
  KV = env.DATA;
  const tl = await tierList(true); // op.gg's latest, not the stored copy
  if (tl.region !== 'EUW') return { skipped: 'op.gg EUW unavailable' };
  const prev = await env.DATA.get('tl', { type: 'json' });
  if (!prev || prev.opggAt !== tl.opggAt || Date.now() - prev.updated > 3600e3) await env.DATA.put('tl', JSON.stringify(tl), { expirationTtl: 2 * 86400 });
  const idx = (await env.DATA.get('idx', { type: 'json' })) || {};
  const combos = [];
  for (const [p, list] of Object.entries(tl.roles)) for (const e of list) if (e.id) combos.push(e.id + ':' + p);
  const due = combos.map(k => [k, (idx[k] && idx[k].at) || 0]).sort((a, b) => a[1] - b[1]).slice(0, WARM_BATCH).map(x => x[0]);
  const dd = await ddragon(), got = {};
  await Promise.all(due.map(async k => {
    const [id, p] = k.split(':'), champ = dd.list.find(c => c.id === id);
    if (!champ) return;
    try { const b = await build(champ.name, p); if (b.region === 'EUW') got[k] = b; } catch {}
  }));
  const keys = Object.keys(got), now = Date.now(), live = new Set(combos);
  for (const k of Object.keys(idx)) if (!live.has(k)) delete idx[k];
  if (keys.length) {
    const cid = 'chunk:' + now.toString(36);
    await env.DATA.put(cid, JSON.stringify(got), { expirationTtl: 2 * 86400 });
    for (const k of keys) idx[k] = { c: cid, at: now };
  }
  // champions op.gg had nothing for are tried again later, after the others
  for (const k of due) if (!got[k]) idx[k] = { ...(idx[k] || {}), at: now - 6 * 3600e3 };
  await env.DATA.put('idx', JSON.stringify(idx));
  return { refreshed: keys.length, due: due.length, total: combos.length, stored: Object.values(idx).filter(x => x.c).length };
}
// A stored build for this champion (and role, or its most played role), if the refresh has one that is fresh enough.
export async function stored(cName, pos) {
  if (!KV) return null;
  const q = norm(cName || ''); if (!q) return null;
  const [tl, idx] = await Promise.all([KV.get('tl', { type: 'json', cacheTtl: 300 }), KV.get('idx', { type: 'json', cacheTtl: 60 })]);
  if (!tl || !idx) return null;
  let id = '', best = 0, role = POSITIONS.includes(pos) ? pos : '';
  for (const [p, list] of Object.entries(tl.roles || {})) for (const e of list) {
    if (norm(e.name) !== q && norm(e.id) !== q) continue;
    id = e.id;
    if (!POSITIONS.includes(pos) && e.play > best) { best = e.play; role = p; }
  }
  const ref = id && role && idx[id + ':' + role];
  if (!ref || !ref.c || Date.now() - ref.at > STORED_MAX_AGE) return null;
  const chunk = await KV.get(ref.c, { type: 'json', cacheTtl: 300 });
  const b = chunk && chunk[id + ':' + role];
  if (!b || (b.region === 'EUW' && !b.vs)) return null; // stored before matchups were added: fetch it fresh instead
  return { ...b, opggAt: tl.opggAt || b.opggAt };
}

// ---------------------------------------------------------------------------------------------------------------
// Jungle paths, from Riot's own match data (EUW, Emerald+ ranked solo). Riot's match timelines say where every player
// stood once a minute, so for each jungler we note the place at 1:00, 2:00, 3:00 and 4:00 (a camp, a scuttle crab,
// a lane, the base) and count the most common routes per champion and map side. Once a minute is coarse: it shows
// where the first clear starts and which way it goes, not every camp. The cron collects a few matches each run with
// the RIOT_KEY secret (Riot personal key: 20 calls/s, 100 per 2 min, shared with the Clash helper).
// ---------------------------------------------------------------------------------------------------------------
const RIOT_PLAT = 'https://euw1.api.riotgames.com', RIOT_REG = 'https://europe.api.riotgames.com';
const JG_TIERS = ['EMERALD', 'DIAMOND'], JG_DIVS = ['I', 'II', 'III', 'IV'], JG_APEX = ['master', 'grandmaster', 'challenger'];
export const JG_CRON = '5-59/10 * * * *';
const JG_CALLS = 40;        // Riot calls per cron run (Workers' free plan allows 50 subrequests per run)
const JG_TOP = 40;          // routes kept per champion and side
// Summoner's Rift camp centres (game units, 0..14870; blue side bottom left). Red side is the mirror image.
const BLUE_CAMPS = { Blue: [3800, 7950], Gromp: [2150, 8450], Wolves: [3750, 6550], Raptors: [6950, 5450], Red: [7800, 4100], Krugs: [8400, 2700] };
const MAP = 14870, mirror = ([x, y]) => [MAP - x, MAP - y];
const CAMPS = { 100: BLUE_CAMPS, 200: Object.fromEntries(Object.entries(BLUE_CAMPS).map(([k, p]) => [k, mirror(p)])) };
const SCUTTLE = { 'Top scuttle': [4400, 9650], 'Bot scuttle': [10450, 5200] };
const FOUNTAIN = { 100: [400, 420], 200: [14340, 14390] };
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);

// where a jungler of team (100 blue, 200 red) is: their own camp ("Red"), the enemy's ("Enemy Red"), a scuttle,
// a lane, the river, the base, or just "Jungle"
export function place(pos, team) {
  if (!pos || typeof pos.x !== 'number') return null;
  const p = [pos.x, pos.y], enemy = team === 100 ? 200 : 100;
  if (dist(p, FOUNTAIN[team]) < 3000) return 'Base';
  let best = null, bd = 1300;
  for (const [k, c] of Object.entries(CAMPS[team])) { const d = dist(p, c); if (d < bd) { bd = d; best = k; } }
  for (const [k, c] of Object.entries(CAMPS[enemy])) { const d = dist(p, c); if (d < bd) { bd = d; best = 'Enemy ' + k; } }
  for (const [k, c] of Object.entries(SCUTTLE)) { const d = dist(p, c); if (d < bd) { bd = d; best = k; } }
  if (best) return best;
  const [x, y] = p;
  if (x < 2200 || y > MAP - 2200) return 'Top lane';
  if (y < 2200 || x > MAP - 2200) return 'Bot lane';
  if (Math.abs(x - y) < 1600) return 'Mid lane';
  if (Math.abs(x + y - MAP) < 1600) return x + y < MAP ? 'Bot river' : 'Top river';
  if (dist(p, FOUNTAIN[enemy]) < 3000) return 'Enemy base';
  return 'Jungle';
}

// the junglers of one match: [{champ, team, win, path: [place at 1:00, 2:00, 3:00, 4:00]}]
export function junglePaths(match, timeline) {
  const info = match && match.info, frames = timeline && timeline.info && timeline.info.frames;
  if (!info || info.queueId !== 420 || !Array.isArray(frames) || frames.length < 5 || info.gameDuration < 600) return [];
  const out = [];
  for (const p of info.participants || []) {
    if (p.teamPosition !== 'JUNGLE' || (p.teamId !== 100 && p.teamId !== 200)) continue;
    const path = [1, 2, 3, 4].map(i => { const f = frames[i] && frames[i].participantFrames && frames[i].participantFrames[String(p.participantId)]; return f ? place(f.position, p.teamId) : null; });
    if (path.some(x => !x)) continue;
    out.push({ champ: p.championName, team: p.teamId, win: !!p.win, path });
  }
  return out;
}

const patchNum = p => { const [a, b] = String(p).split('.').map(Number); return a * 1000 + (b || 0); };
const patchOf = v => (String(v || '').match(/^(\d+)\.(\d+)/) || []).slice(1, 3).join('.');

// adds one match's junglers to the tally: agg.champs[norm name][side] = {n, w, start: {camp: n}, paths: {key: [n, w]}}
export function addPaths(agg, version, rows) {
  const patch = patchOf(version);
  if (!patch) return agg;
  if (!agg || agg.patch !== patch) {
    // a new patch: start over, but keep the old tally until the new one has a few hundred games
    if (agg && agg.patch && patchNum(patch) < patchNum(agg.patch)) return agg; // an old patch's match
    agg = { patch, games: 0, champs: {}, prev: agg && agg.games >= 300 ? { patch: agg.patch, games: agg.games, champs: agg.champs } : (agg && agg.prev) || null };
  }
  agg.games++;
  for (const r of rows) {
    const k = norm(r.champ), side = r.team === 100 ? 'blue' : 'red';
    const c = (agg.champs[k] ||= { name: r.champ });
    const s = (c[side] ||= { n: 0, w: 0, start: {}, paths: {} });
    s.n++; if (r.win) s.w++;
    s.start[r.path[0]] = (s.start[r.path[0]] || 0) + 1;
    const key = r.path.join('>');
    const e = (s.paths[key] ||= [0, 0]); e[0]++; if (r.win) e[1]++;
    const keys = Object.keys(s.paths);
    if (keys.length > JG_TOP * 2) { keys.sort((a, b) => s.paths[b][0] - s.paths[a][0]); for (const x of keys.slice(JG_TOP)) delete s.paths[x]; }
  }
  if (agg.prev && agg.games >= 300) agg.prev = null;
  return agg;
}

// what /api/jungle answers for one champion: per side the start camps and the 3 most common routes
export function jungleView(agg, champ) {
  const k = norm(champ), cur = agg && agg.champs && agg.champs[k], old = agg && agg.prev && agg.prev.champs && agg.prev.champs[k];
  // each side from this patch once it has 10 games, else from the previous patch while that's kept
  const side = which => {
    let s = cur && cur[which], patch = agg && agg.patch;
    if ((!s || s.n < 10) && old && old[which] && old[which].n >= 10) { s = old[which]; patch = agg.prev.patch; }
    if (!s || s.n < 10) return null;
    const start = Object.entries(s.start).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([camp, n]) => ({ camp, share: n / s.n }));
    const paths = Object.entries(s.paths).sort((a, b) => b[1][0] - a[1][0]).slice(0, 3)
      .map(([key, [n, w]]) => ({ path: key.split('>'), games: n, share: n / s.n, win: n ? w / n : 0 }));
    return { patch, games: s.n, win: s.w / s.n, start, paths };
  };
  return { champion: (cur || old || {}).name || champ, patch: agg ? agg.patch : '', region: 'EUW', rank: 'Emerald+', minutes: [1, 2, 3, 4],
    blue: side('blue'), red: side('red') };
}

class RiotLimit extends Error {}
async function riot(env, url, state) {
  if (state.calls >= JG_CALLS) throw new RiotLimit('budget');
  state.calls++;
  const r = await fetch(url, { headers: { 'X-Riot-Token': env.RIOT_KEY }, signal: AbortSignal.timeout(10000) });
  if (r.status === 429 || r.status === 401 || r.status === 403) throw new RiotLimit(String(r.status));
  if (r.status === 404) return null;
  if (!r.ok) throw new Error('riot ' + r.status);
  await new Promise(res => setTimeout(res, 120)); // stay well under 20 calls a second
  return r.json();
}

// one cron run: top up the player list from the ranked ladder, find new matches, read as many as the budget allows
export async function collectJungle(env, kv = env.DATA) {
  if (!env.RIOT_KEY || !kv) return { skipped: 'no key' };
  const st = (await kv.get('jg:state', { type: 'json' })) || { players: [], matches: [], seen: [], ladder: 0 };
  let agg = await kv.get('jg:agg', { type: 'json' });
  const budget = { calls: 0 }, done = { matches: 0, errors: 0 };
  try {
    if (st.players.length === 0 && st.matches.length < 10) {
      const n = st.ladder++ % (JG_TIERS.length * JG_DIVS.length * 3 + JG_APEX.length);
      let rows;
      if (n < JG_APEX.length) {
        const l = await riot(env, `${RIOT_PLAT}/lol/league/v4/${JG_APEX[n]}leagues/by-queue/RANKED_SOLO_5x5`, budget);
        rows = (l && l.entries) || [];
      } else {
        const m = n - JG_APEX.length, tier = JG_TIERS[Math.floor(m / (JG_DIVS.length * 3)) % JG_TIERS.length];
        const div = JG_DIVS[Math.floor(m / 3) % JG_DIVS.length], page = (m % 3) + 1;
        rows = (await riot(env, `${RIOT_PLAT}/lol/league/v4/entries/RANKED_SOLO_5x5/${tier}/${div}?page=${page}`, budget)) || [];
      }
      st.players = rows.map(e => e.puuid).filter(Boolean).sort(() => Math.random() - 0.5).slice(0, 150);
      done.ladder = { rows: rows.length, withPuuid: st.players.length, keys: rows[0] ? Object.keys(rows[0]).join(',') : '' };
    }
    const since = Math.floor(Date.now() / 1000) - 4 * 86400;
    while (st.matches.length < 10 && st.players.length) {
      const id = await riot(env, `${RIOT_REG}/lol/match/v5/matches/by-puuid/${st.players.pop()}/ids?queue=420&type=ranked&start=0&count=10&startTime=${since}`, budget);
      for (const m of id || []) if (!st.seen.includes(m) && !st.matches.includes(m)) st.matches.push(m);
    }
    while (st.matches.length) {
      const id = st.matches[st.matches.length - 1];
      const match = await riot(env, `${RIOT_REG}/lol/match/v5/matches/${id}`, budget);
      const tl = match ? await riot(env, `${RIOT_REG}/lol/match/v5/matches/${id}/timeline`, budget) : null;
      st.matches.pop(); st.seen.push(id);
      if (match && tl) { agg = addPaths(agg, match.info && match.info.gameVersion, junglePaths(match, tl)); done.matches++; }
    }
  } catch (e) { if (!(e instanceof RiotLimit)) done.errors++; done.stop = e.message; }
  st.seen = st.seen.slice(-4000);
  st.last = { at: new Date().toISOString(), calls: budget.calls, matches: done.matches, stop: done.stop || '', ladder: done.ladder || null }; // the last run, for checking on it
  await kv.put('jg:state', JSON.stringify(st));
  if (done.matches) await kv.put('jg:agg', JSON.stringify(agg));
  return { ...done, calls: budget.calls, games: agg ? agg.games : 0 };
}

const json = (obj, status = 200, maxAge = 0) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': maxAge ? `public, max-age=${maxAge}` : 'no-store' },
});

export default {
  async fetch(request, env, ctx) {
    KV = (env && env.DATA) || null;
    const url = new URL(request.url);
    if (request.method !== 'GET' && request.method !== 'HEAD') return new Response('Method not allowed', { status: 405 });
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return new Response(PAGE, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' } });
    }
    if (url.pathname === '/api/champs') {
      try { const d = await ddragon(); return json({ version: d.version, list: d.list }, 200, 3600); }
      catch { return json({ error: 'Could not load the champion list.' }, 502); }
    }
    if (url.pathname === '/api/tierlist') {
      const cache = typeof caches !== 'undefined' ? caches.default : null;
      const key = new Request('https://cache.champ-build/v4/tierlist');
      if (cache) { const hit = await cache.match(key); if (hit) return hit; }
      try {
        const data = await tierList(), res = json(data, 200, 600);
        if (cache) { const store = res.clone(); store.headers.set('cache-control', `public, max-age=${data.region === 'EUW' ? 10800 : 600}`); ctx && ctx.waitUntil ? ctx.waitUntil(cache.put(key, store)) : await cache.put(key, store); }
        return res;
      } catch (e) {
        return json({ error: e instanceof HttpError ? e.message : 'Could not load the tier list: ' + e.message }, e instanceof HttpError ? e.status : 502);
      }
    }
    if (url.pathname === '/api/build') {
      const c = url.searchParams.get('c') || '', p = (url.searchParams.get('p') || '').toLowerCase();
      // shared edge cache, so repeat look-ups don't hit OP.GG
      const cache = typeof caches !== 'undefined' ? caches.default : null;
      const key = new Request(`https://cache.champ-build/v11/${encodeURIComponent(norm(c))}/${POSITIONS.includes(p) ? p : 'auto'}`);
      if (cache) { const hit = await cache.match(key); if (hit) return hit; }
      try {
        const data = (await stored(c, p).catch(() => null)) || (await build(c, p)), res = json(data, 200, 600);
        if (cache) { const store = res.clone(); store.headers.set('cache-control', `public, max-age=${data.region === 'EUW' ? TTL : 600}`); ctx && ctx.waitUntil ? ctx.waitUntil(cache.put(key, store)) : await cache.put(key, store); }
        return res;
      } catch (e) {
        return json({ error: e instanceof HttpError ? e.message : 'Something went wrong: ' + e.message }, e instanceof HttpError ? e.status : 500);
      }
    }
    if (url.pathname === '/api/jungle') {
      const c = url.searchParams.get('c') || '';
      if (!c) return json({ error: 'Which champion?' }, 400);
      try {
        const agg = KV ? await KV.get('jg:agg', { type: 'json', cacheTtl: 300 }) : null;
        // matches name champions by their Data Dragon id ("MonkeyKing"); accept the display name too ("Wukong")
        let id = c;
        try { const d = await ddragon(), hit = d.list.find(x => norm(x.name) === norm(c) || norm(x.id) === norm(c)); if (hit) id = hit.id; } catch {}
        return json(jungleView(agg, id), 200, 600);
      } catch (e) { return json({ error: 'Could not load jungle paths.' }, 502); }
    }
    return new Response('Not found', { status: 404 });
  },
  async scheduled(event, env, ctx) {
    // two schedules: the build warmer every 10 minutes, the jungle path collector 5 minutes after it
    if (event && event.cron === JG_CRON) ctx.waitUntil(collectJungle(env).catch(() => {}));
    else ctx.waitUntil(warm(env).catch(() => {}));
  },
};
