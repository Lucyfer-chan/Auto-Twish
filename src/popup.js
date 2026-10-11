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

// Precisa bater com HEARTBEAT_NAME e TWISH_DATA_FRESH_MS em background.js.
const HEARTBEAT_NAME = "auto-twish-heartbeat";
const DEFAULT_JITTER_SECONDS = 10;
const DEFAULT_ROD = "vara_bambu";
const TWISH_FRESH_MS = 5 * 60 * 1000;
const REFRESH_INTERVAL_MS = 1000; // com que frequencia reconsulta os horarios reais
const RENDER_INTERVAL_MS = 30; // com que frequencia so redesenha o texto (suave, com ms)

// Mostra a versao (do manifest) no titulo do popup, no formato "v 0.XX.YYY".
document.getElementById("version").textContent = `v ${browser.runtime.getManifest().version}`;

let currentChannel = null;
let mainTarget = null; // nextFireAt do canal atual (ou null se desativado)
let heartbeatTarget = null; // scheduledTime do alarme de heartbeat (ou null)
let renderTimer = null;
let refreshTimer = null;

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

function formatRemaining(ms) {
  const clamped = Math.max(0, ms);
  const minutes = Math.floor(clamped / 60000);
  const seconds = Math.floor((clamped % 60000) / 1000);
  const millis = Math.floor(clamped % 1000);
  return (
    String(minutes).padStart(2, "0") + ":" +
    String(seconds).padStart(2, "0") + ":" +
    String(millis).padStart(3, "0")
  );
}

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
    clearInterval(renderTimer);
    renderTimer = null;
  }
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
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
// Quem mantem esses valores atualizados de verdade e refreshTargets().
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
    // Cooldown ainda rodando: a checagem do sistema ainda nao importa pra
    // esse canal, entao fica escondida.
    countdownEl.textContent = `Próximo envio em: ${formatRemaining(remaining)}`;
    checkingEl.textContent = "";
    return;
  }

  // Cooldown esgotado: o alarme dedicado do canal dispara quase
  // instantaneamente nesse momento. Esse texto deve aparecer so por um
  // instante breve, ate o proximo refreshTargets() confirmar o novo envio.
  countdownEl.textContent = "Próximo envio: agora…";
  if (heartbeatTarget) {
    const remainingCheck = Math.max(0, heartbeatTarget - Date.now());
    checkingEl.textContent = `Rede de segurança (fallback) em: ${formatRemaining(remainingCheck)}`;
  } else {
    checkingEl.textContent = "";
  }
}

// Busca os horarios reais (storage + alarme) de novo. E isso que faz os
// contadores se recuperarem sozinhos depois que o heartbeat dispara ou
// reagenda algo, sem precisar fechar e reabrir o popup.
async function refreshTargets() {
  if (!currentChannel) return;

  try {
    const { settings } = await browser.runtime.sendMessage({
      type: "GET_CHANNEL_SETTINGS",
      channel: currentChannel
    });
    mainTarget = settings && settings.enabled ? settings.nextFireAt : null;
  } catch (e) {
    // falha pontual de mensageria; tenta de novo no proximo ciclo
  }

  try {
    const alarm = await browser.alarms.get(HEARTBEAT_NAME);
    heartbeatTarget = alarm ? alarm.scheduledTime : null;
  } catch (e) {
    heartbeatTarget = null;
  }
}

function startTicking() {
  stopTicking();
  renderCountdowns();
  renderTimer = setInterval(renderCountdowns, RENDER_INTERVAL_MS);
  refreshTimer = setInterval(async () => {
    await refreshTargets();
    renderCountdowns();
  }, REFRESH_INTERVAL_MS);
}

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
  await refreshTargets(); // ja busca o heartbeat mais recente antes do 1o desenho
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
