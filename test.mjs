// node test.mjs — loads worker.js with page.html inlined, mocks OP.GG + Data Dragon, checks parsing and the API.
import { readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';

const dir = new URL('.', import.meta.url).pathname;
const page = readFileSync(join(dir, 'page.html'), 'utf8');
const src = readFileSync(join(dir, 'worker.js'), 'utf8').replace("import PAGE from './page.html';", 'const PAGE = ' + JSON.stringify(page) + ';');
const tmp = mkdtempSync(join(tmpdir(), 'cb-'));
writeFileSync(join(tmp, 'w.mjs'), src);
const W = await import(join(tmp, 'w.mjs'));

// page script must at least parse
const script = page.match(/<script>([\s\S]*?)<\/script>/)[1];
new Function(script);

// real OP.GG answer for Ahri mid (Emerald+), captured 2026-11-24
const AHRI = `class LolGetChampionAnalysis: champion,position,data
class Data: summary,core_items,boots,starter_items,fourth_items,fifth_items,sixth_items,skills,skill_masteries
class Summary: positions
class Position: name,stats
class Stats: play,win_rate,role_rate
class CoreItems: ids,ids_names,play,win,pick_rate
class Skills: order,play,win,pick_rate
class SkillMasteries: ids,play,win,pick_rate

LolGetChampionAnalysis("AHRI","MID",Data(Summary([Position("MID",Stats(134691,0.51,0.96))]),CoreItems([3118,4645,3157],["Malignance","Shadowflame","Zhonya's Hourglass"],9948,5217,0.13),CoreItems([3020],["Sorcerer's Shoes"],68860,35667,0.57),CoreItems([1056,2003,2003],["Doran's Ring","Health Potion","Health Potion"],121817,62513,0.99),[CoreItems([3089],["Rabadon's Deathcap"],10189,5915,0.33),CoreItems([3157],["Zhonya's Hourglass"],7758,4637,0.25),CoreItems([3135],["Void Staff"],2584,1332,0.08)],[CoreItems([3089],["Rabadon's Deathcap"],1632,1009,0.2),CoreItems([3135],["Void Staff"],1295,737,0.16),CoreItems([3157],["Zhonya's Hourglass"],1240,768,0.16)],[CoreItems([4629],["Cosmic Drive"],24,9,0.16),CoreItems([4646],["Stormsurge"],21,13,0.14),CoreItems([3135],["Void Staff"],18,3,0.12)],Skills(["W","Q","E","Q","Q","R","Q","W","Q","W","R","W","W","E","E"],50546,29192,0.6),SkillMasteries(["Q","W","E"],78202,45402,0.93)))`;

const TL_TEXT = `class LolListLaneMetaChampions: data
class Data: positions
class Positions: top,mid,jungle,adc,support
class Entry: ban_rate,champion,pick_rate,play,rank,rank_prev,role_rate,tier,win_rate

LolListLaneMetaChampions(Data(Positions([],[Entry(0.03,"Ahri",0.08,5000,3,5,0.9,2,0.512),Entry(0.01,"Mel",0.02,300,9,0,0.8,3,0.49),Entry(0.01,"Nobody",0.02,0,9,0,0.8,3,0.49)],[Entry(0.02,"Wukong",0.05,4000,1,1,0.7,1,0.53)],[],[])))`;
let t = 0;
const ok = (name, fn) => { fn(); t++; };

ok('parse Ahri', () => {
  const p = W.parseOpgg(AHRI);
  assert.equal(p.champion, 'AHRI');
  assert.deepEqual(p.data.core_items.ids, [3118, 4645, 3157]);
  assert.equal(p.data.core_items.ids_names[2], "Zhonya's Hourglass");
  assert.equal(p.data.skills.order.length, 15);
  assert.equal(p.data.fourth_items.length, 3);
});
ok('shape Ahri', () => {
  const s = W.shape(W.parseOpgg(AHRI));
  assert.equal(s.roles[0].p, 'mid');
  assert.equal(s.core.items[0].name, 'Malignance');
  assert.ok(Math.abs(s.core.wr - 5217 / 9948) < 1e-9);
  assert.equal(s.boots.items[0].id, 3020);
  assert.equal(s.starter.items.length, 3);
  assert.deepEqual(s.max.order, ['Q', 'W', 'E']);
  assert.equal(s.sixth[0].items[0].name, 'Cosmic Drive');
});
ok('counters: worst matchups first, fractions and percents, empty rows dropped', () => {
  const s = W.shape({ data: {
    weak_counters: [{ champion_name: 'Zed', my_win_rate: 0.47, play: 900 }, { champion_name: 'Fizz', my_win_rate: 44.5, play: 300 }, { champion_name: 'X', my_win_rate: 0.4, play: 0 }],
    strong_counters: [{ champion_name: 'Lux', my_win_rate: 0.53, play: 500 }, { champion_name: 'Annie', my_win_rate: 0.56, play: 200 }],
  } });
  assert.deepEqual(s.counters.weak.map(c => c.name), ['Fizz', 'Zed']);
  assert.ok(Math.abs(s.counters.weak[0].wr - 0.445) < 1e-9);
  assert.deepEqual(s.counters.strong.map(c => c.name), ['Annie', 'Lux']);
  assert.deepEqual(W.shape({ data: {} }).counters, { weak: [], strong: [] });
});
ok('tier list shape', () => {
  const raw = W.parseOpgg(TL_TEXT);
  const r = W.shapeTier(raw, [{ id: 'Ahri', name: 'Ahri' }, { id: 'MonkeyKing', name: 'Wukong' }]);
  assert.equal(r.mid.length, 2);
  assert.deepEqual(r.mid[0], { name: 'Ahri', id: 'Ahri', tier: 2, wr: 0.512, pick: 0.08, ban: 0.03, play: 5000, trend: 2 });
  assert.equal(r.mid[1].trend, null);
  assert.equal(r.jungle[0].id, 'MonkeyKing');
  assert.deepEqual(r.top, []);
});
ok('summoner spells shape (official feed: one pair)', () => {
  const s = W.shape({ data: { summoner_spells: { ids: [4, 14], ids_names: [4, 14], pick_rate: 0.7, play: 85910, win: 44366 } } });
  assert.equal(s.summs.length, 1); assert.deepEqual(s.summs[0].ids, [4, 14]); assert.equal(s.summs[0].pick, 0.7); assert.ok(Math.abs(s.summs[0].wr - 44366 / 85910) < 1e-12);
  assert.deepEqual(W.shape({ data: {} }).summs, []);
});
// EUW source: shaped like op.gg's real answer for Darius top, Emerald+ (2026-11-24)
const LIST = [{ id: 'Darius', name: 'Darius', key: '122' }, { id: 'Kled', name: 'Kled', key: '240' }, { id: 'Ahri', name: 'Ahri', key: '103' }, { id: 'MonkeyKing', name: 'Wukong', key: '62' }];
const DARIUS = { data: {
  summary: { positions: [{ name: 'TOP', stats: { play: 19564, win_rate: 0.51053, role_rate: 0.826531 } }, { name: 'JUNGLE', stats: { play: 3797, win_rate: 0.520148, role_rate: 0.160414 } }] },
  summoner_spells: [{ ids: [4, 6], win: 5183, play: 10268, pick_rate: 0.5921 }, { ids: [4, 14], win: 2721, play: 5239, pick_rate: 0.3021 }, { ids: [4, 12], win: 10, play: 20, pick_rate: 0.01 }],
  core_items: [{ ids: [3142, 3742, 6333], play: 1956, win: 1158, pick_rate: 0.1745 }],
  boots: [{ ids: [3047], play: 9980, win: 5044, pick_rate: 0.5764 }, { ids: [3111], play: 4708, win: 2436, pick_rate: 0.2719 }],
  starter_items: [{ ids: [1055, 2003], play: 12771, win: 6588, pick_rate: 0.7193 }],
  last_items: [{ ids: [3142], play: 10906, win: 5661, pick_rate: 0.6222 }, { ids: [3742], play: 9839, win: 5352, pick_rate: 0.5614 }, { ids: [3047], play: 9000, win: 4600, pick_rate: 0.5 }, { ids: [3071], play: 5000, win: 2600, pick_rate: 0.3 }],
  skill_masteries: [{ ids: ['Q', 'E', 'W'], play: 13053, win: 7210, pick_rate: 0.9557, builds: [{ order: ['W','Q','E','Q','Q','R','Q','E','Q','E','R','E','E','W','W'], play: 4758, win: 2598, pick_rate: 0.3645 }] }],
  skills: [{ order: ['W'], play: 4758, win: 2598, pick_rate: 0.3484 }],
  rune_pages: [{ id: 8230, primary_page_id: 8200, secondary_page_id: 8000, play: 7322, win: 3744, pick_rate: 0.4188, builds: [{ primary_rune_ids: [8230, 8226, 8210, 8237], secondary_rune_ids: [9104, 8299], stat_mod_ids: [5005, 5008, 5011], play: 5417, win: 2768, pick_rate: 0.7398 }] },
    { id: 8010, primary_page_id: 8000, secondary_page_id: 8200, play: 5447, win: 2806, pick_rate: 0.3116, builds: [{ primary_rune_ids: [8010, 9111, 9104, 8299], secondary_rune_ids: [8224, 8237], stat_mod_ids: [5005, 5008, 5011], play: 3279, win: 1680, pick_rate: 0.602 }] }, { id: 1, primary_page_id: 8100, secondary_page_id: 8000, play: 5, win: 1, pick_rate: 0.01, builds: [] }],
  counters: [{ champion_id: 240, play: 149, win: 56 }, { champion_id: 103, play: 300, win: 180 }, { champion_id: 62, play: 12, win: 1 }],
}, meta: { version: '16.23', cached_at: '2026-11-25 03:47:39' } };
ok('EUW champion shape', () => {
  const s = W.shapeWeb(DARIUS, LIST, { 3047: 'Plated Steelcaps', 1055: "Doran's Blade", 2003: 'Health Potion' });
  assert.deepEqual(s.roles.map(r => r.p), ['top', 'jungle']);
  assert.equal(s.summs.length, 2); assert.deepEqual(s.summs[0].ids, [4, 6]); assert.equal(s.summs[0].pick, 0.5921); assert.equal(s.summs[1].play, 5239);
  assert.equal(s.skills.pick, 0.3645); assert.equal(s.skills.play, 4758); assert.deepEqual(s.max.order, ['Q', 'E', 'W']);
  assert.equal(s.boots.items[0].name, 'Plated Steelcaps'); assert.equal(s.boots2.items[0].id, 3111); assert.equal(s.boots2.pick, 0.2719); assert.equal(s.starter.pick, 0.7193); assert.deepEqual(s.late.map(x => x.items[0].id), [3071], 'core items and boots are left out of other popular items');
  assert.equal(s.runes.length, 2); assert.equal(s.runes[0].pick, 0.4188); assert.equal(s.runes[0].play, 7322); assert.deepEqual(s.runes[0].keys, [8230, 8226, 8210, 8237]); assert.deepEqual(s.runes[1].subs, [8224, 8237]);
  assert.equal(s.counters.weak[0].name, 'Kled'); assert.ok(Math.abs(s.counters.weak[0].wr - 56 / 149) < 1e-12);
  assert.equal(s.counters.strong[0].name, 'Ahri'); assert.equal(s.counters.weak.length, 2, 'matchups under 40 games are skipped');
  assert.deepEqual(s.vs.map(v => v.id), ['Kled', 'Ahri'], 'every matchup with 40+ games, for the companion'); assert.equal(s.vs[0].play, 149); assert.equal(s.vs[0].wr, Math.round(56 / 149 * 10000) / 10000);
});
ok('EUW tier list shape', () => {
  const j = { data: [{ id: 122, positions: [{ name: 'TOP', stats: { play: 19564, win_rate: 0.51053, pick_rate: 0.0745, ban_rate: 0.18, tier_data: { tier: 1, rank: 2, rank_prev: 5 } } }, { name: 'JUNGLE', stats: { play: 3797, win_rate: 0.52, pick_rate: 0.014, ban_rate: 0.18, tier_data: { tier: 3, rank: 25, rank_prev: 22 } } }] }, { id: 999, positions: [{ name: 'MID', stats: { play: 5 } }] }] };
  const r = W.shapeTierWeb(j, LIST);
  assert.deepEqual(r.top[0], { name: 'Darius', id: 'Darius', tier: 1, wr: 0.51053, pick: 0.0745, ban: 0.18, play: 19564, trend: 3 });
  assert.equal(r.jungle[0].trend, -3); assert.deepEqual(r.mid, []);
});
ok('op.gg timestamps', () => {
  assert.equal(W.opggTime({ analyzed_at: '2026-11-25T03:25:34+09:00' }), Date.parse('2026-11-24T18:25:34Z'));
  assert.equal(W.opggTime({ cached_at: '2026-11-25 03:47:39' }), Date.parse('2026-11-24T18:47:39Z'), 'cached_at is Korean time');
  assert.equal(W.opggTime(null), null); assert.equal(W.opggTime({ cached_at: 'nope' }), null);
});
ok('parse unknown class + escapes + None', () => {
  const p = W.parseOpgg('class A: x,y,z\n\nA("a\\"b",None,Meta("hi"))');
  assert.equal(p.x, 'a"b'); assert.equal(p.y, null); assert.equal(p.z._type, 'Meta');
});
ok('shape tolerates empty data', () => {
  const s = W.shape({ data: {} });
  assert.equal(s.core, null); assert.deepEqual(s.fourth, []); assert.equal(s.skills, null);
});
ok('ogName', () => {
  assert.equal(W.ogName('Nunu & Willump'), 'NUNU_WILLUMP');
  assert.equal(W.ogName("Kai'Sa"), 'KAISA');
  assert.equal(W.ogName('Renata Glasc'), 'RENATA_GLASC');
  assert.equal(W.ogName('Wukong'), 'WUKONG');
});

// ---- API with mocked network ----
const PANTH = `class LolGetChampionAnalysis: data
class Data: summary,core_items,skills
class Summary: positions
class Position: name,stats
class Stats: play,win_rate,role_rate
class CoreItems: ids,ids_names,play,win,pick_rate
class Skills: order,play,win,pick_rate

LolGetChampionAnalysis(Data(Summary([Position("TOP",Stats(41086,0.5,0.4)),Position("SUPPORT",Stats(38738,0.48,0.38))]),CoreItems([1],["X"],10,5,0.1),Skills(["Q"],10,5,0.5)))`;
const calls = [];
let webUp = false; const webCalls = [];
globalThis.fetch = async (url, init) => {
  url = String(url);
  const j = o => ({ json: async () => o, text: async () => JSON.stringify(o) });
  if (url.endsWith('versions.json')) return j(['15.23.1']);
  if (url.endsWith('/champion.json')) return j({ data: { Ahri: { id: 'Ahri', name: 'Ahri', key: '103' }, Pantheon: { id: 'Pantheon', name: 'Pantheon', key: '80' }, Mel: { id: 'Mel', name: 'Mel', key: '800' }, MonkeyKing: { id: 'MonkeyKing', name: 'Wukong', key: '62' }, Darius: { id: 'Darius', name: 'Darius', key: '122' }, Thresh: { id: 'Thresh', name: 'Thresh', key: '412' }, Kled: { id: 'Kled', name: 'Kled', key: '240' } } });
  if (url.endsWith('/runesReforged.json')) return j([{ id: 8200, name: 'Sorcery', icon: 'perk-images/Styles/7202_Sorcery.png', slots: [{ runes: [{ id: 8230, name: 'Phase Rush', icon: 'perk-images/Styles/Sorcery/PhaseRush/PhaseRush.png' }] }] }, { id: 8000, name: 'Precision', icon: 'perk-images/Styles/7201_Precision.png', slots: [{ runes: [{ id: 8010, name: 'Conqueror', icon: 'c.png' }] }] }]);
  if (url.endsWith('/item.json')) return j({ data: { 3047: { name: 'Plated Steelcaps' }, 3865: { name: 'World Atlas' }, 2003: { name: 'Health Potion' }, 3142: { name: "Youmuu's Ghostblade" } } });
  if (url.endsWith('/summoner.json')) return j({ data: { SummonerFlash: { key: '4', name: 'Flash', image: { full: 'SummonerFlash.png' } }, SummonerHaste: { key: '6', name: 'Ghost', image: { full: 'SummonerHaste.png' } }, SummonerDot: { key: '14', name: 'Ignite', image: { full: 'SummonerDot.png' } } } });
  if (url.includes('lol-api-champion.op.gg')) {
    webCalls.push(url);
    if (!webUp) return { ok: false, status: 503, json: async () => ({}) };
    if (/\/ranked\?tier=/.test(url)) return { ok: true, status: 200, json: async () => ({ data: [{ id: 122, positions: [{ name: 'TOP', stats: { play: 19564, win_rate: 0.51, pick_rate: 0.07, ban_rate: 0.18, tier_data: { tier: 1, rank: 2, rank_prev: 2 } } }] }, { id: 412, positions: [{ name: 'SUPPORT', stats: { play: 30000, win_rate: 0.51, pick_rate: 0.1, ban_rate: 0.1, tier_data: { tier: 1, rank: 1, rank_prev: 1 } } }] }], meta: { version: '16.23', analyzed_at: '2026-11-25T03:25:34+09:00' } }) };
    if (url.includes('/122/TOP')) return { ok: true, status: 200, json: async () => DARIUS };
    if (url.includes('/412/SUPPORT')) return { ok: true, status: 200, json: async () => ({ data: { summary: { positions: [{ name: 'SUPPORT', stats: { play: 30000, win_rate: 0.51, role_rate: 0.99 } }] }, starter_items: [{ ids: [2003, 2003], play: 29288, win: 14963, pick_rate: 0.9793 }], core_items: [{ ids: [3190], play: 10, win: 5, pick_rate: 0.1 }] } }) };
    return { ok: false, status: 404, json: async () => ({}) };
  }
  if (/\/champion\/\w+\.json$/.test(url)) return j({ data: { Ahri: { spells: [1, 2, 3, 4].map(i => ({ name: 'S' + i, image: { full: 's' + i + '.png' } })), passive: { name: 'P', image: { full: 'p.png' } } } } });
  if (url.includes('op.gg')) {
    const b = JSON.parse(init.body);
    if (b.method === 'initialize') return { text: async () => 'event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{}}' };
    calls.push(b.params.arguments);
    const a = b.params.arguments;
    if (b.params.name === 'lol_list_lane_meta_champions') return { text: async () => 'data: ' + JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: TL_TEXT }] } }) };
    const text = a.champion === 'AHRI' ? AHRI : a.champion === 'PANTHEON' ? PANTH : null;
    if (!text) return { text: async () => 'data: ' + JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text: 'not found' }], isError: true } }) };
    return { text: async () => 'data: ' + JSON.stringify({ jsonrpc: '2.0', id: 2, result: { content: [{ type: 'text', text }] } }) };
  }
  throw new Error('unexpected fetch ' + url);
};
const get = async path => { const r = await W.default.fetch(new Request('https://x' + path), {}, { waitUntil() {} }); return [r.status, r.headers.get('content-type'), await r.text()]; };

