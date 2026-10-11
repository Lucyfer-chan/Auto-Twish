const enabledEl = document.getElementById("enabled");
const modeEl = document.getElementById("mode");
const rodEl = document.getElementById("rod");
const jitterEl = document.getElementById("jitter");
const jitterValueEl = document.getElementById("jitterValue");
const channelLabelEl = document.getElementById("channelLabel");
const twishStatusEl = document.getElementById("twishStatus");
const saveBtn = document.getElementById("save");
const testBtn = document.getElementById("testNow");
const statusEl = document.getElementById("status");
const countdownEl = document.getElementById("countdown");
const checkingEl = document.getElementById("checking");

// Constantes compartilhadas com o background (shared.js).
const HEARTBEAT_NAME = AT.HEARTBEAT_NAME;
const DEFAULT_JITTER_SECONDS = AT.DEFAULT_MAX_JITTER_SECONDS;
const DEFAULT_ROD = AT.DEFAULT_ROD;
const TWISH_FRESH_MS = AT.TWISH_DATA_FRESH_MS;

// Mostra a versao (do manifest) no titulo do popup, no formato "v 0.XX.YYY".
document.getElementById("version").textContent = `v ${browser.runtime.getManifest().version}`;

let currentChannel = null;
let mainTarget = null; // nextFireAt do canal atual (ou null se desativado)
let heartbeatTarget = null; // scheduledTime do alarme de heartbeat (ou null)
let renderTimer = null;

async function getActiveTabUrl() {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  return tab?.url || "";
}

function setFormEnabled(isEnabled) {
  enabledEl.disabled = !isEnabled;
  modeEl.disabled = !isEnabled;
  rodEl.disabled = !isEnabled;
  jitterEl.disabled = !isEnabled;
  saveBtn.disabled = !isEnabled;
  testBtn.disabled = !isEnabled;
}

const formatRemaining = AT.formatRemaining; // "mm:ss", sem milissegundos

let lastTwishSync = null; // resultado da ultima sincronizacao explicita ({ found, availableAt, rodId, at })

function formatClock(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

// Mostra, em qualquer modo, se a aba do Twish desse canal foi encontrada
// na ultima sincronizacao e o que foi lido dela.
function renderTwishStatus(settings) {
  const sync = lastTwishSync;
  if (sync && sync.found) {
    let what;
    if (sync.availableAt === null) {
      what = "aba encontrada, mas o título não foi reconhecido";
    } else if (sync.availableAt <= sync.at + 1000) {
      what = "pesca disponível";
    } else {
      what = `cooldown de ${formatClock(sync.availableAt - sync.at)} no momento da leitura`;
    }
    const rod = sync.rodId ? "vara detectada" : "vara não detectada";
    twishStatusEl.textContent = `Twish: sincronizado — ${what}; ${rod}.`;
    twishStatusEl.className = "hint ok";
    return;
  }

  if (sync && !sync.found) {
    twishStatusEl.textContent = "Twish: nenhuma aba aberta para este canal. Abra a página de inventário do Twish desse canal" +
      (modeEl.value === "auto" ? " — até lá, o modo automático usa a estimativa da vara." : ".");
    twishStatusEl.className = "hint stale";
    return;
  }

  // Ainda sem sincronizacao explicita nesta abertura do popup.
  const lastSeen = settings?.twishLastSeen;
  if (lastSeen && Date.now() - lastSeen < TWISH_FRESH_MS) {
    twishStatusEl.textContent = "Twish: sincronizando…";
    twishStatusEl.className = "hint ok";
  } else {
    twishStatusEl.textContent = "Twish: sincronizando…";
    twishStatusEl.className = "hint";
  }
}

function stopTicking() {
  if (renderTimer) {
    clearTimeout(renderTimer);
    renderTimer = null;
  }
}

// Pede ao background pra buscar dado fresco na aba do Twish agora mesmo
// (cooldown real + vara equipada), em vez de esperar passivamente a
// proxima mudanca de titulo. Aplica o resultado nos campos do formulario
// quando ha algo novo. Retorna as settings atualizadas (ou null).
async function syncTwish() {
  if (!currentChannel) return null;
  try {
    const { settings, twish } = await browser.runtime.sendMessage({
      type: "SYNC_TWISH_FOR_CHANNEL",
      channel: currentChannel
    });
    lastTwishSync = twish ? { ...twish, at: Date.now() } : null;

    if (settings) {
      modeEl.dataset.twishLastSeen = settings.twishLastSeen || "";
      if (settings.rod) rodEl.value = settings.rod;
      mainTarget = settings.enabled ? settings.nextFireAt : mainTarget;
    } else if (twish?.rodId) {
      // Canal ainda nao salvo: so pre-seleciona a vara detectada no formulario.
      rodEl.value = twish.rodId;
    }
    renderTwishStatus(settings);
    return settings;
  } catch (e) {
    return null;
  }
}

// So redesenha o texto a partir dos valores em cache (mainTarget/heartbeatTarget).
function renderCountdowns() {
  if (!mainTarget) {
    countdownEl.className = "muted";
    countdownEl.textContent = "Desativado — nenhum envio agendado.";
    checkingEl.textContent = "";
    return;
  }

  countdownEl.className = "";
  const remaining = mainTarget - Date.now();

  if (remaining > 0) {
    countdownEl.textContent = `Próximo envio em: ${formatRemaining(remaining)}`;
    checkingEl.textContent = "";
    return;
  }

  // Cooldown esgotado: o alarme dedicado do canal dispara quase na hora;
  // esse texto aparece so por um instante, ate o envio ser registrado.
  countdownEl.textContent = "Próximo envio: agora…";
  if (heartbeatTarget && heartbeatTarget > Date.now()) {
    checkingEl.textContent = `Rede de segurança (fallback) em: ${formatRemaining(heartbeatTarget - Date.now())}`;
  } else {
    checkingEl.textContent = "";
    refreshHeartbeatTarget(); // horario do heartbeat ja passou; busca o proximo
  }
}

async function refreshHeartbeatTarget() {
  try {
    const alarm = await browser.alarms.get(HEARTBEAT_NAME);
    heartbeatTarget = alarm ? alarm.scheduledTime : null;
  } catch (e) {
    heartbeatTarget = null;
  }
}

// Redesenha 1x por segundo, alinhado na virada do segundo do contador.
function startTicking() {
  stopTicking();
  const tick = () => {
    renderCountdowns();
    const msToNextSecond = mainTarget ? ((mainTarget - Date.now()) % 1000 + 1000) % 1000 || 1000 : 1000;
    renderTimer = setTimeout(tick, msToNextSecond + 5);
  };
  tick();
}

// Em vez de perguntar ao background a cada segundo, o popup e avisado
// quando as configuracoes mudam (envio feito, reagendamento, etc.).
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.channels || !currentChannel) return;
  const s = (changes.channels.newValue || {})[currentChannel];
  mainTarget = s && s.enabled ? s.nextFireAt : null;
  renderCountdowns();
});

