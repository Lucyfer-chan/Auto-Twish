// Novidades da 1.0.5: reserva/saldo nas compras dos eventos, isca da Sorte Rara,
// embarque imediato, conferencia do ticket e alerta da verificacao.
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs');
const EXT = path.resolve(process.argv[2]); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TWITCH_HTML = `<!doctype html><html><head><title>foo - Twitch</title></head><body>
<div data-a-target="chat-input"><div contenteditable="true" role="textbox" id="inp"></div></div>
<button data-a-target="chat-send-button" id="send">Chat</button><div data-test-selector="chat-scrollable-area__message-container" id="chat"></div>
<script>window.__bot=(t)=>{const l=document.createElement('div');l.innerHTML='<span data-a-user="twishgamebot">TwishGameBot</span>: <span data-a-target="chat-line-message-body"></span>';l.querySelector('[data-a-target="chat-line-message-body"]').textContent=t;document.getElementById('chat').appendChild(l);};
window.__sent=[];document.getElementById('send').addEventListener('click',()=>{const i=document.getElementById('inp');window.__sent.push(i.innerText.trim());i.innerHTML='';});</script></body></html>`;
const LOGIN = 'jogador_teste';
let ME = { coins: 300, items: {}, baits: {}, baitId: null, active: {}, cd: 120 };
let EVENTS = { event: null, grande_evento: null };
let CHALLENGE = { state: 'none' };
let SEA = { owned: 0 };
let CREW = [];
const POSTS = [];
const SHOP = { discount_rate: 0, boosters: [{ id: 'turbo', name: 'Turbo de Pesca', cost: 200 }], baits: [{ id: 'isca_de_fundo', name: 'Isca de fundo', cost: 25 }], tickets: [{ id: 'ticket_baia', name: 'Ticket da Baía das Lendas', cost: 50 }], items: [{ id: 'afiacao_anzol', name: 'Afiação de Anzol', cost: 120 }] };
const out = [];
(async () => {
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(require('os').tmpdir(), 'autotwish-')), { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  const errors = [];
  await ctx.route('**/*', async (route) => {
    const req = route.request(); const u = new URL(req.url()); const p = u.pathname;
    if (u.hostname.endsWith('twitch.tv')) return route.fulfill({ contentType: 'text/html', body: TWITCH_HTML });
    if (!u.hostname.endsWith('twish.com.br')) return route.continue();
    if (p === '/verificacao') return route.fulfill({ contentType: 'text/html', body: '<title>verificacao</title>' });
    let m;
    if ((m = /\/expeditions\/([0-9a-f-]{36})\/(join|ready)$/.exec(p)) && req.method() === 'POST') {
      POSTS.push(m[2]);
      if (m[2] === 'join') CREW.push({ handle: LOGIN, confirmed: false }); else CREW.forEach((c) => { if (c.handle === LOGIN) c.confirmed = true; });
      return route.fulfill({ json: { ok: true } });
    }
    if (req.method() === 'POST') { POSTS.push(p); return route.fulfill({ json: { ok: true } }); }
    if (/\/expeditions\/[0-9a-f-]{36}$/.test(p)) return route.fulfill({ json: { id: p.split('/').pop(), sea: 'baia', state: 'open', seconds_to_deadline: 600, crew: CREW } });
    if (p.endsWith('/expeditions')) return route.fulfill({ json: { rooms: [], voyages: [], mine: null, boat_enabled: true, max_crew: 4, casts_here: SEA.casts ?? 30, fleet: { max_crew: 16, lobby_seconds: 600, min_casts: 20 }, seas: [{ sea: 'baia', rod_ok: true, entry_item_id: 'ticket_baia', entry_item_name: 'Ticket da Baía das Lendas', entry_quantity: 1, entry_owned: SEA.owned }] } });
    if (p.endsWith('/shop')) return route.fulfill({ json: SHOP });
    if (p.endsWith('/me')) return route.fulfill({ json: { channel: 'foo', login: LOGIN, cooldown_remaining: ME.cd, twishcoins: ME.coins, equipment: { rod_id: 'vara_aco', bait_id: ME.baitId }, owned: { items: ME.items, baits: ME.baits }, active: ME.active } });
    if (p.endsWith('/events/active')) return route.fulfill({ json: EVENTS });
    if (p === '/api/me/challenge') return route.fulfill({ json: CHALLENGE });
    return route.fulfill({ status: 404, json: { error: 'x' } });
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = sw.url().split('/')[2];
  await sw.evaluate(async (login) => {
    await mutateGeneral((g) => { g.twishLogin = login; });
    await mutateChannels((c) => { c.foo = { ...AT.DEFAULT_CHANNEL_SETTINGS, enabled: true, mode: 'manual', nextFireAt: Date.now() + 3600000 }; });
  }, LOGIN);
  const tw = await ctx.newPage(); tw.on('pageerror', (e) => errors.push('twitch: ' + e.message));
  await tw.goto('https://www.twitch.tv/foo'); await sleep(2000);
  const sent = async () => { const s = await tw.evaluate(() => window.__sent); await tw.evaluate(() => { window.__sent = []; }); return JSON.stringify(s); };
  const kitMsg = () => sw.evaluate(async () => ((((await browser.storage.local.get('gameState')).gameState || {}).foo || {}).kit || {}).lastMsg);
  const runKit = async () => { await sw.evaluate(async () => { const ev = await fetchActiveEvents('foo'); await onKitEvents('foo', ev); await runKitCheck('foo', 'teste'); }); await sleep(4500); };

  // 1) XP em Dobro: Turbo com compra, reserva 200, saldo 300 (Turbo custa 200)
  EVENTS = { event: { name: 'XP em Dobro', kind: 'double_xp', seconds_remaining: 900 }, grande_evento: null };
  await sw.evaluate(() => mutateGeneral((g) => { g.shopList = AT.sanitizeShopList({ ...g.shopList, reserve: 200 }); g.eventKit = AT.sanitizeEventKit({ double_xp: { enabled: true, turbo: true, turboBuy: true, sharpen: true, sharpenBuy: true } }); }));
  await runKit();
  out.push(`1 XP em Dobro, saldo 300, reserva 200 (Turbo 200, Afiação 120) -> chat: ${await sent()} | POSTs: ${JSON.stringify(POSTS)} | ${await kitMsg()}`);
  POSTS.length = 0;
  await sw.evaluate(() => mutateGeneral((g) => { g.shopList = AT.sanitizeShopList({ ...g.shopList, reserve: 0 }); g.eventKit = AT.sanitizeEventKit({ double_xp: { enabled: true, turbo: true, turboBuy: true } }); }));
  ME.coins = 150;
  await runKit();
  out.push(`  sem reserva, saldo 150 (não dá o Turbo) -> chat: ${await sent()} | POSTs: ${JSON.stringify(POSTS)} | ${await kitMsg()}`);
  ME.coins = 500;
  await runKit();
  out.push(`  sem reserva, saldo 500 -> chat: ${await sent()} | POSTs: ${JSON.stringify(POSTS)} | ${await kitMsg()}`);
  POSTS.length = 0; ME.active = { boost_remaining: 280 };

  // 2) Sorte Rara: comprar a isca
  await sw.evaluate(() => mutateGeneral((g) => { g.eventKit = AT.sanitizeEventKit({ tier_catch_boost: { enabled: true, tiers: { rare: { enabled: true, baitId: 'isca_de_fundo' } } } }); }));
  EVENTS = { event: { name: 'Sorte Rara', kind: 'tier_catch_boost', tiers: ['rare'], seconds_remaining: 900 }, grande_evento: null };
  ME.coins = 500; ME.baits = {};
  await runKit();
  out.push(`2 Sorte Rara (Raro), sem a isca, compra desligada -> chat: ${await sent()} | ${await kitMsg()}`);
  await sw.evaluate(() => mutateGeneral((g) => { g.shopList = AT.sanitizeShopList({ ...g.shopList, reserve: 300 }); g.eventKit = AT.sanitizeEventKit({ tier_catch_boost: { enabled: true, tiers: { rare: { enabled: true, baitId: 'isca_de_fundo', baitBuy: true, baitBuyQty: 10 } } } }); }));
  await runKit();
  out.push(`  compra ligada (10), saldo 500, reserva 300, isca 25 -> chat: ${await sent()} | ${await kitMsg()}`);
  await runKit();
  out.push(`  conferência logo depois (inventário ainda sem a isca) -> chat: ${await sent()} | ${await kitMsg()}`);
  ME.coins = 310; await sw.evaluate(() => baitBoughtAt.clear());
  await runKit();
  out.push(`  saldo 310, reserva 300 (não dá nem 1) -> chat: ${await sent()} | ${await kitMsg()}`);
  ME.baits = { isca_de_fundo: 4 }; ME.coins = 500;
  await runKit();
  out.push(`  já com a isca no inventário -> chat: ${await sent()} | ${await kitMsg()}`);
  EVENTS = { event: null, grande_evento: null };
  await sw.evaluate(() => mutateGeneral((g) => { g.eventKit = AT.sanitizeEventKit({}); }));
  await sw.evaluate(async () => { const ev = await fetchActiveEvents('foo'); await onKitEvents('foo', ev); await mutateGameState('foo', (st) => { st.kit = {}; }); });
  await sent();

  // 3) Embarque imediato e ticket
  let n = 0; const room = () => `aaaaaaaa-bbbb-cccc-dddd-${String(++n).padStart(12, '0')}`;
  const open = async () => { const id = room(); await sw.evaluate(() => browser.storage.local.remove('boarding')); await tw.evaluate((id) => window.__bot(`⛵ @dono abriu uma expedição à Baía das Lendas! Embarque pelo site em twish.com.br/c/dono/expedicoes/${id} — até 4 tripulantes, e a sala zarpa em 10 min.`), id); };
  const st = () => sw.evaluate(async () => { const b = (await browser.storage.local.get('boarding')).boarding; return b ? `${b.phase}: ${b.lastMsg}` : '(nenhum)'; });
  ME.cd = 120; ME.items = {}; SEA.owned = 1; CREW = [{ handle: 'dono', confirmed: true }]; POSTS.length = 0;
  await sw.evaluate(() => mutateGeneral((g) => { g.autoBoard = AT.sanitizeAutoBoard({ enabled: true, seas: { baia: { enabled: true, buy: true } } }); }));
  await open(); await sleep(6000);
  out.push(`3 3 vagas, pesca em 2:00, sem embarque imediato -> ${await st()} | POSTs: ${JSON.stringify(POSTS)}`);
  CREW = [{ handle: 'dono', confirmed: true }]; POSTS.length = 0;
  await sw.evaluate(() => mutateGeneral((g) => { g.autoBoard = AT.sanitizeAutoBoard({ ...g.autoBoard, immediate: true }); }));
  await open(); await sleep(7000);
  out.push(`  com embarque imediato -> ${await st()} | POSTs: ${JSON.stringify(POSTS)}`);
  CREW = [{ handle: 'dono', confirmed: true }]; POSTS.length = 0; SEA.owned = 0; ME.items = { ticket_baia: 1 };
  await open(); await sleep(8000);
  out.push(`  porto diz sem ticket, mas o inventário tem 1 -> chat: ${await sent()} | ${await st()} | POSTs: ${JSON.stringify(POSTS)}`);
  CREW = [{ handle: 'dono', confirmed: true }]; POSTS.length = 0; ME.items = {};
  await open(); await sleep(12000);
  out.push(`  sem ticket em lugar nenhum -> chat: ${await sent()} | ${await st()} | POSTs: ${JSON.stringify(POSTS)}`);
  await sw.evaluate(() => mutateGeneral((g) => { g.autoBoard = AT.sanitizeAutoBoard({}); }));

  // 3b) Frota do Capitao
  const fleetOpen = () => tw.evaluate(() => window.__bot('@streamer_teste lançou a Frota do Capitão! Digite $embarcar nos próximos 10m0s — sem ticket e sem vara mínima, até 16 tripulantes.'));
  const fst = () => sw.evaluate(async () => { const f = (await browser.storage.local.get('fleet')).fleet; return f ? `${f.phase}: ${f.lastMsg}` : '(nenhum)'; });
  const fleetReset = () => sw.evaluate(() => browser.storage.local.remove('fleet'));
  await sw.evaluate(() => mutateGeneral((g) => { g.autoBoard = AT.sanitizeAutoBoard({ enabled: true }); }));
  await fleetReset(); await sent(); await fleetOpen(); await sleep(5000);
  out.push(`3b Frota, opção desligada -> chat: ${await sent()} | ${await fst()}`);
  await sw.evaluate(() => mutateGeneral((g) => { g.autoBoard = AT.sanitizeAutoBoard({ enabled: true, fleet: true }); }));
  ME.cd = 120; await fleetReset(); await fleetOpen(); await sleep(6000);
  out.push(`  ligada, pesca em 2:00 -> chat: ${await sent()} | ${await fst()}`);
  await sw.evaluate(() => noteFishForBoarding('foo')); await sleep(9000);
  out.push(`  depois do $pescar -> chat: ${await sent()} | ${await fst()}`);
  await sw.evaluate(() => mutateGeneral((g) => { g.autoBoard = AT.sanitizeAutoBoard({ enabled: true, fleet: true, immediate: true }); }));
  await fleetReset(); await fleetOpen(); await sleep(9000);
  out.push(`  com embarque imediato -> chat: ${await sent()} | ${await fst()}`);
  SEA.casts = 12; await fleetReset(); await fleetOpen(); await sleep(6000);
  out.push(`  só 12 pescas neste barco -> chat: ${await sent()} | ${await fst()}`);
  SEA.casts = 30;
  await sw.evaluate(() => mutateGeneral((g) => { g.autoBoard = AT.sanitizeAutoBoard({}); }));

  // 4) Verificacao
  const vtabs = () => sw.evaluate(async () => (await chrome.tabs.query({ url: '*://twish.com.br/verificacao*' })).length);
  await tw.evaluate((l) => window.__bot(`@${l} 🤖 Verificação rápida: resolva em twish.com.br/verificacao em até 2 minutos para continuar pescando.`), LOGIN);
  await sleep(2500);
  out.push(`4 mensagem de verificação, alertas desligados -> abas da verificação: ${await vtabs()} | offscreen: ${await sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length)}`);
  await sw.evaluate(() => mutateGeneral((g) => { g.verifyAlert = { openWindow: true, sound: true }; }));
  await tw.evaluate((l) => window.__bot(`@${l} 🤖 Verificação rápida: resolva em twish.com.br/verificacao em até 2 minutos para continuar pescando.`), LOGIN);
  await sleep(3000);
  const wins = await sw.evaluate(async () => (await chrome.windows.getAll({ populate: true })).map((w) => ({ focused: w.focused, tabs: w.tabs.length, url: w.tabs[0] && w.tabs[0].url })));
  out.push(`  alertas ligados -> abas da verificação: ${await vtabs()} | janelas: ${JSON.stringify(wins)} | offscreen (som): ${await sw.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length)}`);
  await tw.evaluate((l) => window.__bot(`@${l} 🤖 Verificação rápida: resolva em twish.com.br/verificacao em até 2 minutos para continuar pescando.`), LOGIN);
  await sleep(2000);
  out.push(`  mesma mensagem de novo (dentro de 3 min) -> abas da verificação: ${await vtabs()}`);
  await tw.evaluate(() => window.__bot(`@outra_pessoa 🤖 Verificação rápida: resolva em twish.com.br/verificacao em até 2 minutos para continuar pescando.`));
  await sw.evaluate(async () => { lastVerifyAlertAt = 0; await browser.storage.local.remove('verifyAlert'); });
  await sw.evaluate(async () => { for (const t of await chrome.tabs.query({ url: '*://twish.com.br/verificacao*' })) await chrome.tabs.remove(t.id); });
  await tw.evaluate(() => window.__bot(`@outra_pessoa 🤖 Verificação rápida: resolva em twish.com.br/verificacao em até 2 minutos para continuar pescando.`));
  await sleep(2000);
  out.push(`  verificação de outro jogador -> abas da verificação: ${await vtabs()}`);
  await sw.evaluate(async () => { lastVerifyAlertAt = 0; await browser.storage.local.remove('verifyAlert'); for (const t of await chrome.tabs.query({ url: '*://twish.com.br/verificacao*' })) await chrome.tabs.remove(t.id); });
  CHALLENGE = { state: 'pending', seconds_left: 110 };
  await sw.evaluate(() => checkChallenge('teste'));
  await sleep(2000);
  out.push(`  trava pela API (sem mensagem no chat) -> abas da verificação: ${await vtabs()} | ${JSON.stringify(await sw.evaluate(async () => (await browser.storage.local.get('safety')).safety.locked))}`);
  CHALLENGE = { state: 'none' }; await sw.evaluate(() => checkChallenge('teste'));

  // 5) Opcoes
  const opt = await ctx.newPage(); opt.on('pageerror', (e) => errors.push('options: ' + e.message));
  await opt.goto(`chrome-extension://${extId}/options.html`); await sleep(1500);
  out.push(`5 opções: verificação janela=${await opt.isChecked('#verifyWindow')} som=${await opt.isChecked('#verifySound')} | botão testar: ${await opt.locator('#verifyTest').isVisible()}`);
  await opt.uncheck('#verifySound'); await sleep(300);
  out.push(`  desmarcar som -> salvo: ${JSON.stringify(await sw.evaluate(async () => (await browser.storage.local.get('general')).general.verifyAlert))}`);
  await opt.locator('#generalBoard input[type=checkbox]').first().check(); await sleep(300);
  const imm = opt.locator('#generalBoard label', { hasText: 'Embarque imediato' });
  out.push(`  embarque: opção "Embarque imediato" visível=${await imm.isVisible()}`);
  await imm.locator('input').check(); await sleep(300);
  out.push(`  marcar -> salvo: ${await sw.evaluate(async () => (await browser.storage.local.get('general')).general.autoBoard.immediate)}`);
  const kit = opt.locator('#generalKit');
  await kit.locator('.kit-event').nth(2).locator('input[type=checkbox]').first().check(); await sleep(300);
  const rare = kit.locator('.kit-tier').nth(1);
  await rare.locator('input[type=checkbox]').first().check(); await sleep(300);
  await rare.locator('select').selectOption('isca_de_fundo').catch(async () => { await sw.evaluate(() => mutateGeneral((g) => { g.eventKit = AT.sanitizeEventKit({ ...g.eventKit, tier_catch_boost: { enabled: true, tiers: { rare: { enabled: true, baitId: 'isca_de_fundo' } } } }); })); }); await sleep(500);
  const buyRow = rare.locator('label', { hasText: 'comprar a isca' });
  out.push(`  Sorte Rara (Raro) com isca -> "comprar a isca" visível=${await buyRow.isVisible()} | no XP em Dobro: ${await kit.locator('.kit-event').nth(0).locator('label', { hasText: 'comprar a isca' }).isVisible()}`);
  await buyRow.locator('input').check(); await sleep(300);
  const qty = rare.locator('input[inputmode=numeric]');
  await qty.fill('25'); await qty.press('Tab'); await sleep(400);
  out.push(`  marcar e quantidade 25 -> salvo: ${JSON.stringify(await sw.evaluate(async () => { const t = (await browser.storage.local.get('general')).general.eventKit.tier_catch_boost.tiers.rare; return { baitId: t.baitId, baitBuy: t.baitBuy, baitBuyQty: t.baitBuyQty }; }))}`);
  out.push(`erros nas paginas: ${errors.length ? errors.join(' | ') : 'nenhum'}`);
  console.log(out.join('\n')); await ctx.close(); process.exit(0);
})().catch((e) => { console.log(out.join('\n')); console.error(e); process.exit(1); });
