// Novidades da 1.0.4: registro, estatisticas, backup, destaque, remedios, seguro, Grande Evento, versao nova.
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs');
const EXT = path.resolve(process.argv[2]); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TWITCH_HTML = `<!doctype html><html><head><title>foo - Twitch</title></head><body>
<div data-a-target="chat-input"><div contenteditable="true" role="textbox" id="inp"></div></div>
<button data-a-target="chat-send-button" id="send">Chat</button><div data-test-selector="chat-scrollable-area__message-container" id="chat"></div>
<script>window.__sent=[];document.getElementById('send').addEventListener('click',()=>{const i=document.getElementById('inp');window.__sent.push(i.innerText.trim());i.innerHTML='';});</script></body></html>`;
let ME = { casts: 100, points: 500, xp: 1000, level: 5, twishcoins: 300, duel_wins: 2, tournament_victories: 0, active: {}, items: {} };
let EVENTS = { event: null, grande_evento: null };
const POSTS = [];
const out = [];
(async () => {
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(require('os').tmpdir(), 'autotwish-')), { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  const errors = [];
  await ctx.route('**/*', async (route) => {
    const req = route.request(); const u = new URL(req.url()); const p = u.pathname;
    if (u.hostname.endsWith('twitch.tv')) return route.fulfill({ contentType: 'text/html', body: TWITCH_HTML });
    if (u.hostname === 'api.github.com') return route.fulfill({ json: [{ name: 'v 1.0.3' }, { name: 'v 1.1.0' }, { name: 'teste' }, { name: 'v1.0.9' }] });
    if (!u.hostname.endsWith('twish.com.br')) return route.continue();
    if (req.method() === 'POST') { POSTS.push(p); if (/\/me\/use\//.test(p)) ME.active = {}; return route.fulfill({ json: { ok: true } }); }
    if (p.endsWith('/me')) return route.fulfill({ json: { channel: 'foo', login: 'x', cooldown_remaining: 300, casts: ME.casts, points: ME.points, xp: ME.xp, level: ME.level, twishcoins: ME.twishcoins, duel_wins: ME.duel_wins, tournament_victories: ME.tournament_victories, equipment: {}, owned: { items: ME.items }, active: ME.active } });
    if (p.endsWith('/events/active')) return route.fulfill({ json: EVENTS });
    if (p === '/api/me/challenge') return route.fulfill({ json: { state: 'none' } });
    if (p.endsWith('/expeditions')) return route.fulfill({ json: { rooms: [], voyages: [], mine: null } });
    return route.fulfill({ status: 404, json: { error: 'x' } });
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = sw.url().split('/')[2];
  const tw = await ctx.newPage(); tw.on('pageerror', (e) => errors.push('twitch: ' + e.message));
  await tw.goto('https://www.twitch.tv/foo'); await sleep(2000);
  const sent = async () => { const s = await tw.evaluate(() => window.__sent); await tw.evaluate(() => { window.__sent = []; }); return JSON.stringify(s); };
  await sw.evaluate(async () => {
    self.__notes = []; const orig = browser.notifications.create.bind(browser.notifications);
    browser.notifications.create = async (id, o) => { self.__notes.push(o.title); return orig(id, o); };
    await mutateChannels((c) => { c.foo = { ...AT.DEFAULT_CHANNEL_SETTINGS, enabled: true, mode: 'manual', nextFireAt: Date.now() + 3600000 }; });
  });

  // 1) $destaque automatico
  await sw.evaluate(() => mutateGeneral((g) => { g.autoFeatured = { enabled: true }; }));
  await sw.evaluate(() => maybeAutoFeatured('foo', 'teste')); await sleep(600);
  out.push(`1 destaque automático (sem o do dia) -> chat: ${await sent()}`);
  await sw.evaluate(() => maybeAutoFeatured('foo', 'teste')); await sleep(300);
  out.push(`  logo de novo (já pediu, resposta ainda não lida) -> chat: ${await sent()}`);
  await sw.evaluate(() => onFeaturedFish('foo', 'matrinxã'));
  await sw.evaluate(async () => { await mutateGameState('foo', (st) => { st.featuredAsk = null; }); await maybeAutoFeatured('foo', 'teste'); }); await sleep(300);
  out.push(`  com o destaque de hoje já lido -> chat: ${await sent()}`);
  await sw.evaluate(async () => { await mutateGameState('foo', (st) => { st.featured.seenAt = AT.gameDayStart() - 60000; st.featuredAsk = null; }); await maybeAutoFeatured('foo', 'teste'); }); await sleep(600);
  out.push(`  destaque lido antes das 00:30 de hoje (dia novo) -> chat: ${await sent()}`);

  // 2) remedios
  ME.active = { siren_remaining: 3000, curse_remaining: 0 }; ME.items = {};
  await sw.evaluate(() => mutateGeneral((g) => { g.autoRemedy = AT.sanitizeAutoRemedy({ enabled: true, buy: false }); }));
  await sw.evaluate(() => runRemedy('foo', 'teste')); await sleep(300);
  out.push(`2 Canto da Sereia, sem alga, compra desligada -> chat: ${await sent()} | POSTs: ${JSON.stringify(POSTS)} | ${await sw.evaluate(async () => (((await browser.storage.local.get('gameState')).gameState || {}).foo || {}).remedy.lastMsg)}`);
  await sw.evaluate(() => mutateGeneral((g) => { g.autoRemedy = AT.sanitizeAutoRemedy({ ...g.autoRemedy, buy: true }); }));
  await sw.evaluate(() => runRemedy('foo', 'teste')); await sleep(300);
  out.push(`  com compra ligada -> chat: ${await sent()} | POSTs: ${JSON.stringify(POSTS)}`);
  POSTS.length = 0; ME.active = { curse_remaining: 900 }; ME.items = { agua_benta: 1 };
  await sw.evaluate(() => runRemedy('foo', 'teste')); await sleep(300);
  out.push(`  Maldição, com Água benta no inventário -> chat: ${await sent()} | POSTs: ${JSON.stringify(POSTS)}`);

  // 3) seguro no embarque
  ME.items = {};
  await sw.evaluate(async () => { await mutateGeneral((g) => { g.autoBoard = AT.sanitizeAutoBoard({ enabled: true, seas: { abismo: { insure: true } } }); }); await browser.storage.local.set({ boarding: { channel: 'foo', phase: 'joined' } }); await ensureInsurance('foo', 'abismo'); await ensureInsurance('foo', 'baia'); });
  await sleep(300);
  out.push(`3 seguro: Abismo (ligado) e Baía (sem seguro) -> chat: ${await sent()}`);
  ME.items = { seguro_abismo: 1 };
  await sw.evaluate(() => ensureInsurance('foo', 'abismo')); await sleep(300);
  out.push(`  já com o seguro no inventário -> chat: ${await sent()}`);

  // 4) Grande Evento
  await sw.evaluate(() => mutateChannels((c) => { c.foo.notifyEvents = false; c.foo.notifyBigEvents = true; }));
  EVENTS = { event: { name: 'XP em Dobro', kind: 'double_xp', seconds_remaining: 500 }, grande_evento: { name: 'Invasão Pirata', emoji: '🏴‍☠️', seconds_remaining: 900, message: 'Piratas à vista!' } };
  await sw.evaluate(() => refreshEvents('foo', false)); // o popup consultou antes (nao avisa)
  await sw.evaluate(() => pollEvents()); await sleep(300);
  out.push(`4 Grande Evento (aviso de evento desligado, de Grande Evento ligado; popup consultou antes) -> notificações: ${JSON.stringify(await sw.evaluate(() => self.__notes.filter((t) => /Evento|XP/.test(t))))}`);
  await sw.evaluate(() => pollEvents()); await sleep(300);
  out.push(`  consulta seguinte (mesmo evento) -> notificações: ${await sw.evaluate(() => self.__notes.filter((t) => /Evento|XP/.test(t)).length)} no total`);

  // 5) estatisticas
  await sw.evaluate(async () => { statsLastWrite.clear(); await fetchTwishMe('foo'); });
  ME.casts = 112; ME.points = 590; ME.xp = 1150; ME.twishcoins = 260; ME.duel_wins = 3;
  await sw.evaluate(async () => { statsLastWrite.clear(); await fetchTwishMe('foo'); countStat('foo', 'pescarExt'); countStat('foo', 'pescarExt'); countStat('foo', 'pescarVoce'); });
  await sleep(500);
  const st = await ctx.newPage(); st.on('pageerror', (e) => errors.push('stats: ' + e.message));
  st.on('console', (m) => { if (m.type() === 'error') errors.push('stats console: ' + m.text()); });
  await st.goto(`chrome-extension://${extId}/stats.html`); await sleep(1200);
  const rows = await st.evaluate(() => [...document.querySelectorAll('#statsTable tr')].map((tr) => [...tr.children].map((c) => c.textContent).join(' | ')));
  out.push(`5 estatísticas (hoje):\n    ${rows.join('\n    ')}`);
  out.push(`  registros no período: ${await st.textContent('#actions')}`);
  const log = await st.evaluate(() => [...document.querySelectorAll('#log li')].slice(0, 6).map((li) => li.textContent.replace(/\s+/g, ' ').trim()));
  out.push(`6 atividades (mais novas primeiro):\n    ${log.join('\n    ')}`);
  await st.selectOption('#fKind', 'remédio'); await sleep(200);
  out.push(`  filtro "remédio": ${await st.evaluate(() => document.querySelectorAll('#log li').length)} registro(s)`);

  // 7) backup
  const opt = await ctx.newPage(); opt.on('pageerror', (e) => errors.push('options: ' + e.message));
  await opt.goto(`chrome-extension://${extId}/options.html`); await sleep(1500);
  const exp = await opt.evaluate(() => browser.runtime.sendMessage({ type: 'EXPORT_SETTINGS' }));
  out.push(`7 exportar -> ok=${exp.ok} | canais=${Object.keys(exp.data.channels)} | campos de execução no backup? ${'nextFireAt' in exp.data.channels.foo ? 'SIM (erro)' : 'não'} | destaque=${JSON.stringify(exp.data.general.autoFeatured)}`);
  await sw.evaluate(async () => { await mutateGeneral((g) => { g.autoFeatured = { enabled: false }; g.defaultMaxJitterSeconds = 77; }); await mutateChannels((c) => { c.foo.mode = 'auto'; }); });
  const imp = await opt.evaluate((data) => browser.runtime.sendMessage({ type: 'IMPORT_SETTINGS', data }), exp.data);
  const after = await sw.evaluate(async () => { const g = await getGeneralSettings(); const c = (await getAllChannelSettings()).foo; return { destaque: g.autoFeatured.enabled, atraso: g.defaultMaxJitterSeconds, modo: c.mode, nextFireAt: !!c.nextFireAt }; });
  out.push(`  mudei 3 coisas e importei -> ${JSON.stringify(imp)} | depois: ${JSON.stringify(after)}`);
  const bad = await opt.evaluate(() => browser.runtime.sendMessage({ type: 'IMPORT_SETTINGS', data: { foo: 1 } }));
  out.push(`  arquivo que não é backup -> ${JSON.stringify(bad)}`);
  out.push(`  botões na página: ${await opt.locator('#exportBtn').isVisible()} / ${await opt.locator('#importBtn').isVisible()} | link estatísticas: ${await opt.locator('a[href="stats.html"]').count()}`);
  const dl = opt.waitForEvent('download', { timeout: 5000 }).catch(() => null);
  await opt.click('#exportBtn'); const d = await dl;
  out.push(`  clique em Exportar -> arquivo: ${d ? d.suggestedFilename() : 'nenhum'}`);

  // 8) versao nova + popup
  await sw.evaluate(async () => { AT.UPDATE_REPO = 'dono/auto-twish'; await checkForUpdate('teste'); });
  const pop = await ctx.newPage(); pop.on('pageerror', (e) => errors.push('popup: ' + e.message));
  await pop.goto(`chrome-extension://${extId}/popup.html`); await sleep(1000);
  out.push(`8 versão nova -> popup: "${(await pop.textContent('#updateLine')).trim()}" (visível: ${await pop.locator('#updateLine').isVisible()}) | link: ${await pop.getAttribute('#updateLine a', 'href')}`);
  out.push(`  acesso ao twish.com.br concedido -> aviso escondido: ${await pop.locator('#accessLine').isHidden()} | botão estatísticas: ${await pop.locator('#openStats').isVisible()}`);
  out.push(`erros nas paginas: ${errors.length ? errors.join(' | ') : 'nenhum'}`);
  console.log(out.join('\n')); await ctx.close(); process.exit(0);
})().catch((e) => { console.log(out.join('\n')); console.error(e); process.exit(1); });
