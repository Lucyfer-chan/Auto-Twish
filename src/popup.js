// popup.js — popup reduzido: so o essencial do canal da aba ativa.
// Tudo e aplicado na hora (sem botao "Salvar"). O resto fica na pagina de
// configuracoes.

const $ = (id) => document.getElementById(id);
const enabledEl = $("enabled");
const modeEl = $("mode");
const modeButtons = [...modeEl.querySelectorAll("button[data-mode]")];
const modeHintEl = $("modeHint");
const rodFieldEl = $("rodField");
const rodEl = $("rod");
const channelLabelEl = $("channelLabel");
const twishStatusEl = $("twishStatus");
const statusEl = $("status");
const countdownEl = $("countdown");
const checkingEl = $("checking");

const MODE_HINTS = {
  manual: "Envia sozinho pelo tempo da vara + atraso. O Twish só é lido ao abrir o popup ou mudar algo.",
  auto: "Envia sozinho, seguindo o cooldown real da aba do Twish.",
  semi: "Quando o CD zera, digita o comando no chat e te chama — você aperta Enter."
};

$("version").textContent = `v ${browser.runtime.getManifest().version}`;
for (const rod of AT.ROD_DEFS) {
  const opt = document.createElement("option");
  opt.value = rod.id;
  opt.textContent = `${rod.name} — ${rod.minutes} min`;
  rodEl.appendChild(opt);
}

let currentChannel = null;
let current = null; // configuracoes do canal atual (como estao no background)
let heartbeatTarget = null;
let renderTimer = null;
let lastTwishSync = null; // { found, availableAt, rodId, at }
let gameState = {}; // { events, featured, duelInvite } do canal atual

// ---------------------------------------------------------------------------
// Desenho
// ---------------------------------------------------------------------------

function setControlsEnabled(on) {
  enabledEl.disabled = !on;
  rodEl.disabled = !on;
  for (const b of modeButtons) b.disabled = !on;
}

function renderSettings() {
  const s = current || AT.DEFAULT_CHANNEL_SETTINGS;
  enabledEl.checked = !!s.enabled;
  for (const b of modeButtons) b.setAttribute("aria-checked", String(b.dataset.mode === s.mode));
  modeHintEl.textContent = MODE_HINTS[s.mode] || "";
  rodFieldEl.hidden = s.mode !== "manual"; // a vara so aparece no modo manual
  rodEl.value = s.rod || AT.DEFAULT_ROD;
  renderCountdown();
}

function renderCountdown() {
  const s = current;
  checkingEl.textContent = "";
  if (!s || !s.enabled) {
    countdownEl.className = "countdown muted";
    countdownEl.textContent = currentChannel ? "Desativado — nenhum envio agendado." : "—";
    return;
  }
  if (s.awaitingUser) {
    countdownEl.className = "countdown waiting";
    countdownEl.textContent = `Pesca disponível — envie o ${AT.FISH_COMMAND} no chat`;
    return;
  }
  if (!s.nextFireAt) {
    countdownEl.className = "countdown muted";
    countdownEl.textContent = "Nenhum envio agendado.";
    return;
  }

  countdownEl.className = "countdown";
  const remaining = s.nextFireAt - Date.now();
  if (remaining > 0) {
    const verb = s.mode === "semi" ? "Próximo aviso" : "Próximo envio";
    countdownEl.textContent = `${verb} em: ${AT.formatRemaining(remaining)}`;
    return;
  }

  countdownEl.textContent = s.mode === "semi" ? "Preparando o aviso…" : "Próximo envio: agora…";
  if (heartbeatTarget && heartbeatTarget > Date.now()) {
    checkingEl.textContent = `Rede de segurança (fallback) em: ${AT.formatRemaining(heartbeatTarget - Date.now())}`;
  } else {
    refreshHeartbeatTarget();
  }
}

function formatClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

