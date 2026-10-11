// options.js — pagina de configuracoes (abre numa aba propria).
// Configuracoes gerais + a lista de todos os canais configurados.
// Tudo e aplicado na hora, sem botao "Salvar".

const $ = (id) => document.getElementById(id);
const channelsEl = $("channels");
const template = $("channelTemplate");
const defaultJitterEl = $("defaultJitter");
const defaultJitterValueEl = $("defaultJitterValue");
const semiFocusEl = $("semiFocus");
const semiNotifyEl = $("semiNotify");
const notifyDuelEl = $("notifyDuel");

$("version").textContent = `v ${browser.runtime.getManifest().version}`;

let state = { general: AT.mergeGeneral(null), channels: {} };
const cards = new Map(); // canal -> { root, els }

// ---------------------------------------------------------------------------
// Configuracoes gerais
// ---------------------------------------------------------------------------

function renderGeneral() {
  const g = state.general;
  if (document.activeElement !== defaultJitterEl) defaultJitterEl.value = g.defaultMaxJitterSeconds;
  defaultJitterValueEl.textContent = `${defaultJitterEl.value}s`;
  semiFocusEl.checked = !!g.semiAuto.focusTab;
  semiNotifyEl.checked = !!g.semiAuto.notify;
  notifyDuelEl.checked = !!g.notifyDuelInvites;
  $("loginInfo").textContent = g.twishLogin ? `conta reconhecida: ${g.twishLogin}` : "ainda não lida (abra o popup num canal estando logado no twish.com.br)";
}

async function updateGeneral(patch) {
  const { general } = await browser.runtime.sendMessage({ type: "UPDATE_GENERAL_SETTINGS", patch });
  state.general = general;
  renderGeneral();
  for (const name of cards.keys()) renderCard(name);
}

defaultJitterEl.addEventListener("input", () => {
  defaultJitterValueEl.textContent = `${defaultJitterEl.value}s`;
});
defaultJitterEl.addEventListener("change", () => updateGeneral({ defaultMaxJitterSeconds: Number(defaultJitterEl.value) }));
semiFocusEl.addEventListener("change", () => updateGeneral({ semiAuto: { focusTab: semiFocusEl.checked } }));
semiNotifyEl.addEventListener("change", () => updateGeneral({ semiAuto: { notify: semiNotifyEl.checked } }));
notifyDuelEl.addEventListener("change", () => updateGeneral({ notifyDuelInvites: notifyDuelEl.checked }));

// ---------------------------------------------------------------------------
// Canais
// ---------------------------------------------------------------------------

async function updateChannel(name, patch) {
  const { settings } = await browser.runtime.sendMessage({ type: "UPDATE_CHANNEL_SETTINGS", channel: name, settings: patch });
  state.channels[name] = settings;
  renderCard(name);
}

function clockText(s) {
  if (!s.enabled) return { text: "Desativado", cls: "countdown muted" };
  if (s.awaitingUser) return { text: `Pesca disponível — esperando você enviar o ${AT.FISH_COMMAND}`, cls: "countdown waiting" };
  if (!s.nextFireAt) return { text: "Nenhum envio agendado", cls: "countdown muted" };
  const remaining = s.nextFireAt - Date.now();
  const verb = s.mode === "semi" ? "Próximo aviso" : "Próximo envio";
  return remaining > 0
    ? { text: `${verb} em ${AT.formatRemaining(remaining)}`, cls: "countdown" }
    : { text: `${verb}: agora…`, cls: "countdown" };
}

