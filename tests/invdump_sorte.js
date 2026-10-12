// Inv Dump + Sorte Rara por raridade, no Chromium com a extensao carregada.
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs');
const EXT = path.resolve(process.argv[2]); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TWITCH_HTML = `<!doctype html><html><head><title>foo - Twitch</title></head><body>
<div data-a-target="chat-input"><div contenteditable="true" role="textbox" id="inp"></div></div>
<button data-a-target="chat-send-button" id="send">Chat</button><div data-test-selector="chat-scrollable-area__message-container" id="chat"></div>
<script>window.__sent=[];document.getElementById('send').addEventListener('click',()=>{const i=document.getElementById('inp');window.__sent.push(i.innerText.trim());i.innerHTML='';});</script></body></html>`;
const stack = (id, tier, prices) => ({ fish_id: id, id, tier, count: prices.length, instances: prices.map((p) => ({ price: p, escrowed: false })) });
let INV = { total: 21, capacity: { max_fish_total: 100, max_fish_per_species: 10 }, fish: [stack('sardinha', 'common', [2, 2, 3, 3, 3, 4, 4, 4, 5, 5]), stack('vieira', 'uncommon', [9, 9, 9, 10, 10, 11, 11, 12, 12, 12]), stack('lucio', 'rare', [27])] };
let EVENT = { event: null, grande_evento: null };
const out = [];
(async () => {
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(require('os').tmpdir(), 'autotwish-')), { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  const errors = [];
  await ctx.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.hostname.endsWith('twitch.tv')) return route.fulfill({ contentType: 'text/html', body: TWITCH_HTML });
    if (u.hostname.endsWith('twish.com.br')) {
      const p = u.pathname;
      if (p.endsWith('/me/inventory')) return route.fulfill({ json: INV });
      if (p.endsWith('/events/active')) return route.fulfill({ json: EVENT });
      if (p.endsWith('/me')) return route.fulfill({ json: { channel: 'foo', login: 'jogador_teste', cooldown_remaining: 300, twishcoins: 100, equipment: { rod_id: 'vara_aco', bait_id: null }, owned: { baits: { isca_de_rio: 5 }, items: {} }, active: {}, whitelisted_fish_ids: ['vieira'] } });
      if (p.endsWith('/shop')) return route.fulfill({ json: { baits: [{ id: 'isca_de_rio', name: 'Isca de Rio', cost: 20 }, { id: 'isca_milagrosa', name: 'Isca Milagrosa', cost: 150 }], rods: [], hooks: [], backpacks: [], boosters: [], incubators: [], fertilizers: [], upkeep: [] } });
      if (p === '/api/me/challenge') return route.fulfill({ json: { state: 'none' } });
      if (p.endsWith('/expeditions')) return route.fulfill({ json: { rooms: [], voyages: [], mine: null } });
      return route.fulfill({ status: 404, json: { error: 'x' } });
    }
    return route.continue();
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = sw.url().split('/')[2];
  out.push(`1 scripts: ${JSON.stringify(await sw.evaluate(() => ({ invdump: typeof runInvDump, plano: typeof AT.planInvDump, kit: typeof runKitCheck })))}`);

  // configuracoes
  const opt = await ctx.newPage(); opt.on('pageerror', (e) => errors.push('options: ' + e.message));
  opt.on('console', (m) => { if (m.type() === 'error') errors.push('options console: ' + m.text()); });
  await opt.goto(`chrome-extension://${extId}/options.html`); await sleep(1500);
  const inv = opt.locator('#generalInvDump');
  out.push(`2 configuracoes: Inv Dump presente=${await inv.locator('input[type=checkbox]').count() === 1} | campo "Nunca vender" escondido com ele desligado=${await inv.locator('select').isHidden()}`);
  await inv.locator('input[type=checkbox]').check(); await sleep(400);
  out.push(`  ligar Inv Dump -> salvo: ${JSON.stringify(await sw.evaluate(async () => (await browser.storage.local.get('general')).general.invDump))} | campo visivel=${await inv.locator('select').isVisible()}`);
  await inv.locator('select').selectOption(''); await sleep(400);
  out.push(`  "sem limite" -> salvo: ${JSON.stringify(await sw.evaluate(async () => (await browser.storage.local.get('general')).general.invDump))}`);
  await inv.locator('select').selectOption('mythic'); await sleep(400);
  const kit = opt.locator('#generalKit');
  const luckBox = kit.locator('.kit-event').nth(2);
  out.push(`  Sorte Rara: raridades no editor=${await luckBox.locator('.kit-tier').count()} (${(await luckBox.locator('.kit-tier strong').allTextContents()).join(', ')})`);
  await luckBox.locator('input[type=checkbox]').first().check(); await sleep(400);
  const rareTier = luckBox.locator('.kit-tier').nth(1);
  await rareTier.locator('input[type=checkbox]').first().check(); await sleep(400);
  await opt.evaluate(() => browser.runtime.sendMessage({ type: 'UPDATE_GENERAL_SETTINGS', patch: { eventKit: { tier_catch_boost: { tiers: { rare: { baitId: 'isca_de_rio' } } } } } })); await sleep(400);
  const mythTier = luckBox.locator('.kit-tier').nth(3);
  await mythTier.locator('input[type=checkbox]').first().check(); await sleep(400);
  await opt.evaluate(() => browser.runtime.sendMessage({ type: 'UPDATE_GENERAL_SETTINGS', patch: { eventKit: { tier_catch_boost: { tiers: { mythic: { baitId: 'isca_milagrosa' } } } } } })); await sleep(400);
  const savedKit = await sw.evaluate(async () => { const k = (await browser.storage.local.get('general')).general.eventKit.tier_catch_boost; return { enabled: k.enabled, rare: k.tiers.rare.enabled && k.tiers.rare.baitId, mythic: k.tiers.mythic.enabled && k.tiers.mythic.baitId, legendary: k.tiers.legendary.enabled }; });
  out.push(`  ligar Sorte Rara, Raro (isca de rio) e Mitico (milagrosa) -> salvo: ${JSON.stringify(savedKit)} | resumo: ${await sw.evaluate(async () => AT.describeEventKit(AT.sanitizeEventKit((await browser.storage.local.get('general')).general.eventKit)))}`);

  // Inv Dump de verdade
  const tw = await ctx.newPage(); tw.on('pageerror', (e) => errors.push('twitch: ' + e.message));
  await tw.goto('https://www.twitch.tv/foo'); await sleep(2000);
  await sw.evaluate(async () => { await mutateChannels((c) => { c.foo = { ...AT.DEFAULT_CHANNEL_SETTINGS, ...(c.foo || {}) }; }); });
  const t0 = Date.now();
  const run = sw.evaluate(() => runInvDump('foo', 'teste'));
  await sleep(3500); // depois do 1o $vender, o "jogo" registra a venda
  INV = { ...INV, total: 20, fish: [stack('sardinha', 'common', [2, 3, 3, 3, 4, 4, 4, 5, 5]), INV.fish[1], INV.fish[2]] };
  await run;
  out.push(`3 Inv Dump (sardinha 10/10, vieira 10/10 na whitelist): chat recebeu=${JSON.stringify(await tw.evaluate(() => window.__sent))} em ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  out.push(`  registro: ${await sw.evaluate(async () => (((await browser.storage.local.get('gameState')).gameState || {}).foo || {}).invDump.lastMsg)}`);
  // inventario cheio (100/100), nenhuma especie cheia, mitico protegido
  const many = []; for (let k = 0; k < 11; k++) many.push(stack('p' + k, 'common', Array.from({ length: 9 }, (_, j) => 10 + k + j)));
  INV = { total: 100, capacity: { max_fish_total: 100, max_fish_per_species: 10 }, fish: many.slice(0, 10).concat([stack('baleia', 'mythic', [1, 1, 1, 1, 1, 1, 1, 1, 1, 1].slice(0, 9)), stack('x', 'common', [50])]) };
  INV.total = INV.fish.reduce((a, f) => a + f.count, 0);
  await tw.evaluate(() => { window.__sent = []; });
  const run2 = sw.evaluate(() => runInvDump('foo', 'teste'));
  await sleep(3500); INV = { ...INV, total: INV.total - 1 }; await run2;
  out.push(`4 inventario ${INV.total + 1}/100 sem especie cheia, baleia (mitica, preco 1) protegida pelo limite: chat recebeu=${JSON.stringify(await tw.evaluate(() => window.__sent))}`);
  // jogador pescou na mao -> agenda a conferencia
  await tw.evaluate(() => { document.getElementById('inp').innerText = '$pescar'; }); await tw.click('#send');
  await sleep(800);
  const al = await sw.evaluate(async () => { const a = await browser.alarms.get('auto-twish-invdump:foo'); return a ? Math.round((a.scheduledTime - Date.now()) / 1000) : null; });
  out.push(`5 $pescar enviado pelo jogador -> conferencia do Inv Dump agendada em: ${al === null ? 'NAO' : al + 's'}`);

  // Sorte Rara de Raro -> isca de rio
  await tw.evaluate(() => { window.__sent = []; });
  EVENT = { event: { name: 'Sorte Rara', emoji: '🍀', kind: 'tier_catch_boost', value: 2, tiers: ['rare'], tier_labels: ['Raro'], message: '🍀 Sorte Rara! Chance de pescar peixe Raro em dobro', seconds_remaining: 500 }, grande_evento: null };
  await sw.evaluate(async () => { await refreshEvents('foo', false); await runKitCheck('foo', 'teste'); });
  await sleep(500);
  out.push(`6 Sorte Rara de Raro: chat recebeu=${JSON.stringify(await tw.evaluate(() => window.__sent))} | registro: ${await sw.evaluate(async () => (((await browser.storage.local.get('gameState')).gameState || {}).foo || {}).kit.lastMsg)}`);
  // Sorte Rara de Lendario (sem regra) -> nada; volta a isca de antes
  await tw.evaluate(() => { window.__sent = []; });
  EVENT = { event: { ...EVENT.event, tiers: ['legendary'], tier_labels: ['Lendário'], message: '🍀 Sorte Rara! Chance de pescar peixe Lendário em dobro' }, grande_evento: null };
  await sw.evaluate(async () => { await refreshEvents('foo', false); await runKitCheck('foo', 'teste'); });
  await sleep(500);
  out.push(`7 Sorte Rara de Lendario (sem regra): ctx=${JSON.stringify(await sw.evaluate(async () => (((await browser.storage.local.get('gameState')).gameState || {}).foo || {}).kit.ctx.event || null))} | chat recebeu=${JSON.stringify(await tw.evaluate(() => window.__sent))} (a isca de antes era nenhuma)`);
  out.push(`erros nas paginas: ${errors.length ? errors.join(' | ') : 'nenhum'}`);
  console.log(out.join('\n')); await ctx.close(); process.exit(0);
})().catch((e) => { console.log(out.join('\n')); console.error(e); process.exit(1); });