const [s1, ct1, body1] = await get('/');
assert.equal(s1, 200); assert.match(ct1, /text\/html/); assert.match(body1, /Champion builds/); t++;

const [s2, , b2] = await get('/api/build?c=ahri');
const d2 = JSON.parse(b2);
assert.equal(s2, 200); assert.equal(d2.champion, 'Ahri'); assert.equal(d2.position, 'mid');
assert.equal(d2.spells[0].key, 'Q'); assert.equal(d2.core.items.length, 3);
assert.equal(calls.at(-1).tier, 'emerald_plus'); assert.equal(calls.at(-1).game_mode, 'ranked'); t++;

// no role given: Pantheon's most played role (top) wins, and the second call asks for top
calls.length = 0;
const d3 = JSON.parse((await get('/api/build?c=Pantheon'))[2]);
assert.equal(d3.position, 'top'); assert.deepEqual(calls.map(c => c.position), ['mid', 'top']);
assert.equal(d3.roles.length, 2); t++;

// explicit role is respected, one call
calls.length = 0;
const d4 = JSON.parse((await get('/api/build?c=pantheon&p=support'))[2]);
assert.equal(d4.position, 'support'); assert.equal(calls.length, 1); t++;

// Wukong: OP.GG name WUKONG tried first
calls.length = 0;
const [s5, , b5] = await get('/api/build?c=wukong&p=jungle');
assert.equal(s5, 502); assert.deepEqual(calls.map(c => c.champion), ['WUKONG', 'MONKEYKING']); assert.match(JSON.parse(b5).error, /Wukong/); t++;

