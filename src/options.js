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
const notifyAutomationsEl = $("notifyAutomations");

// ---------------------------------------------------------------------------
// Campos das automacoes (usados no padrao geral e nas excecoes dos canais).
// save(patch) recebe so o que mudou.
// ---------------------------------------------------------------------------
function mountDuelEditor(host, save) {
  const root = $("duelTemplate").content.firstElementChild.cloneNode(true);
  host.appendChild(root);
  const q = (sel) => root.querySelector(sel);
  const el = {
    enabled: q(".js-duel-enabled"),
    fields: q(".js-duel-fields"),
    rule: q(".js-duel-rule"),
    valueField: q(".js-duel-value-field"),
    valueLabel: q(".js-duel-value-label"),
    value: q(".js-duel-value"),
    hint: q(".js-duel-value-hint")
  };
  for (const r of AT.DUEL_RULES) {
    const o = document.createElement("option");
    o.value = r;
    o.textContent = AT.DUEL_RULE_LABELS[r];
    el.rule.appendChild(o);
  }
  let cfg = AT.sanitizeDuelAccept(null);
  el.enabled.addEventListener("change", () => save({ enabled: el.enabled.checked }));
  el.rule.addEventListener("change", () => save({ rule: el.rule.value }));
  el.value.addEventListener("change", () => {
    const key = cfg.rule === "minutes" ? "minutes" : "pct";
    save({ [key]: el.value.value });
  });
  return function render(next) {
    cfg = AT.sanitizeDuelAccept(next);
    el.enabled.checked = cfg.enabled;
    el.fields.hidden = !cfg.enabled;
    if (document.activeElement !== el.rule) el.rule.value = cfg.rule;
    el.valueField.hidden = cfg.rule === "always";
    const isMin = cfg.rule === "minutes";
    el.valueLabel.textContent = isMin ? "Mínimo (minutos para pescar)" : "Mínimo (% do CD da pesca)";
    el.hint.textContent = isMin ? "de 1 a 60" : "de 1 a 100 — ex: 50 = só aceita se faltar metade ou mais";
    if (document.activeElement !== el.value) el.value.value = isMin ? cfg.minutes : cfg.pct;
  };
}

function mountSellEditor(host, save) {
  const root = $("sellTemplate").content.firstElementChild.cloneNode(true);
  host.appendChild(root);
  const enabled = root.querySelector(".js-sell-enabled");
  const fields = root.querySelector(".js-sell-fields");
  const seconds = root.querySelector(".js-sell-seconds");
  enabled.addEventListener("change", () => save({ enabled: enabled.checked }));
  seconds.addEventListener("change", () => save({ secondsBeforeEnd: seconds.value }));
  return function render(next) {
    const cfg = AT.sanitizeTurboSell(next);
    enabled.checked = cfg.enabled;
    fields.hidden = !cfg.enabled;
    if (document.activeElement !== seconds) seconds.value = cfg.secondsBeforeEnd;
  };
}

// Especies do jogo para a protecao (nome -> id), lidas do bestiario.
let protectBestiary = [];
async function loadProtectBestiary() {
  try {
    const { list } = await browser.runtime.sendMessage({ type: "GET_BESTIARY" });
    protectBestiary = Array.isArray(list) ? list : [];
  } catch (e) {
    protectBestiary = [];
  }
  const dl = $("protectFishOptions");
  dl.innerHTML = "";
  for (const f of protectBestiary) {
    const o = document.createElement("option");
    o.value = f.name;
    dl.appendChild(o);
  }
}
function norm(t) {
  return String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
}
// Aceita o nome (com ou sem acento) ou o id do jogo (ex: aruana_asiatica).
function resolveFish(text) {
  const n = norm(text);
  if (!n) return null;
  const hit = protectBestiary.find((f) => norm(f.name) === n || f.id === n);
  if (hit) return { id: hit.id, name: hit.name };
  const id = n.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!protectBestiary.length && AT.FISH_ID_RE.test(id)) return { id, name: text.trim() }; // sem bestiario: aceita pelo formato do id
  return null;
}

function mountProtectEditor(host, save) {
  const root = $("protectTemplate").content.firstElementChild.cloneNode(true);
  host.appendChild(root);
  const q = (sel) => root.querySelector(sel);
  const enabled = q(".js-protect-enabled");
  const chips = q(".js-protect-chips");
  const input = q(".js-protect-input");
  const add = q(".js-protect-add");
  const error = q(".js-protect-error");
  let cfg = AT.sanitizeProtection(null);
  enabled.addEventListener("change", () => save({ enabled: enabled.checked }));
  function addFish() {
    const f = resolveFish(input.value);
    if (!f) {
      error.textContent = "Espécie não encontrada — escolha um nome da lista de sugestões.";
      return;
    }
    if (cfg.fish.some((x) => x.id === f.id)) {
      error.textContent = `${f.name} já está na lista.`;
      return;
    }
    error.textContent = "";
    input.value = "";
    save({ fish: [...cfg.fish, f] });
  }
  add.addEventListener("click", addFish);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addFish();
    }
  });
  return function render(next) {
    cfg = AT.sanitizeProtection(next);
    enabled.checked = cfg.enabled;
    chips.innerHTML = "";
    if (!cfg.fish.length) {
      const e = document.createElement("span");
      e.className = "chips-empty";
      e.textContent = "Nenhuma espécie na lista.";
      chips.appendChild(e);
    }
    for (const f of cfg.fish) {
      const c = document.createElement("span");
      c.className = "chip";
      c.title = `id no jogo: ${f.id}`;
      c.textContent = f.name;
      const x = document.createElement("button");
      x.type = "button";
      x.textContent = "×";
      x.title = `Tirar ${f.name} da lista (não remove do jogo)`;
      x.setAttribute("aria-label", x.title);
      x.addEventListener("click", () => save({ fish: cfg.fish.filter((y) => y.id !== f.id) }));
      c.appendChild(x);
      chips.appendChild(c);
    }
  };
}

