// background.js
// Cada canal da Twitch tem sua propria configuracao (ativado/desativado,
// modo, "Vara", atraso aleatorio maximo e o horario calculado da proxima
// tentativa, "nextFireAt").
//
// MODO "manual": nextFireAt e sempre calculado a partir da vara + atraso
// aleatorio (uma estimativa).
//
// MODO "auto": a extensao tambem escuta o TITULO das abas abertas do site
// do Twish (formato "(mm:ss) Twish" ou so "Twish" quando disponivel),
// identifica a qual canal da Twitch aquela aba se refere (pela URL,
// /c/<canal>/<usuario>/...) e usa esse cooldown REAL pra corrigir
// nextFireAt sempre que houver dado fresco. Sem aba do Twish (ou com dado
// velho, +5 min), cai de volta pra estimativa da vara — nunca fica
// travada esperando.
//
// Disparo: cada canal tem um alarme DEDICADO, agendado exatamente para
// nextFireAt. Existe tambem um heartbeat a cada 1 min como rede de
// seguranca, caso o alarme dedicado nao dispare. Os dois caminhos passam
// pela mesma funcao (processChannelIfDue), protegida por um lock em
// memoria por canal (inFlightChannels) pra nunca disparar em dobro.
//
// Confirmacao: o content.js confirma que o texto foi digitado certo antes
// de mandar, e reporta sucesso/falha. Falha local => retry em 15s, sem
// consumir o cooldown normal.

if (typeof importScripts === "function" && typeof browser === "undefined") {
  importScripts("browser-polyfill.js");
}

const FIXED_MESSAGE = "$pescar";
const HEARTBEAT_NAME = "auto-twish-heartbeat";
const DUE_ALARM_PREFIX = "auto-twish-due:";
const RETRY_DELAY_MS = 15 * 1000; // se o envio local falhar, tenta de novo bem mais cedo
const TWISH_URL_PATTERNS = ["*://twish.com.br/*", "*://*.twish.com.br/*"];
const TWISH_DATA_FRESH_MS = 5 * 60 * 1000; // dado do Twish mais velho que isso e considerado obsoleto
const SAME_COOLDOWN_TOLERANCE_MS = 3 * 1000; // leituras do titulo dentro dessa margem = mesmo cooldown, nao resorteia
const JUST_SENT_GUARD_MS = 20 * 1000; // leituras "disponivel" ate 20s apos um envio nosso sao consideradas velhas

// Varas do jogo, da mais lenta (Bambu) pra mais rapida (Njord).
const ROD_DEFS = [
  { id: "vara_bambu", name: "Vara de Bambu", minutes: 10 },
  { id: "vara_madeira", name: "Vara de Madeira Reforçada", minutes: 9 },
  { id: "vara_fibra", name: "Vara de Fibra de Vidro", minutes: 8 },
  { id: "vara_aco", name: "Vara de Aço", minutes: 7 },
  { id: "vara_carbono", name: "Vara de Carbono", minutes: 6 },
  { id: "vara_encantada", name: "Vara Encantada", minutes: 5 },
  { id: "vara_abissal", name: "Vara Abissal", minutes: 4 },
  { id: "vara_lendaria", name: "Vara Lendária", minutes: 3 },
  { id: "vara_njord", name: "Vara Njord", minutes: 2 }
];
const ROD_MINUTES = Object.fromEntries(ROD_DEFS.map((r) => [r.id, r.minutes]));
const ROD_NAME_TO_ID = Object.fromEntries(ROD_DEFS.map((r) => [r.name.toLowerCase(), r.id]));
const DEFAULT_ROD = ROD_DEFS[0].id; // vara_bambu
// Ids usados ate a v 0.1.1 (LSV) -> ids atuais. Canais salvos com o
// formato antigo sao convertidos automaticamente na leitura.
const LEGACY_ROD_IDS = {
  vara1: "vara_bambu", vara2: "vara_madeira", vara3: "vara_fibra",
  vara4: "vara_aco", vara5: "vara_carbono", vara6: "vara_encantada",
  vara7: "vara_abissal", vara8: "vara_lendaria", vara9: "vara_njord"
};
// Nomes de alarme usados antes da renomeacao pra "Auto Twish"; limpos no bootstrap.
const LEGACY_HEARTBEAT_NAME = "twitch-auto-chat-heartbeat";
const LEGACY_DUE_ALARM_PREFIX = "twitch-auto-chat-due:";
const DEFAULT_MAX_JITTER_SECONDS = 10; // usado so se o canal nunca configurou o slider