assert.equal((await get('/api/build?c=zzzz'))[0], 404); t++;
assert.equal((await get('/api/build?c='))[0], 400); t++;
assert.equal((await get('/nope'))[0], 404); t++;
const [s10, , b10] = await get('/api/tierlist');
const d10 = JSON.parse(b10);
assert.equal(s10, 200); assert.equal(d10.roles.mid[0].name, 'Ahri'); assert.equal(d10.roles.jungle[0].tier, 1); t++;
const [s9, , b9] = await get('/api/champs');
assert.equal(s9, 200); assert.equal(JSON.parse(b9).list.length, 7); t++;
assert.equal(d10.region, 'all', 'tier list falls back to the official feed when EUW is down'); t++;
assert.equal(d2.region, 'all'); t++;

// EUW source up: Darius top comes from op.gg EUW, with both spell pairs and op.gg's own percentages
webUp = true; webCalls.length = 0;
const [s11, , b11] = await get('/api/build?c=Darius&p=top');
const d11 = JSON.parse(b11);
assert.equal(s11, 200); assert.equal(d11.region, 'EUW'); assert.match(webCalls[0], /\/api\/EUW\/champions\/ranked\/122\/TOP\?tier=emerald_plus/);
assert.deepEqual(d11.summs.map(x => x.spells.map(y => y.name).join('+')), ['Flash+Ghost', 'Flash+Ignite']);
const d12 = JSON.parse((await get('/api/build?c=Thresh&p=support'))[2]);
assert.equal(d12.region, 'EUW'); assert.deepEqual(d12.starter.items.map(i => i.name), ['World Atlas', 'Health Potion', 'Health Potion']); assert.equal(d12.starter.items[0].added, true); t++;
assert.equal(d11.runes[0].keys[0].name, 'Phase Rush'); assert.equal(d11.runes[0].primary.name, 'Sorcery'); assert.equal(d11.runes[0].secondary.name, 'Precision'); assert.equal(d11.runes[0].shards[0].name, 'Attack Speed'); assert.equal(d11.runes[1].keys[0].name, 'Conqueror'); t++;
assert.equal(d11.opggAt, undefined, 'op.gg cached_at is not a processing time; the tier list here is the backup, so no time'); assert.ok(d11.updated > 0); t++;
assert.equal(d11.skills.pick, 0.3645); assert.equal(d11.boots.items[0].name, 'Plated Steelcaps'); assert.equal(d11.counters.weak[0].name, 'Kled'); t++;

