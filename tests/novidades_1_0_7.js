// Novidades da 1.0.7: leitor do chat reinjetado nas abas da Twitch (Chrome) e
// $pescar sem atraso no XP em Dobro / com Turbo ativo.
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs');
const EXT = path.resolve(process.argv[2]); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TWITCH_HTML = `<!doctype html><html><head><title>foo - Twitch</title></head><body>
<div data-a-target="chat-input"><div contenteditable="true" role="textbox" id="inp"></div></div>
<button data-a-target="chat-send-button" id="send">Chat</button><div data-test-selector="chat-scrollable-area__message-container" id="chat"></div>
<script>window.__bot=(t)=>{const l=document.createElement('div');l.innerHTML='<span data-a-user="twishgamebot">TwishGameBot</span>: <span data-a-target="chat-line-message-body"></span>';l.querySelector('[data-a-target="chat-line-message-body"]').textContent=t;document.getElementById('chat').appendChild(l);};
window.__sent=[];document.getElementById('send').addEventListener('click',()=>{const i=document.getElementById('inp');window.__sent.push(i.innerText.trim());i.innerHTML='';});</script></body></html>`;
let EVENTS = { event: null, grande_evento: null };
let ACTIVE = {};
let CD = 300;
const out = [];
(async () => {
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(require('os').tmpdir(), 'autotwish-')), { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  const errors = [];
  await ctx.route('**/*', async (route) => {
    const u = new URL(route.request().url()); const p = u.pathname;
    if (u.hostname.endsWith('twitch.tv')) return route.fulfill({ contentType: 'text/html', body: TWITCH_HTML });
    if (!u.hostname.endsWith('twish.com.br')) return route.continue();
    if (p.endsWith('/me')) return route.fulfill({ json: { channel: 'foo', login: 'jogador_teste', cooldown_remaining: CD, twishcoins: 100, equipment: { rod_id: 'vara_aco' }, owned: {}, active: ACTIVE } });
    if (p === '/api/me/challenge') return route.fulfill({ json: { state: 'none' } });
    if (p.endsWith('/events/active')) return route.fulfill({ json: EVENTS });
    if (p.endsWith('/expeditions')) return route.fulfill({ json: { rooms: [], voyages: [], mine: null } });
    return route.fulfill({ status: 404, json: { error: 'x' } });
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  await sw.evaluate(async () => {
    await mutateGeneral((g) => { g.twishLogin = 'jogador_teste'; g.defaultMaxJitterSeconds = 60; });
    await mutateChannels((c) => { c.foo = { ...AT.DEFAULT_CHANNEL_SETTINGS, enabled: true, mode: 'manual', nextFireAt: Date.now() + 3600000 }; });
  });
  const tw = await ctx.newPage(); tw.on('pageerror', (e) => errors.push('twitch: ' + e.message));
  await tw.goto('https://www.twitch.tv/foo'); await sleep(2500);
  const featured = () => sw.evaluate(async () => ((((await browser.storage.local.get('gameState')).gameState || {}).foo || {}).featured || {}).fish || null);

  // 1) leitor do chat
  out.push(`1 aba com o leitor ativo -> injetados: ${await sw.evaluate(() => ensureChatReaders('teste'))}`);
  // simula o leitor sem resposta so no 1o ping (a injecao entao "funciona")
  await sw.evaluate(() => { self.__origSend = browser.tabs.sendMessage; let n = 0; browser.tabs.sendMessage = async (...a) => { if (n++ === 0) throw new Error('Receiving end does not exist.'); return self.__origSend(...a); }; });
  const inj = await sw.evaluate(() => ensureChatReaders('teste'));
  await sw.evaluate(() => { browser.tabs.sendMessage = self.__origSend; });
  out.push(`  aba sem resposta (simulado) -> injetados: ${inj}`);
  // simula a injecao sem efeito (leitor continua mudo): recarrega a aba
  await sw.evaluate(() => { browser.tabs.sendMessage = async () => { throw new Error('Receiving end does not exist.'); }; });
  const navs = []; tw.on('framenavigated', (f) => { if (f === tw.mainFrame()) navs.push(f.url()); });
  await sw.evaluate(() => ensureChatReaders('teste', { reloadOnFail: true })); await sleep(3000);
  await sw.evaluate(() => { browser.tabs.sendMessage = self.__origSend; });
  out.push(`  injeção sem efeito, ao instalar/iniciar -> aba recarregada: ${navs.length > 0}`);
  await tw.evaluate(() => window.__bot('@jogador_teste Peixe em destaque: matrinxã. Pescou um? Ganha 50 twishcoins de bônus!')); await sleep(1500);
  out.push(`  depois da injeção, o destaque é lido: ${await featured()}`);
  out.push(`  alarme de conferência (1 min): ${await sw.evaluate(async () => { const a = await browser.alarms.get(CONTENT_CHECK_ALARM); return a ? a.periodInMinutes : null; })}`);

  // 2) sem atraso no XP em Dobro / Turbo
  const sched = () => sw.evaluate(async () => { const s = (await getAllChannelSettings()).foo; return Math.round((s.nextFireAt - s.twishAvailableAt) / 1000); });
  const many = async () => { const v = []; for (let i = 0; i < 8; i++) { await sw.evaluate(() => rescheduleTo('foo', Date.now() + 300000)); v.push(await sched()); } return v; };
  out.push(`2 sem evento (atraso de até 60 s) -> atrasos sorteados: ${JSON.stringify(await many())}`);
  EVENTS = { event: { name: 'XP em Dobro', kind: 'double_xp', seconds_remaining: 900 }, grande_evento: null };
  await sw.evaluate(() => rescheduleTo('foo', Date.now() + 300000));
  const before = await sched();
  await sw.evaluate(() => refreshEvents('foo', false)); await sleep(500);
  out.push(`  começou o XP em Dobro (agendado com atraso de ${before} s) -> atraso agora: ${await sched()} s | novos agendamentos: ${JSON.stringify(await many())}`);
  EVENTS = { event: null, grande_evento: null };
  await sw.evaluate(() => refreshEvents('foo', false));
  out.push(`  acabou o XP em Dobro -> atrasos sorteados: ${JSON.stringify(await many())}`);
  ACTIVE = { boost_remaining: 280 }; CD = 15;
  await sw.evaluate(() => rescheduleTo('foo', Date.now() + 15000));
  const b2 = await sched();
  await sw.evaluate(() => fetchTwishMe('foo')); await sleep(500);
  out.push(`  Turbo ativado por você (visto no /me; agendado com atraso de ${b2} s) -> atraso agora: ${await sched()} s | novos: ${JSON.stringify(await many())}`);
  ACTIVE = {};
  await sw.evaluate(() => fetchTwishMe('foo'));
  out.push(`  Turbo acabou -> atrasos sorteados: ${JSON.stringify(await many())}`);
  // o teste injeta de proposito numa aba com o leitor ativo: os avisos de "ja declarado" sao esperados la
  const real = errors.filter((e) => !/already been declared/.test(e));
  out.push(`erros nas paginas: ${real.length ? real.join(' | ') : 'nenhum'}`);
  console.log(out.join('\n')); await ctx.close(); process.exit(0);
})().catch((e) => { console.log(out.join('\n')); console.error(e); process.exit(1); });
