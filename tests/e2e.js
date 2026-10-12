// Teste de ponta a ponta no Chromium real com a extensao carregada.
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const EXT = path.resolve(process.argv[2]);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TWITCH_HTML = `<!doctype html><html><head><title>foo - Twitch</title></head><body>
<div data-a-target="chat-input"><div contenteditable="true" role="textbox" id="inp"></div></div>
<button data-a-target="chat-send-button" id="send">Chat</button>
<div data-test-selector="chat-scrollable-area__message-container" id="chat"></div>
<script>
  window.__sent = [];
  document.getElementById('send').addEventListener('click', () => {
    const i = document.getElementById('inp'); window.__sent.push(i.innerText.trim()); i.innerHTML = '';
  });
  window.__bot = (text) => {
    const line = document.createElement('div');
    line.innerHTML = '<span data-a-user="twishgamebot">TwishGameBot</span>: <span data-a-target="chat-line-message-body"></span>';
    line.querySelector('[data-a-target="chat-line-message-body"]').textContent = text;
    document.getElementById('chat').appendChild(line);
  };
</script></body></html>`;

(async () => {
  const out = [];
  const userDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'autotwish-'));
  const ctx = await chromium.launchPersistentContext(userDir, {
    channel: 'chromium',
    headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`]
  });
  const errors = [];
  // Twitch e Twish simulados (o container nao tem acesso a internet)
  await ctx.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if (u.hostname.endsWith('twitch.tv')) return route.fulfill({ contentType: 'text/html', body: TWITCH_HTML });
    if (u.hostname.endsWith('twish.com.br')) {
      if (u.pathname.endsWith('/events/active')) return route.fulfill({ json: { event: null, grande_evento: null } });
      if (u.pathname.endsWith('/me')) return route.fulfill({ json: { channel: 'foo', login: 'jogador_teste', cooldown_remaining: 0, twishcoins: 100, equipment: { rod_id: 'vara_aco' }, owned: {}, active: {} } });
      if (u.pathname === '/api/me/challenge') return route.fulfill({ json: { state: 'none' } });
      return route.fulfill({ status: 404, json: { error: 'x' } });
    }
    return route.continue();
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  const extId = sw.url().split('/')[2];
  out.push(`1 service worker: ${sw.url().split('/').pop()} | id=${extId}`);
  const env = await sw.evaluate(() => ({
    browser: typeof browser, AT: typeof AT, fila: typeof attemptSend, mercado: typeof marketCycle,
    protecao: typeof syncProtection, compras: typeof runShopping, kit: typeof runKitCheck, torneio: typeof checkTournament
  }));
  out.push(`  scripts carregados: ${JSON.stringify(env)}`);

  // alarme curto (shim) e alarme normal
  const al = await sw.evaluate(async () => {
    self.__fired = [];
    browser.alarms.onAlarm.addListener((a) => { if (a.name.startsWith('teste-')) self.__fired.push([a.name, Date.now()]); });
    const t0 = Date.now();
    await browser.alarms.create('teste-curto', { when: Date.now() + 2000 });
    const got = await browser.alarms.get('teste-curto');
    await new Promise((r) => setTimeout(r, 3000));
    const after = await chrome.alarms.get('teste-curto');
    return { agendado: got && Math.round((got.scheduledTime - t0) / 1000), disparou: self.__fired.map(([n, t]) => [n, ((t - t0) / 1000).toFixed(1) + 's']), reservaApagada: !after };
  });
  out.push(`2 alarme de 2 s (o Chrome sozinho atrasaria para 30 s): ${JSON.stringify(al)}`);

  // notificacao (precisa de icone no Chrome)
  const nt = await sw.evaluate(async () => {
    try { await browser.notifications.create('teste', { type: 'basic', title: 'Auto Twish', message: 'teste' }); return 'ok'; } catch (e) { return 'ERRO ' + e.message; }
  });
  out.push(`3 notificacao: ${nt}`);

  // pagina de configuracoes
  const opt = await ctx.newPage();
  opt.on('pageerror', (e) => errors.push('options: ' + e.message));
  opt.on('console', (m) => { if (m.type() === 'error') errors.push('options console: ' + m.text()); });
  await opt.goto(`chrome-extension://${extId}/options.html`);
  await sleep(1500);
  out.push(`4 configuracoes: versao="${await opt.textContent('#version')}" | blocos de automacao=${await opt.locator('#generalKit .kit-event').count()} | duelo regra=${await opt.inputValue('#generalDuel .js-duel-rule')}`);
  await opt.check('#notifyAutomations'); await sleep(500);
  const g = await sw.evaluate(async () => (await browser.storage.local.get('general')).general.notifyAutomations);
  out.push(`  marcar "Avisar quando uma automação agir" -> salvo no fundo: ${g}`);

  // canal + content script
  const tw = await ctx.newPage();
  tw.on('pageerror', (e) => errors.push('twitch: ' + e.message));
  await tw.goto('https://www.twitch.tv/foo');
  await sleep(2000);
  const pop = await ctx.newPage();
  pop.on('pageerror', (e) => errors.push('popup: ' + e.message));
  await pop.goto(`chrome-extension://${extId}/popup.html`);
  await sleep(1000);
  out.push(`5 popup aberto: titulo="${(await pop.textContent('h1')).trim()}"`);
  const res = await pop.evaluate(async () => browser.runtime.sendMessage({ type: 'SEND_NOW', channel: 'foo' }));
  await sleep(500);
  out.push(`6 "Enviar agora" no canal foo: resposta ok=${res && res.ok} | chat da Twitch recebeu=${JSON.stringify(await tw.evaluate(() => window.__sent))}`);

  // leitura do chat: convite de duelo do bot
  await sw.evaluate(async () => {
    const { general } = await browser.storage.local.get('general');
    await browser.storage.local.set({ general: { ...general, twishLogin: 'jogador_teste' } });
  });
  await sleep(300);
  await tw.evaluate(() => window.__bot('@fulano desafiou @jogador_teste pra um duelo! @jogador_teste tem 5m0s pra usar $aceitar.'));
  await sleep(1500);
  const inv = await sw.evaluate(async () => (((await browser.storage.local.get('gameState')).gameState || {}).foo || {}).duelInvite);
  out.push(`7 convite de duelo lido do chat: ${JSON.stringify(inv && { from: inv.from })}`);

  // fila: dois comandos seguidos
  await tw.evaluate(() => { window.__sent = []; });
  const t0 = Date.now();
  await Promise.all([
    pop.evaluate(() => browser.runtime.sendMessage({ type: 'SEND_CHAT_COMMAND', channel: 'foo', text: '$destaque' })),
    pop.evaluate(() => browser.runtime.sendMessage({ type: 'SEND_NOW', channel: 'foo' }))
  ]);
  out.push(`8 fila com dois comandos: ${JSON.stringify(await tw.evaluate(() => window.__sent))} em ${((Date.now() - t0) / 1000).toFixed(1)}s (intervalo de 2,5 a 5 s)`);

  out.push(`8b caminho usado: ${await tw.evaluate(() => typeof window.__autoTwishBusy === "boolean" ? "pagina (MAIN)" : "content script")}`);
  out.push(`9 erros nas paginas: ${errors.length ? errors.join(' | ') : 'nenhum'}`);
  console.log(out.join('\n'));
  await ctx.close();
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });
