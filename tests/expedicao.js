// Teste da trava da Expedicao no Chromium com a extensao carregada.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const EXT = path.resolve(process.argv[2]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TWITCH_HTML = `<!doctype html><html><head><title>foo - Twitch</title></head><body>
<div data-a-target="chat-input"><div contenteditable="true" role="textbox" id="inp"></div></div>
<button data-a-target="chat-send-button" id="send">Chat</button>
<div data-test-selector="chat-scrollable-area__message-container" id="chat"></div>
<script>window.__bot=(t)=>{const l=document.createElement('div');l.innerHTML='<span data-a-user="twishgamebot">TwishGameBot</span>: <span data-a-target="chat-line-message-body"></span>';l.querySelector('[data-a-target="chat-line-message-body"]').textContent=t;document.getElementById('chat').appendChild(l);};window.__sent=[];document.getElementById('send').addEventListener('click',()=>{const i=document.getElementById('inp');window.__sent.push(i.innerText.trim());i.innerHTML='';});</script></body></html>`;

// estado da expedicao simulada
let EXP = { mine: null, voyage: null };
const voyage = (boat, secs, state = 'at_sea') => ({
  id: 'v1', sea: 'baia', kind: 'voyage', state, owner: 'outro', ends_at: 0, seconds_to_end: state === 'at_sea' ? secs : null,
  crew: [{ handle: 'outro', boat: 'zzz' }, { handle: 'jogador_teste', boat }]
});
let expCalls = 0; const out_g = [];

(async () => {
  const out = out_g;
  const userDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'autotwish-'));
  const ctx = await chromium.launchPersistentContext(userDir, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  const errors = [];
  await ctx.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.hostname.endsWith('twitch.tv')) return route.fulfill({ contentType: 'text/html', body: TWITCH_HTML });
    if (u.hostname.endsWith('twish.com.br')) {
      const p = u.pathname;
      if (/\/expeditions\/v1$/.test(p)) { expCalls++; return route.fulfill({ json: EXP.voyage || { error: 'expedition_not_found' }, status: EXP.voyage ? 200 : 404 }); }
      if (p.endsWith('/expeditions')) {
        expCalls++;
        const v = EXP.voyage && EXP.voyage.state === 'at_sea' ? [EXP.voyage] : [];
        return route.fulfill({ json: { rooms: [], voyages: v, mine: EXP.mine, released: true } });
      }
      if (p.endsWith('/events/active')) return route.fulfill({ json: { event: null, grande_evento: null } });
      if (p.endsWith('/me')) return route.fulfill({ json: { channel: 'foo', login: 'jogador_teste', cooldown_remaining: 0, twishcoins: 100, equipment: { rod_id: 'vara_aco' }, owned: {}, active: {} } });
      if (p === '/api/me/challenge') return route.fulfill({ json: { state: 'none' } });
      return route.fulfill({ status: 404, json: { error: 'x' } });
    }
    return route.continue();
  });
  let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = sw.url().split('/')[2];
  await sw.evaluate(async () => { const { general } = await browser.storage.local.get('general'); await browser.storage.local.set({ general: { ...(general || {}), twishLogin: 'jogador_teste' } }); });

  const tw = await ctx.newPage(); tw.on('pageerror', (e) => errors.push('twitch: ' + e.message));
  await tw.goto('https://www.twitch.tv/foo'); await sleep(2000);
  const pop = await ctx.newPage(); pop.on('pageerror', (e) => errors.push('popup: ' + e.message));
  pop.on('console', (m) => { if (m.type() === 'error') errors.push('popup console: ' + m.text()); });
  await pop.goto(`chrome-extension://${extId}/popup.html`); await sleep(800);

  const forget = () => sw.evaluate(async () => { expeditionState = null; await browser.storage.local.remove('expedition'); });
  const sendNow = async () => { await tw.evaluate(() => { window.__sent = []; }); const r = await pop.evaluate(() => browser.runtime.sendMessage({ type: 'SEND_NOW', channel: 'foo' })); await sleep(400); return `ok=${r.ok}${r.ok ? '' : ' motivo=' + r.reason} | chat recebeu=${JSON.stringify(await tw.evaluate(() => window.__sent))}`; };
  // popup "aberto" no canal foo (a pagina do teste nao e a aba ativa): carrega a linha direto
  const popupLine = async () => { await pop.evaluate(async () => { currentChannel = 'foo'; await loadExpedition(); }); const h = await pop.evaluate(() => document.getElementById('expeditionLine').hidden); return h ? '(escondida)' : await pop.textContent('#expeditionLine'); };

  out.push(`A sem expedicao -> Enviar agora em foo: ${await sendNow()}`);
  out.push(`  linha no popup: ${await popupLine()}`);

  await forget(); EXP = { mine: 'v1', voyage: voyage('bar', 1500) };
  out.push(`B no mar, zarpou por "bar" -> Enviar agora em foo: ${await sendNow()}`);
  out.push(`  linha no popup (foo): ${await popupLine()}`);
  const nf = await sw.evaluate(async () => { const st = (await browser.storage.local.get('expedition')).expedition; return { atSea: st.atSea, boat: st.boat, sea: st.sea, faltaMin: Math.round((st.endsAt - Date.now()) / 60000) }; });
  out.push(`  estado salvo: ${JSON.stringify(nf)}`);

  // processamento automatico: canal foo ativado e vencido -> deve ser empurrado para o fim
  const calls0 = expCalls;
  const auto = await sw.evaluate(async () => {
    await mutateChannels((c) => { c.foo = { ...AT.DEFAULT_CHANNEL_SETTINGS, ...(c.foo || {}), enabled: true, mode: 'auto', nextFireAt: Date.now() - 1000, awaitingUser: false }; });
    await processChannelIfDue('foo', 'teste');
    const s = (await getAllChannelSettings()).foo; const st = await readExpeditionState();
    return { adiadoAteFimDaViagem: s.nextFireAt >= st.endsAt, minutos: Math.round((s.nextFireAt - Date.now()) / 60000) };
  });
  out.push(`  pesca automatica em foo: ${JSON.stringify(auto)} | chat recebeu=${JSON.stringify(await tw.evaluate(() => window.__sent))} | consultas extras a API: ${expCalls - calls0} (estado em cache)`);

  await forget(); EXP = { mine: 'v1', voyage: voyage('foo', 1500) };
  out.push(`C no mar, zarpou por "foo" -> Enviar agora em foo: ${await sendNow()}`);
  out.push(`  linha no popup (foo): ${await popupLine()}`);

  await forget(); EXP = { mine: 'v1', voyage: voyage('bar', 0, 'open') };
  out.push(`D sala aberta (ainda nao zarpou) -> Enviar agora em foo: ${await sendNow()}`);

  // fim da viagem: no mar com 3 s restantes, depois a API diz que voltou
  await forget(); EXP = { mine: 'v1', voyage: voyage('bar', 3) };
  out.push(`E no mar, faltando 3 s -> ${await sendNow()}`);
  EXP = { mine: null, voyage: null };
  await sleep(3500);
  out.push(`  depois do fim -> Enviar agora em foo: ${await sendNow()}`);
  out.push(`  linha no popup: ${await popupLine()}`);
  const after = await sw.evaluate(async () => { const s = (await getAllChannelSettings()).foo; return { proximoEmS: Math.round((s.nextFireAt - Date.now()) / 1000) }; });
  out.push(`  foo reagendado normal: ${JSON.stringify(after)}`);

  // API sem resposta (sem login) no mar ja vencido: nao trava alem do fim previsto
  await sw.evaluate(async () => { expeditionState = { atSea: true, id: 'v1', sea: 'baia', boat: 'bar', endsAt: Date.now() - 1000, checkedAt: Date.now() - 600000 }; await browser.storage.local.set({ expedition: expeditionState }); });
  await ctx.unroute('**/*');
  await ctx.route('**/*', async (route) => { const u = new URL(route.request().url()); if (u.hostname.endsWith('twitch.tv')) return route.fulfill({ contentType: 'text/html', body: TWITCH_HTML }); if (u.hostname.endsWith('twish.com.br')) return route.fulfill({ status: 401, json: { error: 'login' } }); return route.continue(); });
  out.push(`F estado velho (fim ja passou) e API sem login -> ${await sendNow()}`);


  // G: so o chat (API sem login): mensagem real do bot no canal "bar"
  await forget();
  const tw2 = await ctx.newPage(); tw2.on('pageerror', (e) => errors.push('twitch2: ' + e.message));
  await tw2.goto('https://www.twitch.tv/bar'); await sleep(2000);
  await tw2.evaluate(() => window.__bot('⛵ Zarpou à Baía das Lendas: @outrocara, @jogador_teste e @fulano! Por 30 min o $pescar de vocês pesca no mar.'));
  await sleep(800);
  const gst = await sw.evaluate(async () => { const st = (await browser.storage.local.get('expedition')).expedition; return st && { atSea: st.atSea, boat: st.boat, sea: st.sea, source: st.source, faltaMin: Math.round((st.endsAt - Date.now()) / 60000) }; });
  out.push(`G mensagem "⛵ Zarpou à Baía das Lendas: ... @jogador_teste ..." no chat de bar -> estado: ${JSON.stringify(gst)}`);
  out.push(`  Enviar agora em foo (API sem login): ${await sendNow()}`);
  out.push(`  linha no popup (foo): ${await popupLine()}`);
  await tw2.evaluate(() => { window.__sent = []; });
  const rb = await pop.evaluate(() => browser.runtime.sendMessage({ type: 'SEND_NOW', channel: 'bar' })); await sleep(400);
  out.push(`  Enviar agora em bar (canal da expedicao): ok=${rb.ok} | chat de bar recebeu=${JSON.stringify(await tw2.evaluate(() => window.__sent))}`);

  // duelo: aceite automatico "sempre", convite em bar (canal da expedicao)
  const duel = await sw.evaluate(async () => {
    await mutateGeneral((g) => { g.duelAccept = { enabled: true, rule: 'always', minSeconds: 180 }; });
    await mutateGameState('bar', (st) => { st.duelInvite = { from: 'fulano', expiresAt: Date.now() + 300000 }; });
    const logs = []; const orig = console.log; console.log = (...a) => { logs.push(a.join(' ')); orig(...a); };
    await maybeAutoAcceptDuel('bar', 'fulano', Date.now() + 300000);
    console.log = orig; return logs.filter((l) => /Duelo/.test(l));
  });
  out.push(`  duelo em bar com aceite "sempre": ${JSON.stringify(duel)} | chat de bar recebeu=${JSON.stringify(await tw2.evaluate(() => window.__sent))}`);
  out.push(`  torneio: currentExpedition("bar") no mar? ${await sw.evaluate(async () => !!(await currentExpedition('bar', 'teste')))}`);

  // mensagem que nao marca o jogador: nao trava
  await forget();
  await tw2.evaluate(() => window.__bot('⛵ Zarpou à Mar das Sereias: @outrocara! Por 30 min o $pescar de vocês pesca no mar.'));
  await sleep(800);
  out.push(`H mensagem sem @jogador_teste -> estado: ${JSON.stringify(await sw.evaluate(async () => (await browser.storage.local.get('expedition')).expedition || null))} | Enviar agora em foo: ${await sendNow()}`);

  out.push(`erros nas paginas: ${errors.length ? errors.join(' | ') : 'nenhum'}`);
  console.log(out.join('\n'));
  await ctx.close(); process.exit(0);
})().catch((e) => { console.log(out_g.join("\n")); console.error(e); process.exit(1); });
