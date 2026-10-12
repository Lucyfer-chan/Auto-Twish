// Embarque automatico: Chromium com a extensao e Twitch/Twish simulados.
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs');
const EXT = path.resolve(process.argv[2]); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TWITCH_HTML = `<!doctype html><html><head><title>foo - Twitch</title></head><body>
<div data-a-target="chat-input"><div contenteditable="true" role="textbox" id="inp"></div></div>
<button data-a-target="chat-send-button" id="send">Chat</button><div data-test-selector="chat-scrollable-area__message-container" id="chat"></div>
<script>window.__bot=(t)=>{const l=document.createElement('div');l.innerHTML='<span data-a-user="twishgamebot">TwishGameBot</span>: <span data-a-target="chat-line-message-body"></span>';l.querySelector('[data-a-target="chat-line-message-body"]').textContent=t;document.getElementById('chat').appendChild(l);};
window.__sent=[];document.getElementById('send').addEventListener('click',()=>{const i=document.getElementById('inp');window.__sent.push(i.innerText.trim());i.innerHTML='';});</script></body></html>`;
const ME = 'jogador_teste';
let S = {}; // estado da simulacao
const reset = (o) => { S = { cd: 120, crew: [{ handle: 'dono', boat: 'x', confirmed: true }], owned: 1, deadline: 600, state: 'open', posts: [], ...o }; };
const out = [];
(async () => {
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(require('os').tmpdir(), 'autotwish-')), { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  const errors = [];
  await ctx.route('**/*', async (route) => {
    const req = route.request(); const u = new URL(req.url()); const p = u.pathname;
    if (u.hostname.endsWith('twitch.tv')) return route.fulfill({ contentType: 'text/html', body: TWITCH_HTML });
    if (!u.hostname.endsWith('twish.com.br')) return route.continue();
    let m;
    if ((m = /\/expeditions\/([0-9a-f-]{36})\/(join|ready)$/.exec(p)) && req.method() === 'POST') {
      S.posts.push(`${m[2]} ${req.postData() || '(sem corpo)'}`);
      if (m[2] === 'join') { if (S.joinError) return route.fulfill({ status: 409, json: { error: S.joinError } }); S.crew.push({ handle: ME, boat: 'foo', confirmed: false }); }
      else { const c = S.crew.find((x) => x.handle === ME); if (c) c.confirmed = true; }
      return route.fulfill({ json: { ok: true } });
    }
    if (/\/expeditions\/[0-9a-f-]{36}$/.test(p)) return route.fulfill({ json: { id: p.split('/').pop(), sea: 'baia', kind: 'voyage', state: S.state, seconds_to_deadline: S.deadline, crew: S.crew } });
    if (p.endsWith('/expeditions')) return route.fulfill({ json: { rooms: [], voyages: [], mine: null, boat_enabled: true, max_crew: 4, seas: [{ sea: 'baia', rod_ok: true, min_rod_name: 'Vara de Fibra de Vidro', entry_item_id: 'ticket_baia', entry_item_name: 'Ticket da Baía das Lendas', entry_quantity: 1, entry_owned: S.owned }] } });
    if (p.endsWith('/events/active')) return route.fulfill({ json: { event: null, grande_evento: null } });
    if (p.endsWith('/me')) return route.fulfill({ json: { channel: 'foo', login: ME, cooldown_remaining: S.cd, twishcoins: 500, equipment: { rod_id: 'vara_aco' }, owned: {}, active: {}, whitelisted_fish_ids: [] } });
    if (p === '/api/me/challenge') return route.fulfill({ json: { state: 'none' } });
    return route.fulfill({ status: 404, json: { error: 'x' } });
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = sw.url().split('/')[2];
  await sw.evaluate(async (me) => {
    await mutateGeneral((g) => { g.twishLogin = me; g.autoBoard = AT.sanitizeAutoBoard({ enabled: true, seas: { sereias: { enabled: false } } }); });
    await mutateChannels((c) => { c.foo = { ...AT.DEFAULT_CHANNEL_SETTINGS, enabled: true, mode: 'manual', nextFireAt: Date.now() + 3600000 }; });
  }, ME);
  const tw = await ctx.newPage(); tw.on('pageerror', (e) => errors.push('twitch: ' + e.message));
  await tw.goto('https://www.twitch.tv/foo'); await sleep(2000);
  let n = 0;
  const room = () => `aaaaaaaa-bbbb-cccc-dddd-${String(++n).padStart(12, '0')}`;
  const open = async (opener = 'dono', sea = 'à Baía das Lendas') => { const id = room(); await sw.evaluate(() => browser.storage.local.remove('boarding')); await tw.evaluate(({ id, opener, sea }) => window.__bot(`⛵ @${opener} abriu uma expedição ${sea}! Embarque pelo site em twish.com.br/c/${opener}/expedicoes/${id} — até 4 tripulantes, e a sala zarpa em 10 min.`), { id, opener, sea }); return id; };
  const st = () => sw.evaluate(async () => { const b = (await browser.storage.local.get('boarding')).boarding; return b ? `${b.phase}: ${b.lastMsg}` : '(nenhum)'; });

  reset({ cd: 120 });
  await open(); await sleep(6000);
  out.push(`A 3 vagas, pesca em 2:00 (folga) -> ${await st()} | POSTs: ${JSON.stringify(S.posts)}`);
  await tw.evaluate(() => { window.__sent = []; });
  await sw.evaluate(() => noteFishForBoarding('foo')); // a extensao pescou neste canal
  await sleep(7000);
  out.push(`  depois do $pescar -> ${await st()} | POSTs: ${JSON.stringify(S.posts)}`);

  reset({ cd: 120 });
  await open(); await sleep(6000);
  const w = await st();
  S.crew.push({ handle: 'b' }, { handle: 'c' }); // entraram mais dois: sobra 1 vaga
  await sw.evaluate(() => runBoarding('teste')); await sleep(3000);
  out.push(`A2 esperando a pesca (${w.split(':')[0]}), sala fica com 1 vaga -> ${await st()} | POSTs: ${JSON.stringify(S.posts)}`);

  reset({ cd: 120, crew: [{ handle: 'dono' }, { handle: 'b' }, { handle: 'c' }] });
  await open(); await sleep(7000);
  out.push(`B só 1 vaga, pesca em 2:00 -> ${await st()} | POSTs: ${JSON.stringify(S.posts)}`);

  reset({ cd: 590 });
  await open(); await sleep(7000);
  out.push(`C 3 vagas, pesca em 9:50 (sem folga) -> ${await st()} | POSTs: ${JSON.stringify(S.posts)}`);

  reset({ cd: 0, owned: 0, crew: [{ handle: 'dono' }, { handle: 'b' }, { handle: 'c' }] });
  await open(); await sleep(7000);
  out.push(`D sem ticket, compra desligada -> ${await st()} | POSTs: ${JSON.stringify(S.posts)}`);
  await sw.evaluate(() => mutateGeneral((g) => { g.autoBoard = AT.sanitizeAutoBoard({ ...g.autoBoard, seas: { ...g.autoBoard.seas, baia: { enabled: true, buy: true } } }); }));
  reset({ cd: 0, owned: 0, crew: [{ handle: 'dono' }, { handle: 'b' }, { handle: 'c' }] });
  await tw.evaluate(() => { window.__sent = []; });
  await open(); await sleep(14000);
  out.push(`  com "comprar o ticket" -> chat recebeu=${JSON.stringify(await tw.evaluate(() => window.__sent))} | ${await st()} | POSTs: ${JSON.stringify(S.posts)}`);

  reset({ cd: 0, crew: [{ handle: 'dono' }, { handle: 'b' }, { handle: 'c' }], joinError: 'in_tournament' });
  await open(); await sleep(7000);
  out.push(`E site recusa (em torneio) -> ${await st()}`);

  reset({});
  await open('dono', 'ao Mar das Sereias'); await sleep(4000);
  out.push(`F mar desmarcado (Sereias) -> ${await st()} | POSTs: ${JSON.stringify(S.posts)}`);
  reset({});
  await open(ME); await sleep(4000);
  out.push(`G sala aberta pelo próprio jogador -> ${await st()} | POSTs: ${JSON.stringify(S.posts)}`);

  // configuracoes
  const opt = await ctx.newPage(); opt.on('pageerror', (e) => errors.push('options: ' + e.message));
  await opt.goto(`chrome-extension://${extId}/options.html`); await sleep(1500);
  const box = opt.locator('#generalBoard');
  out.push(`H configurações: ligado=${await box.locator('input[type=checkbox]').first().isChecked()} | mares=${(await box.locator('.kit-tier > .check-row').allTextContents()).map((t) => t.trim()).join(', ')}`);
  await box.locator('.kit-tier').nth(2).locator('input[type=checkbox]').first().uncheck(); await sleep(400);
  out.push(`  desmarcar Abismo -> salvo: ${JSON.stringify(await sw.evaluate(async () => (await browser.storage.local.get('general')).general.autoBoard.seas.abismo))}`);
  out.push(`erros nas paginas: ${errors.length ? errors.join(' | ') : 'nenhum'}`);
  console.log(out.join('\n')); await ctx.close(); process.exit(0);
})().catch((e) => { console.log(out.join('\n')); console.error(e); process.exit(1); });
