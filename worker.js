import PAGE from './page.html';
// Champion Build — Cloudflare Worker for build.lømsland.no
// Tier list + champion builds for EUW Emerald+ ranked solo/duo, from the data op.gg's own EUW pages load.
// OP.GG's official MCP feed (all regions) is the backup when that source fails.

const OPGG = 'https://mcp-api.op.gg/mcp';
const TIER = 'emerald_plus';
const TTL = 6 * 3600; // seconds; builds change slowly within a patch
const POSITIONS = ['top', 'jungle', 'mid', 'adc', 'support'];

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
  const cs = arr(d.counters).map(c => { const ch = byKey[String(c.champion_id)]; return ch && c.play >= 40 ? { name: ch.name, wr: c.win / c.play, play: c.play } : null; }).filter(Boolean);
  return {
    roles,
    starter: wItems(arr(d.starter_items)[0], N), boots: wItems(arr(d.boots)[0], N), boots2: wItems(arr(d.boots)[1], N), core: wItems(arr(d.core_items)[0], N),
    fourth: [], fifth: [], sixth: [],
    // other popular items: op.gg's most-bought later items, minus anything already in the core build or the boots
    late: (() => { const skip = new Set([...arr((arr(d.core_items)[0] || {}).ids), ...arr(d.boots).flatMap(x => arr(x.ids))].map(Number)); return arr(d.last_items).filter(x => arr(x.ids).length && !x.ids.some(i => skip.has(+i))).slice(0, 6).map(x => wItems(x, N)).filter(Boolean); })(),
    skills: sk && arr(sk.order).length ? { order: sk.order, wr: sk.play ? sk.win / sk.play : null, pick: rate(sk.pick_rate), play: sk.play || 0 } : null,
    max: sm && arr(sm.ids).length ? { order: sm.ids, wr: sm.play ? sm.win / sm.play : null, pick: rate(sm.pick_rate) } : null,
    counters: { weak: [...cs].sort((a, b) => a.wr - b.wr).slice(0, 6), strong: [...cs].sort((a, b) => b.wr - a.wr).slice(0, 6) },
    runes: arr(d.rune_pages).slice(0, 2).map(p => { const b = arr(p.builds)[0] || p; return { primary: +p.primary_page_id, secondary: +p.secondary_page_id, keys: arr(b.primary_rune_ids).map(Number), subs: arr(b.secondary_rune_ids).map(Number), shards: arr(b.stat_mod_ids).map(Number), wr: p.play ? p.win / p.play : null, pick: rate(p.pick_rate), play: p.play || 0 }; }).filter(r => r.keys.length),
    summs: arr(d.summoner_spells).slice(0, 2).map(x => ({ ids: arr(x.ids).map(Number), wr: x.play ? x.win / x.play : null, pick: rate(x.pick_rate), play: x.play || 0 })).filter(x => x.ids.length),
  };
}
async function tierList() {
  let v = memGet('tl4'); if (v) return v;
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

const json = (obj, status = 200, maxAge = 0) => new Response(JSON.stringify(obj), {
  status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': maxAge ? `public, max-age=${maxAge}` : 'no-store' },
});

export default {
  async fetch(request, env, ctx) {
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
      const key = new Request(`https://cache.champ-build/v10/${encodeURIComponent(norm(c))}/${POSITIONS.includes(p) ? p : 'auto'}`);
      if (cache) { const hit = await cache.match(key); if (hit) return hit; }
      try {
        const data = await build(c, p), res = json(data, 200, 600);
        if (cache) { const store = res.clone(); store.headers.set('cache-control', `public, max-age=${data.region === 'EUW' ? TTL : 600}`); ctx && ctx.waitUntil ? ctx.waitUntil(cache.put(key, store)) : await cache.put(key, store); }
        return res;
      } catch (e) {
        return json({ error: e instanceof HttpError ? e.message : 'Something went wrong: ' + e.message }, e instanceof HttpError ? e.status : 500);
      }
    }
    return new Response('Not found', { status: 404 });
  },
};
