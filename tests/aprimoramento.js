// Aprimoramento automatico: Chromium com a extensao e Twitch/Twish simulados.
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs');
const EXT = path.resolve(process.argv[2]); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TWITCH_HTML = `<!doctype html><html><head><title>foo - Twitch</title></head><body>
<div data-a-target="chat-input"><div contenteditable="true" role="textbox" id="inp"></div></div>
<button data-a-target="chat-send-button" id="send">Chat</button><div data-test-selector="chat-scrollable-area__message-container" id="chat"></div>
<script>window.__sent=[];document.getElementById('send').addEventListener('click',()=>{const i=document.getElementById('inp');window.__sent.push(i.innerText.trim());i.innerHTML='';});</script></body></html>`;
const chain = (pre, key, list) => list.map(([id, name, cost], i) => ({ id, name, cost, [key]: i ? list[i - 1][0] : null }));
const SHOP = {
  rods: chain('vara', 'requires_rod_id', [['vara_bambu', 'Vara de Bambu', 0], ['vara_madeira', 'Vara de Madeira', 300], ['vara_fibra', 'Vara de Fibra', 800], ['vara_aco', 'Vara de Aço', 1600], ['vara_carbono', 'Vara de Carbono', 3000]]),
  backpacks: chain('m', 'requires_backpack_id', [['mochila_couro', 'Mochila de Couro', 400], ['mochila_encerada', 'Mochila Encerada', 1000]]),
  hooks: chain('a', 'requires_hook_id', [['anzol_duplo', 'Anzol Duplo', 50000]]),
  baits: [{ id: 'isca_de_rio', name: 'Isca de Rio', cost: 20 }], boosters: [], incubators: [], fertilizers: [], upkeep: [], discount_rate: 0
};
let ME;
const resetMe = (coins) => { ME = { coins, rods: ['vara_bambu', 'vara_madeira', 'vara_fibra', 'vara_aco'], rod: 'vara_aco', backpack: null, hooks: [] }; };
const priceOf = (id) => { const all = [...SHOP.rods, ...SHOP.backpacks, ...SHOP.hooks]; const i = all.find((x) => x.id === id); return SHOP.discount_rate ? Math.round(i.cost * (1 - SHOP.discount_rate)) : i.cost; };
const out = [];
(async () => {
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(require('os').tmpdir(), 'autotwish-')), { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  const errors = [];
  await ctx.route('**/*', async (route) => {
    const u = new URL(route.request().url()); const p = u.pathname;
    if (u.hostname.endsWith('twitch.tv')) return route.fulfill({ contentType: 'text/html', body: TWITCH_HTML });
    if (!u.hostname.endsWith('twish.com.br')) return route.continue();
    if (p.endsWith('/shop')) return route.fulfill({ json: SHOP });
    if (p.endsWith('/me')) return route.fulfill({ json: { channel: 'foo', login: 'x', twishcoins: ME.coins, cooldown_remaining: 300, equipment: { rod_id: ME.rod, backpack_id: ME.backpack, hook_id: null }, owned: { rod_ids: ME.rods, hook_ids: ME.hooks }, active: {} } });
    if (p === '/api/me/challenge') return route.fulfill({ json: { state: 'none' } });
    if (p.endsWith('/events/active')) return route.fulfill({ json: { event: null, grande_evento: null } });
    if (p.endsWith('/expeditions')) return route.fulfill({ json: { rooms: [], voyages: [], mine: null } });
    return route.fulfill({ status: 404, json: { error: 'x' } });
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = sw.url().split('/')[2];
  const tw = await ctx.newPage(); tw.on('pageerror', (e) => errors.push('twitch: ' + e.message));
  await tw.goto('https://www.twitch.tv/foo'); await sleep(2000);
  // o "jogo": aplica as compras vistas no chat
  let seen = 0; let stop = false;
  (async () => { while (!stop) { const s = await tw.evaluate(() => window.__sent).catch(() => []); for (; seen < s.length; seen++) { const m = /^\$comprar (\S+)/.exec(s[seen]); if (!m) continue; const id = m[1]; ME.coins -= priceOf(id); if (id.startsWith('vara_')) { ME.rods.push(id); ME.rod = id; } else if (id.startsWith('mochila_')) ME.backpack = id; else ME.hooks.push(id); } await sleep(150); } })();
  await sw.evaluate(async () => { await mutateChannels((c) => { c.foo = { ...AT.DEFAULT_CHANNEL_SETTINGS }; }); await mutateGeneral((g) => { g.shopList = AT.sanitizeShopList({ ...g.shopList, reserve: 100 }); g.autoUpgrade = AT.sanitizeAutoUpgrade({ enabled: true }); }); });
  const run = async () => { await tw.evaluate(() => { window.__sent = []; }); seen = 0; await sw.evaluate(() => runUpgrade('foo', 'teste')); await sleep(300); const msg = await sw.evaluate(async () => ((((await browser.storage.local.get('gameState')).gameState || {}).foo || {}).upgrade || {}).lastMsg); return `chat: ${JSON.stringify(await tw.evaluate(() => window.__sent))} | ${msg}`; };

  resetMe(3200);
  out.push(`A 3200 moedas, reserva 100, Vara→Mochila→Anzol -> ${await run()} | saldo ${ME.coins}`);
  resetMe(600);
  out.push(`B 600 moedas (vara não dá) -> ${await run()} | saldo ${ME.coins}`);
  resetMe(5000);
  await sw.evaluate(() => mutateGeneral((g) => { g.autoUpgrade = AT.sanitizeAutoUpgrade({ ...g.autoUpgrade, order: ['backpacks', 'rods', 'hooks'] }); }));
  out.push(`C 5000 moedas, Mochila→Vara→Anzol -> ${await run()} | saldo ${ME.coins}`);
  resetMe(2600);
  await sw.evaluate(() => mutateGeneral((g) => { g.autoUpgrade = AT.sanitizeAutoUpgrade({ ...g.autoUpgrade, when: 'discount', order: ['rods', 'backpacks', 'hooks'], categories: { backpacks: false } }); }));
  out.push(`D "só no desconto", sem desconto -> ${await run()}`);
  SHOP.discount_rate = 0.2;
  out.push(`  com 20% de desconto (carbono 2400), 2600 moedas -> ${await run()} | saldo ${ME.coins}`);
  SHOP.discount_rate = 0;

  // configuracoes
  const opt = await ctx.newPage(); opt.on('pageerror', (e) => errors.push('options: ' + e.message));
  opt.on('console', (m) => { if (m.type() === 'error') errors.push('options console: ' + m.text()); });
  await opt.goto(`chrome-extension://${extId}/options.html`); await sleep(1500);
  const up = opt.locator('#generalUpgrade');
  out.push(`E configurações: categorias=${(await up.locator('.shop-item').allTextContents()).map((t) => t.replace(/[↑↓]/g, '').trim()).join(' | ')} | quando="${await up.locator('select').inputValue()}" | reserva=${await up.locator('input[type=text]').inputValue()}`);
  await up.locator('input[type=text]').fill('250'); await up.locator('input[type=text]').dispatchEvent('change'); await sleep(800);
  const shopReserve = await opt.locator('#generalShop .js-shop-reserve').inputValue().catch(() => '?');
  out.push(`  reserva 250 no Aprimoramento -> salvo na Lista de Compras: ${await sw.evaluate(async () => (await browser.storage.local.get('general')).general.shopList.reserve)} | campo da Lista de Compras mostra: ${shopReserve}`);
  await up.locator('.shop-item').first().locator('button').nth(1).click(); await sleep(600);
  out.push(`  ↓ na primeira -> ordem salva: ${JSON.stringify(await sw.evaluate(async () => (await browser.storage.local.get('general')).general.autoUpgrade.order))}`);
  const cats = await opt.evaluate(() => [...document.querySelectorAll('#generalShop option, #generalShop optgroup')].map((o) => o.label || o.textContent).filter(Boolean));
  out.push(`F Lista de Compras: tem vara/mochila/anzol? ${cats.some((t) => /vara|mochila|anzol/i.test(t)) ? 'SIM (erro)' : 'não'}`);
  stop = true;
  out.push(`erros nas paginas: ${errors.length ? errors.join(' | ') : 'nenhum'}`);
  console.log(out.join('\n')); await ctx.close(); process.exit(0);
})().catch((e) => { console.log(out.join('\n')); console.error(e); process.exit(1); });
