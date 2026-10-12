// Contador de CD de duelo no popup.
const { chromium } = require('playwright'); const path = require('path'); const fs = require('fs');
const EXT = path.resolve(process.argv[2]); const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TWITCH_HTML = `<!doctype html><html><head><title>foo - Twitch</title></head><body>
<div data-a-target="chat-input"><div contenteditable="true" role="textbox" id="inp"></div></div>
<button data-a-target="chat-send-button" id="send">Chat</button><div data-test-selector="chat-scrollable-area__message-container" id="chat"></div>
<script>window.__bot=(t)=>{const l=document.createElement('div');l.innerHTML='<span data-a-user="twishgamebot">TwishGameBot</span>: <span data-a-target="chat-line-message-body"></span>';l.querySelector('[data-a-target="chat-line-message-body"]').textContent=t;document.getElementById('chat').appendChild(l);};</script></body></html>`;
let SETTINGS = { foo: { duel_cooldown_seconds: 1200, duels_enabled: true }, bar: null, baz: { duels_enabled: false } };
const out = [];
(async () => {
  const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(require('os').tmpdir(), 'autotwish-')), { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  const errors = [];
  await ctx.route('**/*', async (route) => {
    const u = new URL(route.request().url()); const p = u.pathname;
    if (u.hostname.endsWith('twitch.tv')) return route.fulfill({ contentType: 'text/html', body: TWITCH_HTML });
    if (!u.hostname.endsWith('twish.com.br')) return route.continue();
    const m = /^\/api\/(\w+)\/settings$/.exec(p);
    if (m) return route.fulfill({ json: { values: SETTINGS[m[1]] || {} } });
    if (p.endsWith('/events/active')) return route.fulfill({ json: { event: null, grande_evento: null } });
    if (p === '/api/me/challenge') return route.fulfill({ json: { state: 'none' } });
    return route.fulfill({ status: 404, json: { error: 'x' } });
  });
  const sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = sw.url().split('/')[2];
  await sw.evaluate(async () => { await mutateGeneral((g) => { g.twishLogin = 'jogador_teste'; }); });
  const pop = await ctx.newPage(); pop.on('pageerror', (e) => errors.push('popup: ' + e.message));
  await pop.goto(`chrome-extension://${extId}/popup.html`); await sleep(800);
  const line = async (ch) => { await pop.evaluate(async (ch) => { currentChannel = ch; await loadGame(); renderGame(); }, ch); await sleep(200); return `[${await pop.evaluate(() => document.getElementById('game').hidden ? 'área do jogo escondida' : 'visível')}] ${(await pop.textContent('#duelLine')).trim()}`; };

  out.push(`1 canal foo (CD do streamer 20 min), sem duelo visto -> ${await line('foo')}`);
  for (const ch of ['foo', 'bar']) {
    const tw = await ctx.newPage(); await tw.goto(`https://www.twitch.tv/${ch}`); await sleep(1500);
    await tw.evaluate(() => window.__bot('@jogador_teste venceu o duelo por W.O. contra @StreamElements (que não pescou nada) e ganhou 5 twishcoins de bônus! Saldo: 55.'));
    await sleep(1200);
  }
  out.push(`2 fim de duelo no chat de foo -> ${await line('foo')}`);
  out.push(`3 fim de duelo no chat de bar (configuração não legível: padrão 30 min) -> ${await line('bar')}`);
  await sw.evaluate(async () => { await mutateGameState('foo', (st) => { st.duelCooldownUntil = Date.now() - 1000; }); });
  out.push(`4 CD de foo acabou -> ${await line('foo')}`);
  out.push(`5 canal baz (duelos desligados pelo streamer) -> ${await line('baz')}`);
  await sw.evaluate(async () => { await mutateGameState('foo', (st) => { st.duelInvite = { from: 'fulano', expiresAt: Date.now() + 240000 }; }); });
  out.push(`6 convite pendente em foo -> ${await line('foo')}`);
  out.push(`erros nas paginas: ${errors.length ? errors.join(' | ') : 'nenhum'}`);
  console.log(out.join('\n')); await ctx.close(); process.exit(0);
})().catch((e) => { console.log(out.join('\n')); console.error(e); process.exit(1); });