const DEFAULT_CHANNEL_SETTINGS = {
  enabled: false,
  rod: DEFAULT_ROD,
  maxJitterSeconds: DEFAULT_MAX_JITTER_SECONDS, // atraso aleatorio extra vai de 0 ate esse valor
  mode: "manual", // "manual" | "auto"
  twishAvailableAt: null, // ultimo horario real de disponibilidade lido do Twish
  twishLastSeen: null, // quando essa leitura foi feita
  lastSentAt: null, // ultimo envio local bem-sucedido (guarda contra corrida com leituras velhas do Twish)
  nextFireAt: null // timestamp (ms) da proxima tentativa; null = sem agendamento
};

// Lock em memoria: garante que so um envio por canal roda por vez, mesmo
// se o alarme dedicado e o heartbeat dispararem quase simultaneamente.
const inFlightChannels = new Set();

function dueAlarmName(channel) {
  return `${DUE_ALARM_PREFIX}${channel}`;
}

function channelFromDueAlarmName(name) {
  return name.startsWith(DUE_ALARM_PREFIX) ? name.slice(DUE_ALARM_PREFIX.length) : null;
}

// Garante um numero inteiro entre 1 e 100, com fallback pro default.
function clampJitterSeconds(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_MAX_JITTER_SECONDS;
  return Math.min(100, Math.max(1, Math.round(n)));
}

// Extrai o nome do canal a partir da URL de uma aba da Twitch, cobrindo
// tambem as variantes /popout/<canal>/chat e /moderator/<canal>/... .
function extractChannelFromUrl(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)twitch\.tv$/i.test(u.hostname)) return null;

    const parts = u.pathname.split("/").filter(Boolean);
    if (parts.length === 0) return null;

    let first = parts[0].toLowerCase();
    if ((first === "popout" || first === "moderator") && parts[1]) {
      first = parts[1].toLowerCase();
    }

    const reserved = new Set([
      "directory", "search", "downloads", "jobs", "turbo", "subscriptions",
      "wallet", "settings", "friends", "inventory", "drops", "p", "videos",
      "prime", "creatorcamp", "team", "login", "signup", "store"
    ]);
    if (!first || reserved.has(first)) return null;

    return first;
  } catch (e) {
    return null;
  }
}

// Extrai o nome do canal a partir da URL de uma aba do Twish:
// https://twish.com.br/c/<canal-da-twitch>/<usuario-twish>/... .
function extractChannelFromTwishUrl(url) {
  try {
    const u = new URL(url);
    if (!/(^|\.)twish\.com\.br$/i.test(u.hostname)) return null;

    const parts = u.pathname.split("/").filter(Boolean);
    const idx = parts.indexOf("c");
    if (idx === -1 || !parts[idx + 1]) return null;

    return parts[idx + 1].toLowerCase();
  } catch (e) {
    return null;
  }
}

// Interpreta o titulo da aba do Twish: "(mm:ss) Twish" quando em cooldown,
// ou "Twish" quando a pesca ja esta disponivel.
function parseTwishTitle(title) {
  if (!title) return null;
  const trimmed = title.trim();

  const withCooldown = /^\((\d{1,3}):(\d{2})\)\s*Twish\b/i.exec(trimmed);
  if (withCooldown) {
    const minutes = parseInt(withCooldown[1], 10);
    const seconds = parseInt(withCooldown[2], 10);
    return { availableNow: false, remainingMs: (minutes * 60 + seconds) * 1000 };
  }

  if (/^Twish\b/i.test(trimmed)) {
    return { availableNow: true, remainingMs: 0 };
  }

  return null; // titulo em formato desconhecido; ignora
}