// ---- builds kept ready in KV: background refresh, then clicks served from storage even if op.gg is down ----
{
  const W2 = await import(join(tmp, 'w.mjs') + '?fresh');
  const store = new Map(), puts = [];
  const DATA = { get: async (k, o) => { const v = store.get(k); return v == null ? null : (o && o.type === 'json' ? JSON.parse(v) : v); }, put: async (k, v) => { puts.push(k); store.set(k, v); } };
  webUp = true;
  const r1 = await W2.warm({ DATA });
  assert.equal(r1.refreshed, 2); assert.equal(r1.total, 2); assert.equal(r1.stored, 2);
  assert.ok(store.has('tl') && store.has('idx')); assert.equal(puts.filter(k => k.startsWith('chunk:')).length, 1, 'one chunk write per run'); t++;
  webUp = false; webCalls.length = 0;
  const get2 = async path => { const r = await W2.default.fetch(new Request('https://x' + path), { DATA }, { waitUntil() {} }); return [r.status, await r.json()]; };
  const [s1, d1] = await get2('/api/build?c=darius');
  assert.equal(s1, 200); assert.equal(d1.region, 'EUW'); assert.equal(d1.position, 'top'); assert.equal(d1.summs.length, 2);
  assert.equal(d1.opggAt, Date.parse('2026-11-24T18:25:34Z'));
  const [s2, d2] = await get2('/api/build?c=Thresh&p=support');
  assert.equal(s2, 200); assert.equal(d2.starter.items[0].name, 'World Atlas');
  assert.equal(webCalls.length, 0, 'stored builds need no op.gg request'); t++;
  // the second run refreshes the oldest first and keeps the index tidy
  webCalls.length = 0; webUp = true; const r2 = await W2.warm({ DATA }); assert.ok(webCalls.some(u => /\/ranked\?tier=/.test(u)), 'the refresh always asks op.gg for the latest tier list'); assert.equal(r2.refreshed, 2); assert.equal(puts.filter(k => k.startsWith('chunk:')).length, 2); t++;
  assert.equal(await W2.stored('nobody', ''), null); t++;
}