// Mostra se a aba do Twish desse canal foi encontrada na ultima
// sincronizacao e o que foi lido dela.
function renderTwishStatus() {
  const sync = lastTwishSync;
  if (!currentChannel) {
    twishStatusEl.textContent = "";
    return;
  }
  if (!sync) {
    twishStatusEl.textContent = "Twish: sincronizando…";
    twishStatusEl.className = "hint";
    return;
  }
  if (!sync.found) {
    twishStatusEl.textContent =
      `Twish: não consegui ler sua conta nem uma aba deste canal. Entre (faça login) no twish.com.br neste ${AT.browserName()}` +
      (current && AT.followsTwish(current.mode) ? " — até lá, vale a estimativa da vara." : ".");
    twishStatusEl.className = "hint stale";
    return;
  }

  const rod = sync.rodId ? "vara detectada" : "vara não detectada";
  if (sync.availableAt === null) {
    twishStatusEl.textContent = `Twish: aba encontrada, mas o título não foi reconhecido — usando a estimativa da vara; ${rod}.`;
    twishStatusEl.className = "hint stale";
    return;
  }
  const what =
    sync.availableAt <= sync.at + 1000
      ? "pesca disponível"
      : `cooldown de ${formatClock(sync.availableAt - sync.at)} no momento da leitura`;
  const via = sync.source === "api" ? "pela sua conta" : "pela aba";
  twishStatusEl.textContent = `Twish: sincronizado ${via} — ${what}; ${rod}.`;
  twishStatusEl.className = "hint ok";
}

async function refreshHeartbeatTarget() {
  try {
    const alarm = await browser.alarms.get(AT.HEARTBEAT_NAME);
    heartbeatTarget = alarm ? alarm.scheduledTime : null;
  } catch (e) {
    heartbeatTarget = null;
  }
}

// Redesenha 1x por segundo, alinhado na virada do segundo do contador.
function startTicking() {
  if (renderTimer) clearTimeout(renderTimer);
  const tick = () => {
    renderCountdown();
    renderGame();
    const target = current && current.nextFireAt;
    const ms = target ? ((target - Date.now()) % 1000 + 1000) % 1000 || 1000 : 1000;
    renderTimer = setTimeout(tick, ms + 5);
  };
  tick();
}

function ago(ms) {
  const min = Math.floor(ms / 60000);
  if (min < 1) return "agora há pouco";
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  return `há ${h} h`;
}

// Area "Jogo": evento ativo, peixe em destaque e convite de duelo.
function renderGame() {
  $("game").hidden = !currentChannel;
  if (!currentChannel) return;
  const now = Date.now();

  const ev = gameState.events;
  const items = [];
  if (ev) {
    const elapsed = now - (ev.fetchedAt || now);
    for (const item of [ev.grande_evento, ev.event]) {
      if (!item) continue;
      const remaining = item.seconds_remaining * 1000 - elapsed;
      if (remaining > 0) items.push({ item, remaining });
    }
  }
  const eventLine = $("eventLine");
  eventLine.hidden = items.length === 0;
  eventLine.textContent = "";
  for (const { item, remaining } of items) {
    const span = document.createElement("span");
    span.append(`${item.emoji || "🎉"} `);
    const strong = document.createElement("strong");
    strong.textContent = item.name;
    span.append(strong, ` — termina em ${AT.formatRemaining(remaining)}`);
    eventLine.append(span);
  }

  const f = gameState.featured;
  $("featuredFish").textContent = f ? f.fish : "—";
  $("featuredAge").textContent = f ? `(${ago(now - f.seenAt)})` : "";

  // Duelo: convite pendente tem prioridade; senao, cooldown de duelo.
  const duel = gameState.duelInvite;
  const duelLine = $("duelLine");
  const duelLeft = duel ? duel.expiresAt - now : 0;
  const cdLeft = gameState.duelCooldownUntil ? gameState.duelCooldownUntil - now : 0;
  duelLine.textContent = "";
  duelLine.classList.toggle("warn", duelLeft > 0);
  if (duel && duelLeft > 0) {
    const span = document.createElement("span");
    const strong = document.createElement("strong");
    strong.textContent = `⚔️ @${duel.from} te desafiou`;
    span.append(strong, ` — ${AT.formatRemaining(duelLeft)} pra usar $aceitar`);
    duelLine.append(span);
    duelLine.hidden = false;
  } else if (cdLeft > 0) {
    const span = document.createElement("span");
    span.className = "label";
    span.textContent = `⚔️ Próximo duelo em ${AT.formatRemaining(cdLeft)}`;
    duelLine.append(span);
    duelLine.hidden = false;
  } else {
    duelLine.hidden = true;
  }
}