async function getAllChannelSettings() {
  const { channels } = await browser.storage.local.get("channels");
  const all = channels || {};
  for (const settings of Object.values(all)) {
    if (settings && LEGACY_ROD_IDS[settings.rod]) {
      settings.rod = LEGACY_ROD_IDS[settings.rod];
    }
  }
  return all;
}

async function getChannelSettings(channel) {
  const channels = await getAllChannelSettings();
  return { ...DEFAULT_CHANNEL_SETTINGS, ...(channels[channel] || {}) };
}

async function saveAllChannelSettings(channels) {
  await browser.storage.local.set({ channels });
}

// Fila unica de escrita: TODA alteracao das configuracoes dos canais passa
// por aqui, uma de cada vez. Antes, varias rotinas (leitura do titulo do
// Twish a cada ~1s, salvar no popup, envio terminando, etc.) faziam
// "ler tudo -> alterar -> gravar tudo" ao mesmo tempo, e uma copia antiga
// podia sobrescrever uma mais nova — por exemplo, desfazendo um
// "desativar" recem-salvo (bug da reativacao sozinha no modo automatico).
let channelsWriteQueue = Promise.resolve();

// Executa fn(channels) com acesso exclusivo; fn altera o objeto recebido e
// o resultado e gravado no final. Devolve o que fn devolver.
// Nunca chamar mutateChannels de dentro de outro mutateChannels (trava).
function mutateChannels(fn) {
  const run = channelsWriteQueue.then(async () => {
    const channels = await getAllChannelSettings();
    const out = await fn(channels);
    await saveAllChannelSettings(channels);
    return out;
  });
  // A fila segue mesmo se esta operacao falhar.
  channelsWriteQueue = run.catch((e) => console.warn("[Auto Twish] Falha ao gravar configuracoes:", e));
  return run;
}

function computeJitterMs(settings) {
  const maxJitterSeconds = clampJitterSeconds(settings.maxJitterSeconds);
  return Math.floor(Math.random() * (maxJitterSeconds * 1000 + 1));
}

function computeDelayMs(settings) {
  const baseMinutes = ROD_MINUTES[settings.rod] || ROD_MINUTES[DEFAULT_ROD];
  const baseMs = baseMinutes * 60 * 1000;
  return baseMs + computeJitterMs(settings);
}

async function ensureHeartbeat() {
  const existing = await browser.alarms.get(HEARTBEAT_NAME);
  if (!existing) {
    await browser.alarms.create(HEARTBEAT_NAME, { periodInMinutes: 1 });
    console.log("[Auto Twish] Heartbeat agendado (rede de seguranca, a cada 1 min).");
  }
}

// Agenda (ou limpa) o alarme dedicado de um canal para o horario exato.
async function scheduleDueAlarm(channel, whenMs) {
  const name = dueAlarmName(channel);
  await browser.alarms.clear(name);
  if (whenMs) {
    await browser.alarms.create(name, { when: whenMs });
  }
}

// Restaura os alarmes dedicados de todos os canais ativos — importante
// depois de reiniciar o navegador ou recarregar a extensao.
async function restoreDueAlarms() {
  const channels = await getAllChannelSettings();
  for (const [channel, settings] of Object.entries(channels)) {
    if (settings.enabled && settings.nextFireAt) {
      await scheduleDueAlarm(channel, settings.nextFireAt);
    }
  }
}