function createCard(name) {
  const root = template.content.firstElementChild.cloneNode(true);
  const q = (sel) => root.querySelector(sel);
  const els = {
    name: q(".channel-name"),
    clock: q(".channel-clock"),
    enabled: q(".js-enabled"),
    modeButtons: [...root.querySelectorAll(".js-mode button")],
    rodField: q(".js-rod-field"),
    rod: q(".js-rod"),
    notifyEvents: q(".js-notify-events"),
    jitterDefault: q(".js-jitter-default"),
    defaultValue: q(".js-default-value"),
    jitterRow: q(".js-jitter-row"),
    jitter: q(".js-jitter"),
    jitterValue: q(".js-jitter-value"),
    test: q(".js-test"),
    actionStatus: q(".js-action-status"),
    remove: q(".js-remove")
  };

  els.name.textContent = name;
  els.name.href = `https://www.twitch.tv/${encodeURIComponent(name)}`;
  for (const rod of AT.ROD_DEFS) {
    const opt = document.createElement("option");
    opt.value = rod.id;
    opt.textContent = `${rod.name} — ${rod.minutes} min`;
    els.rod.appendChild(opt);
  }

  els.enabled.addEventListener("change", () => updateChannel(name, { enabled: els.enabled.checked }));
  for (const b of els.modeButtons) {
    b.addEventListener("click", () => {
      if (state.channels[name]?.mode !== b.dataset.mode) updateChannel(name, { mode: b.dataset.mode });
    });
  }
  els.rod.addEventListener("change", () => updateChannel(name, { rod: els.rod.value }));
  els.notifyEvents.addEventListener("change", () => updateChannel(name, { notifyEvents: els.notifyEvents.checked }));

  els.jitterDefault.addEventListener("change", () => {
    // Desmarcar cria uma excecao comecando no valor padrao atual.
    updateChannel(name, {
      maxJitterSeconds: els.jitterDefault.checked ? null : state.general.defaultMaxJitterSeconds
    });
  });
  els.jitter.addEventListener("input", () => {
    els.jitterValue.textContent = `${els.jitter.value}s`;
  });
  els.jitter.addEventListener("change", () => updateChannel(name, { maxJitterSeconds: Number(els.jitter.value) }));

  els.test.addEventListener("click", async () => {
    els.test.disabled = true;
    els.actionStatus.textContent = "Enviando…";
    const result = await browser.runtime.sendMessage({ type: "SEND_NOW", channel: name });
    els.actionStatus.textContent = result?.ok
      ? "Enviado. Confira o chat."
      : `Falha ao enviar (${result?.reason || "motivo desconhecido"}). A aba do canal na Twitch está aberta?`;
    els.test.disabled = false;
  });

  // Remover pede um segundo clique pra confirmar.
  let confirmTimer = null;
  els.remove.addEventListener("click", async () => {
    if (!els.remove.classList.contains("confirm")) {
      els.remove.classList.add("confirm");
      els.remove.textContent = "Clique de novo para remover";
      confirmTimer = setTimeout(() => {
        els.remove.classList.remove("confirm");
        els.remove.textContent = "Remover canal";
      }, 4000);
      return;
    }
    clearTimeout(confirmTimer);
    await browser.runtime.sendMessage({ type: "REMOVE_CHANNEL", channel: name });
    delete state.channels[name];
    renderChannels();
  });

  cards.set(name, { root, els });
  return root;
}

function renderCard(name) {
  const card = cards.get(name);
  const s = state.channels[name];
  if (!card || !s) return;
  const { els } = card;

  els.enabled.checked = !!s.enabled;
  for (const b of els.modeButtons) b.setAttribute("aria-checked", String(b.dataset.mode === s.mode));
  els.rodField.hidden = s.mode !== "manual"; // a vara so aparece no modo manual
  if (document.activeElement !== els.rod) els.rod.value = s.rod || AT.DEFAULT_ROD;

  els.notifyEvents.checked = !!s.notifyEvents;

  const usesDefault = s.maxJitterSeconds === null || s.maxJitterSeconds === undefined;
  els.jitterDefault.checked = usesDefault;
  els.defaultValue.textContent = `${state.general.defaultMaxJitterSeconds}s`;
  els.jitterRow.hidden = usesDefault;
  if (!usesDefault && document.activeElement !== els.jitter) {
    els.jitter.value = s.maxJitterSeconds;
    els.jitterValue.textContent = `${s.maxJitterSeconds}s`;
  }

  renderClock(name);
}

function renderClock(name) {
  const card = cards.get(name);
  const s = state.channels[name];
  if (!card || !s) return;
  const { text, cls } = clockText(s);
  card.els.clock.textContent = text;
  card.els.clock.className = `channel-clock ${cls}`;
}

function renderChannels() {
  const names = Object.keys(state.channels).sort((a, b) => a.localeCompare(b));

  // Remove cartoes de canais que sumiram.
  for (const name of [...cards.keys()]) {
    if (!names.includes(name)) {
      cards.get(name).root.remove();
      cards.delete(name);
    }
  }

  if (names.length === 0) {
    channelsEl.innerHTML = "";
    const p = document.createElement("div");
    p.className = "panel empty";
    p.textContent =
      "Nenhum canal configurado ainda. Abra a aba de um canal na Twitch e ative pelo popup da extensão — ele aparece aqui.";
    channelsEl.appendChild(p);
    return;
  }
  channelsEl.querySelector(".empty")?.remove();

  for (const name of names) {
    const root = cards.has(name) ? cards.get(name).root : createCard(name);
    channelsEl.appendChild(root); // mantem a ordem alfabetica
    renderCard(name);
  }
}

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

async function loadState() {
  state = await browser.runtime.sendMessage({ type: "GET_ALL_STATE" });
  renderGeneral();
  renderChannels();
}

// Mudancas feitas em outro lugar (popup, envios, Twish) aparecem aqui sozinhas.
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.general) {
    state.general = AT.mergeGeneral(changes.general.newValue);
    renderGeneral();
  }
  if (changes.channels) {
    const next = changes.channels.newValue || {};
    state.channels = {};
    for (const [name, s] of Object.entries(next)) state.channels[name] = { ...AT.DEFAULT_CHANNEL_SETTINGS, ...s };
    renderChannels();
  }
});

// Contadores: 1x por segundo.
setInterval(() => {
  for (const name of cards.keys()) renderClock(name);
}, 1000);

loadState();
