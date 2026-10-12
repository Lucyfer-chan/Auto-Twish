// Protecao por raridade: Chromium com a extensao e Twitch/Twish simulados.
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs');
const EXT = path.resolve(process.argv[2]); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TWITCH_HTML = `<!doctype html><html><head><title>foo - Twitch</title></head><body>
<div data-a-target="chat-input"><div contenteditable="true" role="textbox" id="inp"></div></div>
<button data-a-target="chat-send-button" id="send">Chat</button><div data-test-selector="chat-scrollable-area__message-container" id="chat"></div>
<script>window.__sent=[];document.getElementById('send').addEventListener('click',()=>{const i=document.getElementById('inp');window.__sent.push(i.innerText.trim());i.innerHTML='';});</script></body></html>`;
const stack = (id, name, tier, prices) => ({ fish_id: id, id, name, tier, count: prices.length, instances: prices.map((p) => ({ price: p, escrowed: false })) });
let WL = [];
let INV = { total: 13, capacity: { max_fish_total: 100, max_fish_per_species: 10 }, fish: [stack('lucio', 'lúcio', 'rare', [27]), stack('baleia', 'baleia', 'mythic', [116]), stack('boitata', 'boitatá', 'secret', [308]), stack('cthulhu', 'Cthulhu', 'ancient_god', [999]), stack('sardinha', 'sardinha', 'common', [2, 2, 2, 2, 2, 2, 2, 2, 2])] };
const out = [];
(async () => {
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(require('os').tmpdir(), 'autotwish-')), { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  const errors = [];
  await ctx.route('**/*', async (route) => {
    const u = new URL(route.request().url()); const p = u.pathname;
    if (u.hostname.endsWith('twitch.tv')) return route.fulfill({ contentType: 'text/html', body: TWITCH_HTML });
    if (!u.hostname.endsWith('twish.com.br')) return route.continue();
    if (p.endsWith('/me/whitelist')) return route.fulfill({ json: { whitelist: WL.map((id) => ({ id })) } });
    if (p.endsWith('/me/inventory')) return route.fulfill({ json: INV });
    if (p.endsWith('/me')) return route.fulfill({ json: { channel: 'foo', login: 'x', cooldown_remaining: 300, equipment: {}, owned: {}, active: {}, whitelisted_fish_ids: WL } });
    if (p === '/api/me/challenge') return route.fulfill({ json: { state: 'none' } });
    if (p.endsWith('/events/active')) return route.fulfill({ json: { event: null, grande_evento: null } });
    if (p.endsWith('/expeditions')) return route.fulfill({ json: { rooms: [], voyages: [], mine: null } });
    return route.fulfill({ status: 404, json: { error: 'x' } });
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = sw.url().split('/')[2];
  const tw = await ctx.newPage(); tw.on('pageerror', (e) => errors.push('twitch: ' + e.message));
  await tw.goto('https://www.twitch.tv/foo'); await sleep(2000);
  await sw.evaluate(async () => { await mutateChannels((c) => { c.foo = { ...AT.DEFAULT_CHANNEL_SETTINGS }; }); });

  // configuracoes
  const opt = await ctx.newPage(); opt.on('pageerror', (e) => errors.push('options: ' + e.message));
  await opt.goto(`chrome-extension://${extId}/options.html`); await sleep(1500);
  const box = opt.locator('#generalProtect');
  out.push(`1 opções do campo: ${(await box.locator('.js-protect-tier option').allTextContents()).join(' | ')}`);
  await box.locator('.js-protect-enabled').check(); await sleep(300);
  await box.locator('.js-protect-tier').selectOption('mythic'); await sleep(2500);
  out.push(`  ligar + "Mítico em diante" -> salvo: ${JSON.stringify(await sw.evaluate(async () => (await browser.storage.local.get('general')).general.protection))} | resumo: ${await sw.evaluate(async () => AT.describeProtection(AT.sanitizeProtection((await browser.storage.local.get('general')).general.protection)))}`);
  await sleep(2000);
  out.push(`2 ao salvar, chat recebeu: ${JSON.stringify(await tw.evaluate(() => window.__sent))}`);
  // o "jogo" registrou
  WL = ['baleia', 'boitata'];
  await tw.evaluate(() => { window.__sent = []; });
  // pescou uma especie nova (mitica) -> confere depois da pesca
  INV = { ...INV, total: 14, fish: [...INV.fish, stack('tubarao_baleia', 'tubarão-baleia', 'mythic', [130])] };
  await tw.evaluate(() => { document.getElementById('inp').innerText = '$pescar'; }); await tw.click('#send');
  await sleep(500);
  const al = await sw.evaluate(async () => { const a = await browser.alarms.get('auto-twish-protect-catch:foo'); return a ? Math.round((a.scheduledTime - Date.now()) / 1000) : null; });
  await sleep(7500);
  out.push(`3 $pescar do jogador -> conferência agendada em ${al}s; chat recebeu: ${JSON.stringify(await tw.evaluate(() => window.__sent))}`);
  WL.push('tubarao_baleia'); await sleep(4000);
  out.push(`  status: ${await sw.evaluate(async () => { await syncProtection('foo', 'teste'); return (((await browser.storage.local.get('gameState')).gameState || {}).foo || {}).whitelist.lastMsg; })}`);
  // Inv Dump: limite Secreto, mas a Protecao (Mitico+) tambem segura
  const keep = await sw.evaluate(async () => { const g = await getGeneralSettings(); const p = AT.effectiveProtection(null, g); return AT.minTier('secret', p.enabled ? p.fromTier : null); });
  out.push(`4 Inv Dump com limite "Secreto em diante" + Proteção "Mítico em diante" -> nunca vende a partir de: ${keep}`);
  // lista + raridade juntos
  await opt.locator('#generalProtect .js-protect-input').fill('sardinha'); 
  await sw.evaluate(async () => { await mutateGeneral((g) => { g.protection = AT.sanitizeProtection({ ...g.protection, fish: [{ id: 'sardinha', name: 'sardinha' }] }); }); });
  await tw.evaluate(() => { window.__sent = []; });
  await sleep(4000); await sw.evaluate(() => syncProtection('foo', 'teste')); await sleep(4000);
  out.push(`5 lista (sardinha) + raridade -> chat recebeu: ${JSON.stringify(await tw.evaluate(() => window.__sent))}`);
  out.push(`erros nas paginas: ${errors.length ? errors.join(' | ') : 'nenhum'}`);
  console.log(out.join('\n')); await ctx.close(); process.exit(0);
})().catch((e) => { console.log(out.join('\n')); console.error(e); process.exit(1); });