jitterEl.addEventListener("input", () => {
  jitterValueEl.textContent = `${jitterEl.value}s`;
});

modeEl.addEventListener("change", async () => {
  await syncTwish(); // sincroniza ao trocar pra qualquer modo
});

async function load() {
  const url = await getActiveTabUrl();
  const { channel, settings } = await browser.runtime.sendMessage({
    type: "GET_SETTINGS_FOR_ACTIVE_TAB",
    url
  });
  currentChannel = channel;

  if (!channel) {
    channelLabelEl.textContent = "Abra a aba de um canal da Twitch (ex: twitch.tv/seucanal) para configurar.";
    channelLabelEl.classList.add("muted");
    setFormEnabled(false);
    mainTarget = null;
    heartbeatTarget = null;
    startTicking();
    return;
  }

  channelLabelEl.innerHTML = `Canal detectado: <strong>${channel}</strong>`;
  channelLabelEl.classList.remove("muted");
  setFormEnabled(true);

  enabledEl.checked = !!settings.enabled;
  modeEl.value = settings.mode || "manual";
  modeEl.dataset.twishLastSeen = settings.twishLastSeen || "";
  rodEl.value = settings.rod || DEFAULT_ROD;
  jitterEl.value = settings.maxJitterSeconds || DEFAULT_JITTER_SECONDS;
  jitterValueEl.textContent = `${jitterEl.value}s`;
  renderTwishStatus(settings);

  mainTarget = settings.enabled ? settings.nextFireAt : null;
  await refreshHeartbeatTarget();
  startTicking();

  // Busca dado fresco do Twish assim que o popup abre, em vez de esperar
  // passivamente a proxima mudanca de titulo da aba.
  await syncTwish();
}

function currentSettingsFromForm() {
  return {
    enabled: enabledEl.checked,
    mode: modeEl.value,
    rod: rodEl.value,
    maxJitterSeconds: Number(jitterEl.value)
  };
}

saveBtn.addEventListener("click", async () => {
  if (!currentChannel) return;
  const settings = currentSettingsFromForm();
  await browser.runtime.sendMessage({
    type: "UPDATE_CHANNEL_SETTINGS",
    channel: currentChannel,
    settings
  });
  statusEl.textContent = settings.enabled
    ? `Salvo para ${currentChannel}.`
    : `Salvo para ${currentChannel} (desativado).`;
  await load();
});

testBtn.addEventListener("click", async () => {
  if (!currentChannel) return;
  const result = await browser.runtime.sendMessage({ type: "SEND_NOW", channel: currentChannel });
  statusEl.textContent = result?.ok
    ? "Disparado. Confira o chat."
    : `Falha ao enviar (${result?.reason || "motivo desconhecido"}). Veja o console da aba da Twitch.`;
  await load();
});

load();