// ---- jungle paths ----
ok('jungle places', () => {
  assert.equal(W.place({ x: 7800, y: 4100 }, 100), 'Red');
  assert.equal(W.place({ x: 7800, y: 4100 }, 200), 'Enemy Red');
  assert.equal(W.place({ x: 14870 - 3800, y: 14870 - 7950 }, 200), 'Blue');
  assert.equal(W.place({ x: 4400, y: 9650 }, 100), 'Top scuttle');
  assert.equal(W.place({ x: 500, y: 500 }, 100), 'Base');
  assert.equal(W.place({ x: 600, y: 11000 }, 100), 'Top lane');
  assert.equal(W.place({ x: 7400, y: 7400 }, 100), 'Mid lane');
  assert.equal(W.place(null, 100), null);
});
const frame = (pos) => ({ participantFrames: Object.fromEntries(pos.map((p, i) => [String(i + 1), { position: { x: p[0], y: p[1] }, level: 1 }])) });
const MATCH = { info: { queueId: 420, gameDuration: 1700, gameVersion: '16.23.733.1234', participants: [
  { participantId: 1, championName: 'MonkeyKing', teamPosition: 'JUNGLE', teamId: 100, win: true },
  { participantId: 2, championName: 'Ahri', teamPosition: 'MIDDLE', teamId: 100, win: true },
  { participantId: 3, championName: 'LeeSin', teamPosition: 'JUNGLE', teamId: 200, win: false },
] } };
const R = 14870;
const TL = { info: { frames: [
  frame([[400, 420], [400, 420], [R - 400, R - 420]]),
  frame([[7800, 4100], [7400, 7400], [R - 6950, R - 5450]]),   // 1:00 Red | Raptors (red side's own)
  frame([[6950, 5450], [7400, 7400], [R - 7800, R - 4100]]),   // 2:00 Raptors | Red
  frame([[3800, 7950], [7400, 7400], [R - 8400, R - 2700]]),   // 3:00 Blue | Krugs
  frame([[4400, 9650], [7400, 7400], [600, 11000]]),           // 4:00 Top scuttle | Top lane
] } };
ok('jungle paths from a timeline', () => {
  const rows = W.junglePaths(MATCH, TL);
  assert.deepEqual(rows, [
    { champ: 'MonkeyKing', team: 100, win: true, path: ['Red', 'Raptors', 'Blue', 'Top scuttle'] },
    { champ: 'LeeSin', team: 200, win: false, path: ['Raptors', 'Red', 'Krugs', 'Top lane'] },
  ]);
  assert.deepEqual(W.junglePaths({ info: { ...MATCH.info, queueId: 450 } }, TL), [], 'only ranked solo');
  assert.deepEqual(W.junglePaths({ info: { ...MATCH.info, gameDuration: 300 } }, TL), [], 'no remakes');
});
ok('jungle tally and view', () => {
  let agg = null;
  const rows = W.junglePaths(MATCH, TL);
  for (let i = 0; i < 12; i++) agg = W.addPaths(agg, '16.23.1', rows);
  agg = W.addPaths(agg, '16.23.1', [{ champ: 'MonkeyKing', team: 100, win: false, path: ['Blue', 'Gromp', 'Wolves', 'Mid lane'] }]);
  assert.equal(agg.games, 13);
  const v = W.jungleView(agg, 'Wukong'.replace('Wukong', 'MonkeyKing'));
  assert.equal(v.blue.games, 13);
  assert.deepEqual(v.blue.paths[0].path, ['Red', 'Raptors', 'Blue', 'Top scuttle']);
  assert.equal(v.blue.paths[0].games, 12);
  assert.equal(v.blue.start[0].camp, 'Red');
  assert.equal(v.red, null, 'Wukong never on red here');
  assert.equal(W.jungleView(agg, 'Lee Sin').red.games, 12, 'looked up by display name');
  assert.equal(W.jungleView(agg, 'Ahri').blue, null, 'no jungle Ahri');
  // an older patch's match doesn't reset; a newer one does but keeps the old tally meanwhile
  assert.equal(W.addPaths(agg, '16.9.1', rows).patch, '16.23');
  for (let i = 0; i < 300; i++) agg = W.addPaths(agg, '16.23.1', rows);
  const next = W.addPaths(agg, '16.24.1', rows);
  assert.equal(next.patch, '16.24');
  assert.equal(next.prev.patch, '16.23', 'old tally kept for now');
  assert.equal(W.jungleView(next, 'MonkeyKing').blue.patch, '16.23', 'only 1 game in 16.24: shows 16.23');
  for (let i = 0; i < 10; i++) agg = W.addPaths(next, '16.24.1', rows);
  assert.equal(W.jungleView(agg, 'MonkeyKing').blue.patch, '16.24', '10+ games in 16.24: shows 16.24');
});