const renderGeneralDuel = mountDuelEditor($("generalDuel"), (patch) => updateGeneral({ duelAccept: patch }));
const renderGeneralSell = mountSellEditor($("generalSell"), (patch) => updateGeneral({ turboSell: patch }));
const renderGeneralProtect = mountProtectEditor($("generalProtect"), (patch) => updateGeneral({ protection: patch }));
let gameState = {};

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
  notifyAutomationsEl.checked = !!g.notifyAutomations;
  renderGeneralDuel(g.duelAccept);
  renderGeneralSell(g.turboSell);
  renderGeneralProtect(g.protection);
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
notifyAutomationsEl.addEventListener("change", () => updateGeneral({ notifyAutomations: notifyAutomationsEl.checked }));

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
    remove: q(".js-remove"),
    duelDefault: q(".js-duel-default"),
    duelSummary: q(".js-duel-summary"),
    duelHost: q(".js-duel-host"),
    sellDefault: q(".js-sell-default"),
    sellSummary: q(".js-sell-summary"),
    sellHost: q(".js-sell-host"),
    protectDefault: q(".js-protect-default"),
    protectSummary: q(".js-protect-summary"),
    protectHost: q(".js-protect-host"),
    protectStatusRow: q(".js-protect-status-row"),
    protectStatus: q(".js-protect-status"),
    protectCheck: q(".js-protect-check")
  };
  els.renderProtect = mountProtectEditor(els.protectHost, (patch) => updateChannel(name, { protection: patch }));
  els.protectDefault.addEventListener("change", () => updateChannel(name, { protection: els.protectDefault.checked ? null : {} }));
  els.protectCheck.addEventListener("click", async () => {
    els.protectCheck.disabled = true;
    els.protectStatus.textContent = "Conferindo…";
    await browser.runtime.sendMessage({ type: "SYNC_PROTECTION_NOW", channel: name });
    els.protectCheck.disabled = false;
    renderProtectStatus(name);
  });
  // Excecoes de automacao: desmarcar "usar o padrao geral" cria uma copia do
  // padrao atual para este canal; marcar de novo apaga a excecao.
  els.renderDuel = mountDuelEditor(els.duelHost, (patch) => updateChannel(name, { duelAccept: patch }));
  els.renderSell = mountSellEditor(els.sellHost, (patch) => updateChannel(name, { turboSell: patch }));
  els.duelDefault.addEventListener("change", () => updateChannel(name, { duelAccept: els.duelDefault.checked ? null : {} }));
  els.sellDefault.addEventListener("change", () => updateChannel(name, { turboSell: els.sellDefault.checked ? null : {} }));

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

  const g = state.general;
  els.duelDefault.checked = !s.duelAccept;
  els.duelSummary.textContent = AT.describeDuelAccept(AT.sanitizeDuelAccept(g.duelAccept));
  els.duelHost.hidden = !s.duelAccept;
  if (s.duelAccept) els.renderDuel(s.duelAccept);
  els.sellDefault.checked = !s.turboSell;
  els.sellSummary.textContent = AT.describeTurboSell(AT.sanitizeTurboSell(g.turboSell));
  els.sellHost.hidden = !s.turboSell;
  if (s.turboSell) els.renderSell(s.turboSell);
  els.protectDefault.checked = !s.protection;
  els.protectSummary.textContent = AT.describeProtection(AT.sanitizeProtection(g.protection));
  els.protectHost.hidden = !s.protection;
  if (s.protection) els.renderProtect(s.protection);
  renderProtectStatus(name);

  renderClock(name);
}

function renderProtectStatus(name) {
  const card = cards.get(name);
  const s = state.channels[name];
  if (!card || !s) return;
  const cfg = AT.effectiveProtection(s, state.general);
  const active = cfg.enabled && cfg.fish.length > 0;
  card.els.protectStatusRow.hidden = !active;
  if (!active) return;
  const w = (gameState[name] || {}).whitelist;
  card.els.protectStatus.textContent = w && w.checkedAt
    ? `${w.lastMsg || ""} Conferido às ${new Date(w.checkedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}.`
    : "Ainda não conferido.";
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
  try {
    gameState = (await browser.storage.local.get("gameState")).gameState || {};
  } catch (e) {
    gameState = {};
  }
  loadProtectBestiary();
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
  if (changes.gameState) {
    gameState = changes.gameState.newValue || {};
    for (const name of cards.keys()) renderProtectStatus(name);
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