async function loadGame() {
  if (!currentChannel) return;
  try {
    const { state } = await browser.runtime.sendMessage({ type: "GET_GAME_STATE", channel: currentChannel });
    gameState = state || {};
  } catch (e) {
    gameState = {};
  }
  renderGame();
}

// ---------------------------------------------------------------------------
// Comunicacao com o background
// ---------------------------------------------------------------------------

// Busca dado fresco na aba do Twish (cooldown real + vara equipada).
async function syncTwish() {
  if (!currentChannel) return;
  try {
    const { settings, twish } = await browser.runtime.sendMessage({
      type: "SYNC_TWISH_FOR_CHANNEL",
      channel: currentChannel
    });
    lastTwishSync = twish ? { ...twish, at: Date.now() } : null;
    if (settings) {
      current = settings;
    } else if (twish?.rodId) {
      // Canal ainda nao salvo: so pre-seleciona a vara detectada.
      current = { ...(current || AT.DEFAULT_CHANNEL_SETTINGS), rod: twish.rodId };
    }
    renderSettings();
    renderTwishStatus();
  } catch (e) {
    // falha pontual; o status fica como esta
  }
}

// Manda so o que mudou; o background aplica e devolve o estado novo.
async function update(patch) {
  if (!currentChannel) return;
  setControlsEnabled(false);
  try {
    const { settings } = await browser.runtime.sendMessage({
      type: "UPDATE_CHANNEL_SETTINGS",
      channel: currentChannel,
      settings: patch
    });
    current = settings;
    renderSettings();
    statusEl.textContent = settings.enabled ? "Aplicado." : "Aplicado (desativado).";
  } catch (e) {
    statusEl.textContent = "Falha ao aplicar a alteração.";
  } finally {
    setControlsEnabled(true);
  }
  syncTwish(); // atualiza a linha de status do Twish
}

// O popup e avisado quando algo muda (envio feito, reagendamento...), em
// vez de perguntar ao background a cada segundo.
async function renderSafety() {
  try {
    const { safety } = await browser.runtime.sendMessage({ type: "GET_SAFETY" });
    $("safetyLine").hidden = !(safety && safety.locked);
  } catch (e) {}
}

// Expedicao: no mar, o $pescar so sai no canal por onde o jogador zarpou.
let expedition = null;
let expeditionTimer = null;