// the collector: ladder → match ids → matches + timelines, within the call budget, stops on 429
{
  const kv = new Map();
  const KVm = { get: async (k, o) => kv.has(k) ? JSON.parse(kv.get(k)) : null, put: async (k, v) => { kv.set(k, v); } };
  const real = globalThis.fetch; const riotCalls = []; let limit = false;
  globalThis.fetch = async (url, init) => {
    url = String(url);
    if (!url.includes('riotgames.com')) return real(url, init);
    riotCalls.push(url);
    assert.equal(init.headers['X-Riot-Token'], 'k', 'key sent as a header, never in the URL');
    const j = o => ({ ok: true, status: 200, json: async () => o });
    if (limit) return { ok: false, status: 429, json: async () => ({}) };
    if (url.includes('leagues/by-queue')) return j({ entries: Array.from({ length: 20 }, (_, i) => ({ puuid: 'p' + i })) });
    if (url.includes('/entries/')) return j(Array.from({ length: 20 }, (_, i) => ({ puuid: 'q' + i })));
    if (url.includes('/ids?')) { const n = riotCalls.length; return j([`EUW1_${n}a`, `EUW1_${n}b`, `EUW1_${n}c`]); }
    if (url.endsWith('/timeline')) return j(TL);
    if (/\/matches\/EUW1_/.test(url)) return j(MATCH);
    return { ok: false, status: 404, json: async () => ({}) };
  };
  ok('jungle collector: no key, nothing', () => {});
  ok('riot key trimmed', () => { assert.equal(W.riotKey({ RIOT_KEY: ' "RGAPI-abc"\n' }), 'RGAPI-abc'); assert.equal(W.riotKey({}), ''); });
  assert.deepEqual(await W.collectJungle({}, KVm), { skipped: 'no key' });
  const r = await W.collectJungle({ RIOT_KEY: 'k' }, KVm);
  ok('jungle collector run', () => {
    assert.ok(riotCalls.length <= 40, 'call budget: ' + riotCalls.length);
    assert.ok(r.matches >= 10, 'matches read: ' + r.matches);
    const agg = JSON.parse(kv.get('jg:agg')), st = JSON.parse(kv.get('jg:state'));
    assert.equal(agg.games, r.matches);
    assert.equal(st.seen.length, r.matches);
    assert.ok(!riotCalls.some(u => u.includes('k=') || u.includes('api_key')));
  });
  const before = riotCalls.length; limit = true;
  const r2 = await W.collectJungle({ RIOT_KEY: 'k' }, KVm);
  ok('jungle collector stops on 429', () => { assert.equal(riotCalls.length - before, 1); assert.equal(r2.stop, '429'); assert.equal(r2.errors, 0); });
  globalThis.fetch = real;
  // the API answers from the tally
  const KVsave = kv;
  const resp = await W.default.fetch(new Request('https://x/api/jungle?c=Wukong'), { DATA: KVm }, { waitUntil() {} });
  const jv = await resp.json();
  ok('jungle api by display name', () => { assert.equal(resp.status, 200); assert.equal(jv.champion, 'MonkeyKing'); assert.deepEqual(jv.blue.paths[0].path, ['Red', 'Raptors', 'Blue', 'Top scuttle']); });
  const bad = await W.default.fetch(new Request('https://x/api/jungle'), { DATA: KVm }, { waitUntil() {} });
  ok('jungle api needs a champion', () => assert.equal(bad.status, 400));
}

console.log(`ok: ${t} checks passed`);