// Roda um script pontual na aba do Twish pra ler qual vara esta equipada,
// a partir do slot com classe "is-equipped" (ex: <div class="inv-slot
// is-equipped" title="Vara de Bambu"><img src="/items/vara_bambu.png">).
// Devolve os dados brutos encontrados (ou null); a resolucao pro id da
// vara acontece em resolveRodId, ja que o script injetado roda isolado e
// nao tem acesso as constantes daqui.
async function readEquippedRodInfoFromTab(tabId) {
  try {
    const results = await browser.scripting.executeScript({
      target: { tabId },
      func: () => {
        const slot = document.querySelector(".inv-slot.is-equipped");
        if (!slot) return null;
        const img = slot.querySelector("img");
        let srcSlug = null;
        const src = img && img.getAttribute("src");
        if (src) {
          const m = src.match(/([a-z0-9_]+)\.(png|jpe?g|webp|gif)(?:[?#].*)?$/i);
          if (m) srcSlug = m[1].toLowerCase();
        }
        const title = slot.getAttribute("title") || (img && img.getAttribute("alt")) || null;
        return { srcSlug, title };
      }
    });
    return results?.[0]?.result || null;
  } catch (e) {
    console.warn("[Auto Twish] Falha ao ler vara equipada na aba do Twish:", e);
    return null;
  }
}

// Resolve a info bruta lida da pagina (slug do arquivo de imagem, ou nome
// no atributo title) pro id de vara que a extensao usa internamente.
function resolveRodId(info) {
  if (!info) return null;
  if (info.srcSlug && ROD_MINUTES[info.srcSlug] !== undefined) return info.srcSlug;
  if (info.title) {
    const id = ROD_NAME_TO_ID[info.title.trim().toLowerCase()];
    if (id) return id;
  }
  return null;
}

// Procura, entre as abas do Twish abertas agora, uma que corresponda ao
// canal pedido, e devolve tanto o horario real de disponibilidade quanto
// a vara equipada (cada um null se nao foi possivel descobrir).
async function syncTwishForChannel(channel) {
  let availableAt = null;
  let rodId = null;

  try {
    const tabs = await browser.tabs.query({ url: TWISH_URL_PATTERNS });
    for (const tab of tabs) {
      if (extractChannelFromTwishUrl(tab.url || "") !== channel) continue;

      if (availableAt === null) {
        const parsed = parseTwishTitle(tab.title || "");
        if (parsed) {
          availableAt = parsed.availableNow ? Date.now() : Date.now() + parsed.remainingMs;
        }
      }

      if (rodId === null && tab.id !== undefined) {
        const info = await readEquippedRodInfoFromTab(tab.id);
        rodId = resolveRodId(info);
      }

      if (availableAt !== null && rodId !== null) break;
    }
  } catch (e) {
    console.warn("[Auto Twish] Falha ao sincronizar com abas do Twish:", e);
  }

  return { availableAt, rodId };
}

// Registra uma leitura de cooldown do Twish para um canal e, se esse canal
// estiver ativado em modo automatico, corrige nextFireAt com o horario
// real (+ o atraso configurado). Ignora leituras "disponivel agora" que
// cheguem logo apos um envio nosso (o titulo ainda nao foi atualizado pelo
// TwishGameBot, entao a leitura e velha).
async function recordTwishCooldown(channel, availableAt) {
  const rescheduled = await mutateChannels((channels) => {
    const settings = channels[channel];
    if (!settings) return null; // canal ainda nao configurado na extensao

    const now = Date.now();
    const previousAvailableAt = settings.twishAvailableAt;
    // A aba do Twish atualiza o titulo a cada ~1s (contagem regressiva), entao
    // availableAt (um timestamp absoluto = agora + restante) fica praticamente
    // igual de leitura pra leitura DENTRO do mesmo cooldown — so muda de
    // verdade quando um cooldown novo comeca. Nesse caso nao resorteia o
    // atraso a cada tick (o contador do popup "pularia" de valor).
    const isSameCooldown =
      previousAvailableAt !== null &&
      previousAvailableAt !== undefined &&
      Math.abs(availableAt - previousAvailableAt) < SAME_COOLDOWN_TOLERANCE_MS;

    settings.twishAvailableAt = availableAt;
    settings.twishLastSeen = now;

    if (!settings.enabled || settings.mode !== "auto") return null;

    const justSent = settings.lastSentAt && now - settings.lastSentAt < JUST_SENT_GUARD_MS;
    const isFreshCooldown = availableAt > now + 3000;
    if (justSent && !isFreshCooldown) return null; // leitura velha logo apos um envio nosso

    // Mesmo no "mesmo cooldown", corrige o agendamento se ele estiver mais
    // tarde do que o cooldown real permite (ex: estimativa de 10 min da vara
    // depois de um envio que o TwishGameBot nao respondeu, ou agendamento
    // feito antes da aba do Twish ser aberta).
    const latestAcceptable = Math.max(now, availableAt) + clampJitterSeconds(settings.maxJitterSeconds) * 1000 + 2000;
    const scheduleIsWrong = !settings.nextFireAt || settings.nextFireAt > latestAcceptable;
    if (isSameCooldown && !scheduleIsWrong) return null;

    settings.nextFireAt = Math.max(now, availableAt) + computeJitterMs(settings);
    return settings.nextFireAt;
  });

  if (rescheduled) {
    await scheduleDueAlarm(channel, rescheduled);
    console.log(`[Auto Twish] (Twish) "${channel}" cooldown real detectado; proximo envio as ${new Date(rescheduled).toLocaleTimeString()}`);
  }
}

async function handleTwishTabUpdate(tab) {
  const channel = extractChannelFromTwishUrl(tab.url || "");
  if (!channel) return;
  const parsed = parseTwishTitle(tab.title || "");
  if (!parsed) return;
  const availableAt = parsed.availableNow ? Date.now() : Date.now() + parsed.remainingMs;
  await recordTwishCooldown(channel, availableAt);
}

async function syncAllTwishTabs() {
  try {
    const tabs = await browser.tabs.query({ url: TWISH_URL_PATTERNS });
    for (const tab of tabs) {
      await handleTwishTabUpdate(tab);
    }
  } catch (e) {
    console.warn("[Auto Twish] Falha ao sincronizar abas do Twish na inicializacao:", e);
  }
}

// Tenta enviar a mensagem fixa pra(s) aba(s) do canal e reporta se o
// content.js confirmou que o texto foi digitado e o envio foi disparado.
// NAO confirma que o TwishGameBot de fato respondeu — so que o envio
// local (Twitch) funcionou.
async function attemptSend(channel) {
  const tabs = await browser.tabs.query({ url: "*://*.twitch.tv/*" });
  const targets = tabs.filter((t) => extractChannelFromUrl(t.url) === channel);

  if (targets.length === 0) {
    console.warn(`[Auto Twish] Nenhuma aba aberta para "${channel}"; nao foi possivel enviar.`);
    return { ok: false, reason: "no-tab" };
  }

  let anyOk = false;
  const reasons = [];

  for (const tab of targets) {
    try {
      const result = await browser.tabs.sendMessage(tab.id, { type: "SEND_CHAT_MESSAGE", text: FIXED_MESSAGE });
      if (result?.ok) {
        anyOk = true;
      } else {
        reasons.push(result?.reason || "unknown");
      }
    } catch (e) {
      reasons.push("no-content-script");
      console.warn(`[Auto Twish] Falha ao enviar para a aba ${tab.id}:`, e);
    }
  }

  if (!anyOk) {
    console.warn(`[Auto Twish] Envio para "${channel}" falhou em todas as abas (${reasons.join(", ") || "sem detalhes"}).`);
  }

  return { ok: anyOk, reason: anyOk ? undefined : (reasons[0] || "unknown") };
}

async function applyChannelSettings(channel, formSettings) {
  const enabled = !!formSettings.enabled;
  const mode = formSettings.mode === "auto" ? "auto" : "manual";

  // Busca dado fresco do Twish (cooldown real E vara equipada) ANTES de
  // entrar na fila de escrita — a leitura da pagina pode demorar e nao
  // deve segurar as outras gravacoes.
  const twish = enabled ? await syncTwishForChannel(channel) : { availableAt: null, rodId: null };

  const settings = await mutateChannels((channels) => {
    const previous = channels[channel] || {};
    const isActivating = enabled && !previous.enabled; // transicao desativado -> ativado
    const now = Date.now();

    const s = {
      enabled,
      rod: formSettings.rod || DEFAULT_ROD,
      maxJitterSeconds: clampJitterSeconds(formSettings.maxJitterSeconds),
      mode,
      twishAvailableAt: previous.twishAvailableAt || null,
      twishLastSeen: previous.twishLastSeen || null,
      lastSentAt: previous.lastSentAt || null,
      nextFireAt: null
    };

    if (enabled) {
      if (twish.availableAt !== null) {
        s.twishAvailableAt = twish.availableAt;
        s.twishLastSeen = now;
      }
      if (twish.rodId) {
        s.rod = twish.rodId; // vara equipada detectada tem prioridade sobre a selecao manual
      }

      const twishFresh =
        s.twishAvailableAt !== null && s.twishLastSeen && now - s.twishLastSeen < TWISH_DATA_FRESH_MS;
      const availableNow = twishFresh && s.twishAvailableAt <= now + 1000;

      if (isActivating && availableNow) {
        // Acabou de ativar e o Twish mostra a pesca disponivel: dispara ja,
        // em qualquer modo, sem somar o atraso aleatorio (ele existe pra
        // disfarcar o ritmo dos envios recorrentes, nao o primeiro).
        s.nextFireAt = now;
      } else if (twishFresh && (mode === "auto" || isActivating)) {
        // Automatico sempre segue o Twish; no manual, o dado real so e usado
        // no momento de ativar (depois segue so a estimativa da vara).
        s.nextFireAt = Math.max(now, s.twishAvailableAt) + computeJitterMs(s);
      } else {
        s.nextFireAt = now + computeDelayMs(s);
      }
    }

    channels[channel] = s;
    return s;
  });

  await ensureHeartbeat();
  await scheduleDueAlarm(channel, settings.nextFireAt);
  console.log(
    `[Auto Twish] Configuracao salva para "${channel}" (modo ${mode}):`,
    settings,
    settings.nextFireAt ? `Proximo envio as ${new Date(settings.nextFireAt).toLocaleTimeString()}` : "(desativado)"
  );
  return settings;
}

// Grava o resultado de um envio (feito FORA da fila de escrita, porque
// digitar no chat leva alguns segundos). Rele a configuracao atual: se o
// canal foi desativado durante o envio, nao reagenda nada.
async function recordSendResult(channel, ok) {
  const nextFireAt = await mutateChannels((channels) => {
    const s = channels[channel];
    if (!s || !s.enabled) return null;
    const now = Date.now();
    if (ok) {
      s.nextFireAt = now + computeDelayMs({ ...DEFAULT_CHANNEL_SETTINGS, ...s });
      s.lastSentAt = now;
    } else {
      // Envio local falhou (aba nao encontrada, campo nao encontrado, etc).
      // Nao avanca o cooldown normal — tenta de novo logo.
      s.nextFireAt = now + RETRY_DELAY_MS;
    }
    return s.nextFireAt;
  });
  await scheduleDueAlarm(channel, nextFireAt);
  return nextFireAt;
}

// Ponto unico de disparo, usado tanto pelo alarme dedicado quanto pelo
// heartbeat. Usa um lock em memoria (inFlightChannels) pra garantir que,
// mesmo se os dois dispararem quase juntos, so um envio real aconteca.
async function processChannelIfDue(channel, source) {
  if (inFlightChannels.has(channel)) {
    console.log(`[Auto Twish] "${channel}" ja esta sendo processado; ignorando disparo duplicado vindo de "${source}".`);
    return;
  }
  inFlightChannels.add(channel);

  try {
    const settings = (await getAllChannelSettings())[channel];
    if (!settings || !settings.enabled) return;

    if (settings.nextFireAt && Date.now() < settings.nextFireAt) return; // ainda nao esta na hora

    const result = await attemptSend(channel);
    const nextFireAt = await recordSendResult(channel, result.ok);

    if (!result.ok) {
      console.warn(`[Auto Twish] (${source}) Falha ao enviar para "${channel}" (${result.reason}); nova tentativa em ${RETRY_DELAY_MS / 1000}s.`);
    }
    console.log(
      nextFireAt
        ? `[Auto Twish] (${source}) Proximo envio para "${channel}" as ${new Date(nextFireAt).toLocaleTimeString()}`
        : `[Auto Twish] (${source}) "${channel}" foi desativado durante o envio; nada reagendado.`
    );
  } finally {
    inFlightChannels.delete(channel);
  }
}

// Rede de seguranca: varre todos os canais ativos a cada 1 min. So deve
// realmente disparar algo se o alarme dedicado correspondente tiver falhado.
async function heartbeatTick() {
  // Rele os titulos das abas do Twish (barato: so uma consulta de abas).
  // Assim o modo automatico se corrige sozinho mesmo quando o titulo nao
  // muda — ex: TwishGameBot nao respondeu e a aba continua em "Twish".
  await syncAllTwishTabs();
  const channels = await getAllChannelSettings();
  for (const [channel, settings] of Object.entries(channels)) {
    if (settings.enabled) {
      await processChannelIfDue(channel, "heartbeat");
    }
  }
}

// Garante heartbeat + alarmes dedicados + sincronizacao com o Twish em
// qualquer cenario de "acordar": instalacao, reinicio do navegador ou a
// pagina de fundo carregando de novo.
async function clearLegacyAlarms() {
  try {
    const alarms = await browser.alarms.getAll();
    for (const a of alarms) {
      if (a.name === LEGACY_HEARTBEAT_NAME || a.name.startsWith(LEGACY_DUE_ALARM_PREFIX)) {
        await browser.alarms.clear(a.name);
      }
    }
  } catch (e) {
    console.warn("[Auto Twish] Falha ao limpar alarmes antigos:", e);
  }
}

async function bootstrap() {
  await clearLegacyAlarms();
  await ensureHeartbeat();
  await restoreDueAlarms();
  await syncAllTwishTabs();
}

browser.runtime.onInstalled.addListener(bootstrap);
if (browser.runtime.onStartup) {
  browser.runtime.onStartup.addListener(bootstrap);
}
bootstrap();

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "GET_SETTINGS_FOR_ACTIVE_TAB") {
    const channel = extractChannelFromUrl(msg.url || "");
    if (!channel) {
      sendResponse({ channel: null, settings: null });
      return true;
    }
    getChannelSettings(channel).then((settings) => sendResponse({ channel, settings }));
    return true;
  }

  if (msg?.type === "GET_CHANNEL_SETTINGS") {
    getChannelSettings(msg.channel).then((settings) => sendResponse({ settings }));
    return true;
  }

  if (msg?.type === "SYNC_TWISH_FOR_CHANNEL") {
    (async () => {
      const channel = msg.channel;
      const existing = (await getAllChannelSettings())[channel];
      if (!existing) {
        // Canal ainda nunca foi salvo nesta extensao; nada pra atualizar
        // ainda (o primeiro Salvar ja faz a sincronizacao inicial).
        sendResponse({ settings: null });
        return;
      }

      const { availableAt, rodId } = await syncTwishForChannel(channel);

      if (availableAt !== null) {
        // Mesma logica do titulo mudando (respeita "mesmo cooldown" e
        // "acabou de enviar"), mas tambem corrige agendamento errado.
        await recordTwishCooldown(channel, availableAt);
      }

      if (rodId) {
        await mutateChannels((channels) => {
          if (channels[channel]) channels[channel].rod = rodId;
        });
      }

      sendResponse({ settings: await getChannelSettings(channel) });
    })();
    return true;
  }

  if (msg?.type === "UPDATE_CHANNEL_SETTINGS") {
    applyChannelSettings(msg.channel, msg.settings).then((settings) => sendResponse({ ok: true, settings }));
    return true;
  }

  if (msg?.type === "SEND_NOW") {
    (async () => {
      const result = await attemptSend(msg.channel);
      await recordSendResult(msg.channel, result.ok); // so reagenda se o canal estiver ativado
      sendResponse({ ok: result.ok, reason: result.reason, settings: await getChannelSettings(msg.channel) });
    })();
    return true;
  }
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEARTBEAT_NAME) {
    heartbeatTick();
    return;
  }
  const channel = channelFromDueAlarmName(alarm.name);
  if (channel) {
    processChannelIfDue(channel, "alarme dedicado");
  }
});

// Dispara sempre que o titulo de QUALQUER aba mudar; filtramos pelas
// abas do Twish dentro do proprio handler.
browser.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.title === undefined) return;
  handleTwishTabUpdate(tab).catch((e) => console.warn("[Auto Twish] Falha ao processar titulo do Twish:", e));
});