function renderExpedition() {
  const line = $("expeditionLine");
  const st = expedition;
  if (!st || !st.atSea || Date.now() >= st.endsAt) {
    line.hidden = true;
    return;
  }
  const sea = (st.sea && AT.EXPEDITION_SEAS[st.sea]) || st.seaName || "expedição";
  const until = new Date(st.endsAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const here = st.boat && currentChannel && st.boat === currentChannel;
  line.textContent = "";
  line.append("⚓ ");
  const strong = document.createElement("strong");
  strong.textContent = `Em expedição — ${sea}`;
  line.append(strong);
  line.append(
    here
      ? `. Você zarpou por este canal: aqui a pesca continua. Nos outros canais o $pescar volta às ${until}.`
      : st.boat
        ? `, pelo canal ${st.boat}. $pescar pausado aqui até ${until} (volta sozinho).`
        : `. $pescar pausado até ${until} (volta sozinho).`
  );
  line.hidden = false;
}

// Embarque automatico: estado da sala que a extensao esta cuidando.
async function renderBoarding() {
  const line = $("boardLine");
  try {
    const { boarding: b } = await browser.storage.local.get("boarding");
    const show = b && b.lastMsg && ["waiting", "joined", "ready"].includes(b.phase) && Date.now() < (b.deadlineAt || 0) + 60000;
    line.hidden = !show;
    if (show) line.textContent = `⛵ Embarque (${b.channel}): ${b.lastMsg}`;
  } catch (e) {}
}

async function loadExpedition() {
  renderBoarding();
  try {
    const r = await browser.runtime.sendMessage({ type: "GET_EXPEDITION", channel: currentChannel || null });
    expedition = r && r.expedition;
  } catch (e) {}
  renderExpedition();
  clearInterval(expeditionTimer);
  expeditionTimer = setInterval(renderExpedition, 15000); // esconde sozinha quando a viagem acaba
}

browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.safety) renderSafety();
  if (area === "local" && changes.boarding) renderBoarding();
  if (area === "local" && changes.expedition) {
    expedition = changes.expedition.newValue || null;
    renderExpedition();
  }
  if (area === "local" && changes.gameState && currentChannel) {
    gameState = (changes.gameState.newValue || {})[currentChannel] || {};
    renderGame();
  }
  if (area !== "local" || !changes.channels || !currentChannel) return;
  const s = (changes.channels.newValue || {})[currentChannel];
  if (s) {
    current = { ...AT.DEFAULT_CHANNEL_SETTINGS, ...s };
    renderSettings();
  }
});

// ---------------------------------------------------------------------------
// Eventos da interface
// ---------------------------------------------------------------------------

enabledEl.addEventListener("change", () => update({ enabled: enabledEl.checked }));

for (const b of modeButtons) {
  b.addEventListener("click", () => {
    if (current && current.mode === b.dataset.mode) return;
    update({ mode: b.dataset.mode });
  });
}

rodEl.addEventListener("change", () => update({ rod: rodEl.value }));

$("askFeatured").addEventListener("click", async () => {
  if (!currentChannel) return;
  const btn = $("askFeatured");
  btn.disabled = true;
  const r = await browser.runtime.sendMessage({ type: "SEND_CHAT_COMMAND", channel: currentChannel, text: "$destaque" });
  statusEl.textContent = r?.ok ? "$destaque enviado — a resposta aparece aqui." : `Falha ao enviar $destaque (${r?.reason || "?"}).`;
  setTimeout(() => (btn.disabled = false), 5000);
});

const openOptions = () => {
  browser.runtime.openOptionsPage();
  window.close();
};
$("openOptions").addEventListener("click", openOptions);
$("gear").addEventListener("click", openOptions);

async function getActiveTabUrl() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab?.url || "";
}

async function load() {
  const url = await getActiveTabUrl();
  const { channel, settings } = await browser.runtime.sendMessage({ type: "GET_SETTINGS_FOR_ACTIVE_TAB", url });
  currentChannel = channel;
  loadExpedition(); // nao espera: le da conta se o estado estiver velho

  if (!channel) {
    channelLabelEl.textContent = "Abra a aba de um canal da Twitch (ex: twitch.tv/seucanal) para configurar.";
    channelLabelEl.classList.add("muted");
    setControlsEnabled(false);
    current = null;
    renderSettings();
    startTicking();
    return;
  }

  channelLabelEl.innerHTML = "";
  channelLabelEl.append("Canal detectado: ");
  const strong = document.createElement("strong");
  strong.textContent = channel;
  channelLabelEl.append(strong);
  channelLabelEl.classList.remove("muted");
  setControlsEnabled(true);

  current = settings;
  renderSettings();
  renderTwishStatus();
  await refreshHeartbeatTarget();
  startTicking();
  loadGame();
  await syncTwish(); // le o Twish assim que o popup abre
}

renderSafety();
load();
