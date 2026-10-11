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

// Constantes compartilhadas (shared.js, carregado antes deste arquivo).
const FIXED_MESSAGE = AT.FISH_COMMAND;
const HEARTBEAT_NAME = AT.HEARTBEAT_NAME;
const DUE_ALARM_PREFIX = AT.DUE_ALARM_PREFIX;
const TWISH_URL_PATTERNS = AT.TWISH_URL_PATTERNS;
const TWISH_DATA_FRESH_MS = AT.TWISH_DATA_FRESH_MS;
const ROD_MINUTES = AT.ROD_MINUTES;
const ROD_NAME_TO_ID = AT.ROD_NAME_TO_ID;
const DEFAULT_ROD = AT.DEFAULT_ROD;
const DEFAULT_CHANNEL_SETTINGS = AT.DEFAULT_CHANNEL_SETTINGS;
const clampJitterSeconds = AT.clampJitterSeconds;

// Constantes so do background.
const RETRY_DELAY_MS = 15 * 1000; // se o envio local falhar, tenta de novo bem mais cedo
const SAME_COOLDOWN_TOLERANCE_MS = 3 * 1000; // leituras do titulo dentro dessa margem = mesmo cooldown, nao resorteia
const JUST_SENT_GUARD_MS = 20 * 1000; // leituras "disponivel" ate 20s apos um envio nosso sao consideradas velhas
const LAST_SEEN_PERSIST_MS = 60 * 1000; // durante o mesmo cooldown, grava o "visto por ultimo" no maximo 1x por minuto

// Ids usados ate a v 0.1.1 (LSV) -> ids atuais (migrados uma vez, no carregamento).
const LEGACY_ROD_IDS = {
  vara1: "vara_bambu", vara2: "vara_madeira", vara3: "vara_fibra",
  vara4: "vara_aco", vara5: "vara_carbono", vara6: "vara_encantada",
  vara7: "vara_abissal", vara8: "vara_lendaria", vara9: "vara_njord"
};
// Nomes de alarme usados antes da renomeacao pra "Auto Twish"; limpos no bootstrap.
const LEGACY_HEARTBEAT_NAME = "twitch-auto-chat-heartbeat";
const LEGACY_DUE_ALARM_PREFIX = "twitch-auto-chat-due:";

// Lock em memoria: garante que so um envio por canal roda por vez, mesmo
// se o alarme dedicado e o heartbeat dispararem quase simultaneamente.
const inFlightChannels = new Set();

function dueAlarmName(channel) {
  return `${DUE_ALARM_PREFIX}${channel}`;
}

function channelFromDueAlarmName(name) {
  return name.startsWith(DUE_ALARM_PREFIX) ? name.slice(DUE_ALARM_PREFIX.length) : null;
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

// Interpreta o titulo da aba do Twish:
//   "(mm:ss) Twish" -> em cooldown
//   "🎣 Twish"      -> pesca disponivel (o site poe um emote antes do nome)
// Aceita qualquer simbolo/emote/espaco antes de cada parte, pra nao
// quebrar se o site mudar o enfeite.
const TWISH_PREFIX = "[^\\p{L}\\p{N}(]*"; // tudo que nao for letra, numero ou "("
const TWISH_COOLDOWN_RE = new RegExp(`^${TWISH_PREFIX}\\((\\d{1,3}):(\\d{2})\\)${TWISH_PREFIX}Twish(?![\\p{L}\\p{N}])`, "iu");
const TWISH_READY_RE = new RegExp(`^${TWISH_PREFIX}Twish(?![\\p{L}\\p{N}])`, "iu");

function parseTwishTitle(title) {
  if (!title) return null;
  const trimmed = title.trim();

  const withCooldown = TWISH_COOLDOWN_RE.exec(trimmed);
  if (withCooldown) {
    const minutes = parseInt(withCooldown[1], 10);
    const seconds = parseInt(withCooldown[2], 10);
    return { availableNow: false, remainingMs: (minutes * 60 + seconds) * 1000 };
  }

  if (TWISH_READY_RE.test(trimmed)) {
    return { availableNow: true, remainingMs: 0 };
  }

  return null; // titulo em formato desconhecido; ignora
}

// ---------------------------------------------------------------------------
// Armazenamento
//
// Formato (schema v2): { schemaVersion: 2, general: {...}, channels: {...} }.
// O estado fica em cache na memoria: leituras nao tocam o disco, e so ha
// gravacao quando algo realmente mudou. Antes, cada tick do titulo do Twish
// (1x por segundo) fazia uma leitura e uma gravacao completas.
// ---------------------------------------------------------------------------
let stateCache = null; // { general, channels }
let stateLoading = null;

async function loadState() {
  if (stateCache) return stateCache;
  if (!stateLoading) {
    stateLoading = (async () => {
      const stored = await browser.storage.local.get(["schemaVersion", "general", "channels"]);
      const channels = stored.channels || {};
      const general = AT.mergeGeneral(stored.general);
      const storedVersion = stored.schemaVersion || 1;
      let migrated = storedVersion < AT.SCHEMA_VERSION;

      // v3: o atraso passou a ter um padrao geral. Canais que estavam no
      // valor padrao antigo (10s) passam a seguir o geral; outros valores
      // viram excecao do canal.
      if (storedVersion < 3) {
        for (const settings of Object.values(channels)) {
          if (settings && Number(settings.maxJitterSeconds) === AT.DEFAULT_GENERAL_SETTINGS.defaultMaxJitterSeconds) {
            settings.maxJitterSeconds = null;
          }
        }
      }

      for (const settings of Object.values(channels)) {
        if (settings && LEGACY_ROD_IDS[settings.rod]) {
          settings.rod = LEGACY_ROD_IDS[settings.rod];
          migrated = true;
        }
      }

      if (migrated) {
        await browser.storage.local.set({ schemaVersion: AT.SCHEMA_VERSION, general, channels });
        console.log(`${AT.LOG_PREFIX} Configuracoes migradas para o formato v${AT.SCHEMA_VERSION}.`);
      }
      stateCache = { general, channels };
      return stateCache;
    })().finally(() => {
      stateLoading = null;
    });
  }
  return stateLoading;
}

// Se o armazenamento mudar por fora (ex: futura pagina de configuracoes
// gravando direto), o cache acompanha. Gravacoes do proprio background ja
// atualizam o cache antes, entao aqui nao muda nada nesse caso.
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !stateCache) return;
  if (changes.channels) stateCache.channels = changes.channels.newValue || {};
  if (changes.general) stateCache.general = AT.mergeGeneral(changes.general.newValue);
});

// Copia (pra ninguem alterar o cache sem passar pela fila de escrita).
async function getAllChannelSettings() {
  const state = await loadState();
  return structuredClone(state.channels);
}

async function getChannelSettings(channel) {
  const state = await loadState();
  return { ...DEFAULT_CHANNEL_SETTINGS, ...structuredClone(state.channels[channel] || {}) };
}

// Fila unica de escrita: TODA alteracao das configuracoes dos canais passa
// por aqui, uma de cada vez (evita que uma copia antiga sobrescreva uma
// mais nova — bug da reativacao sozinha, corrigido na v 0.1.4).
let channelsWriteQueue = Promise.resolve();

// Executa fn(channels) com acesso exclusivo; fn altera o objeto recebido.
// So grava no disco se algo mudou. Devolve o que fn devolver.
// Nunca chamar mutateChannels de dentro de outro mutateChannels (trava).
function mutateChannels(fn) {
  const run = channelsWriteQueue.then(async () => {
    const state = await loadState();
    const before = JSON.stringify(state.channels);
    const working = structuredClone(state.channels);
    const out = await fn(working);
    if (JSON.stringify(working) !== before) {
      state.channels = working;
      await browser.storage.local.set({ channels: working });
    }
    return out;
  });
  // A fila segue mesmo se esta operacao falhar.
  channelsWriteQueue = run.catch((e) => console.warn(`${AT.LOG_PREFIX} Falha ao gravar configuracoes:`, e));
  return run;
}

// Mesma fila, pras configuracoes gerais.
function mutateGeneral(fn) {
  const run = channelsWriteQueue.then(async () => {
    const state = await loadState();
    const working = structuredClone(state.general);
    const out = await fn(working);
    const merged = AT.mergeGeneral(working);
    if (JSON.stringify(merged) !== JSON.stringify(state.general)) {
      state.general = merged;
      await browser.storage.local.set({ general: merged });
    }
    return out;
  });
  channelsWriteQueue = run.catch((e) => console.warn(`${AT.LOG_PREFIX} Falha ao gravar configuracoes gerais:`, e));
  return run;
}

async function getGeneralSettings() {
  const state = await loadState();
  return structuredClone(state.general);
}

function computeJitterMs(settings) {
  // Atraso do canal (excecao) ou o padrao geral.
  const maxJitterSeconds = AT.effectiveJitterSeconds(settings, stateCache && stateCache.general);
  return Math.floor(Math.random() * (maxJitterSeconds * 1000 + 1));
}

// Mare Turbo (kind "cooldown_multiplier") reduz o CD da pesca pra value x o
// normal enquanto dura. Guardado em memoria por canal, atualizado pela
// consulta de eventos: { value, until }.
const cooldownMultipliers = new Map();

function cooldownMultiplierFor(channel) {
  const m = channel && cooldownMultipliers.get(channel);
  if (!m || m.until <= Date.now()) return 1;
  return m.value > 0 && m.value <= 1 ? m.value : 1;
}

// Estimativa do proximo envio pela vara (+ atraso). Se houver Mare Turbo
// ativa no canal, aplica o multiplicador ao tempo da vara.
function computeDelayMs(settings, channel) {
  const baseMinutes = ROD_MINUTES[settings.rod] || ROD_MINUTES[DEFAULT_ROD];
  const baseMs = baseMinutes * 60 * 1000 * cooldownMultiplierFor(channel);
  return baseMs + computeJitterMs(settings);
}

// O heartbeat (rede de seguranca, 1x por minuto) so existe enquanto houver
// pelo menos um canal ativado; sem nenhum, a extensao fica parada.
async function updateHeartbeat() {
  const channels = await getAllChannelSettings();
  const anyEnabled = Object.values(channels).some((s) => s && s.enabled);
  const existing = await browser.alarms.get(HEARTBEAT_NAME);
  if (anyEnabled && !existing) {
    await browser.alarms.create(HEARTBEAT_NAME, { periodInMinutes: 1 });
    console.log(`${AT.LOG_PREFIX} Heartbeat ligado (rede de seguranca, a cada 1 min).`);
  } else if (!anyEnabled && existing) {
    await browser.alarms.clear(HEARTBEAT_NAME);
    console.log(`${AT.LOG_PREFIX} Heartbeat desligado (nenhum canal ativado).`);
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
    console.warn(`${AT.LOG_PREFIX} Falha ao ler vara equipada na aba do Twish:`, e);
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

// ---------------------------------------------------------------------------
// API do Twish (dados da conta do jogador)
//
// GET https://twish.com.br/api/<canal>/me (precisa estar logado no site)
// traz, entre outros: cooldown_remaining (segundos), equipment.rod_id, login.
// Tenta primeiro direto daqui (com os cookies do jogador); se nao der, faz a
// mesma consulta de dentro de qualquer aba aberta do twish.com.br.
// ---------------------------------------------------------------------------
const POST_SEND_CHECK_DELAY_MS = 8 * 1000; // depois de pescar, espera o bot registrar antes de conferir
const CHECK_ALARM_PREFIX = "auto-twish-check:";

function isValidMe(j) {
  return j && typeof j === "object" && typeof j.cooldown_remaining === "number";
}

async function fetchTwishMe(channel) {
  const url = `https://twish.com.br/api/${encodeURIComponent(channel)}/me`;

  try {
    const r = await fetch(url, { credentials: "include", cache: "no-store" });
    if (r.ok) {
      const j = await r.json();
      if (isValidMe(j)) return { data: j, via: "conta" };
    }
  } catch (e) {
    // sem rede / bloqueado: tenta pela aba
  }

  try {
    const tabs = await browser.tabs.query({ url: TWISH_URL_PATTERNS });
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      try {
        const results = await browser.scripting.executeScript({
          target: { tabId: tab.id },
          func: (u) =>
            fetch(u, { credentials: "include", cache: "no-store" })
              .then((r) => (r.ok ? r.json() : null))
              .catch(() => null),
          args: [url]
        });
        const j = results?.[0]?.result;
        if (isValidMe(j)) return { data: j, via: "conta (pela aba)" };
      } catch (e) {
        // aba sem permissao/fechando: tenta a proxima
      }
    }
  } catch (e) {
    // ignora
  }
  return null;
}

// Converte a resposta de /me no formato usado aqui.
function parseTwishMe(me) {
  const d = me.data;
  const remainingMs = Math.max(0, d.cooldown_remaining) * 1000;
  const rodId = d.equipment && AT.ROD_MINUTES[d.equipment.rod_id] !== undefined ? d.equipment.rod_id : null;
  return { availableAt: Date.now() + remainingMs, rodId, login: d.login || null, via: me.via };
}

// Guarda o login do jogador no Twish (o mesmo em todos os canais); usado
// pra saber quando um convite de duelo e pra ele.
async function rememberTwishLogin(login) {
  if (!login) return;
  await mutateGeneral((g) => {
    g.twishLogin = String(login).toLowerCase();
  });
}

// Procura dados do Twish pro canal: primeiro pela conta (API), depois pelo
// titulo da aba aberta. Devolve o horario real de disponibilidade e a vara
// equipada (cada um null se nao foi possivel descobrir).
async function syncTwishForChannel(channel) {
  const me = await fetchTwishMe(channel);
  if (me) {
    const parsed = parseTwishMe(me);
    await rememberTwishLogin(parsed.login);
    console.log(
      `${AT.LOG_PREFIX} Sincronizacao com o Twish ("${channel}") pela ${parsed.via}: ` +
        (parsed.availableAt <= Date.now() + 1000 ? "pesca disponivel" : `disponivel as ${new Date(parsed.availableAt).toLocaleTimeString()}`) +
        `; vara ${parsed.rodId || "nao detectada"}`
    );
    return { found: true, availableAt: parsed.availableAt, rodId: parsed.rodId, source: "api" };
  }
  const fromTab = await syncTwishFromTab(channel);
  return { ...fromTab, source: fromTab.found ? "tab" : null };
}

// Plano B: titulo da aba do Twish + vara lida da pagina.
async function syncTwishFromTab(channel) {
  let availableAt = null;
  let rodId = null;
  let found = false; // achou alguma aba do Twish desse canal?
  let rawTitle = null; // titulo lido (pro log, quando nao reconhecido)

  try {
    const tabs = await browser.tabs.query({ url: TWISH_URL_PATTERNS });
    for (const tab of tabs) {
      if (extractChannelFromTwishUrl(tab.url || "") !== channel) continue;
      found = true;

      if (availableAt === null) {
        rawTitle = tab.title || "";
        const parsed = parseTwishTitle(rawTitle);
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
    console.warn(`${AT.LOG_PREFIX} Falha ao sincronizar com abas do Twish:`, e);
  }

  console.log(
    `${AT.LOG_PREFIX} Sincronizacao com o Twish ("${channel}") pela aba (API indisponivel — logado no twish.com.br?): ` +
    (found
      ? `aba encontrada; ${availableAt === null ? `titulo nao reconhecido (${JSON.stringify(rawTitle)})` : availableAt <= Date.now() + 1000 ? "pesca disponivel" : `disponivel as ${new Date(availableAt).toLocaleTimeString()}`}; vara ${rodId || "nao detectada"}`
      : "nenhuma aba do Twish aberta para esse canal")
  );
  return { found, availableAt, rodId };
}

// Registra uma leitura de cooldown do Twish para um canal e, se esse canal
// estiver ativado, corrige nextFireAt com o horario real (+ o atraso
// configurado). Leituras passivas (titulo mudando, heartbeat) so corrigem
// no modo automatico; leituras explicitas (abrir o popup, trocar o modo)
// corrigem em qualquer modo. Ignora leituras "disponivel agora" que
// cheguem logo apos um envio nosso (o titulo ainda nao foi atualizado pelo
// TwishGameBot, entao a leitura e velha).
async function recordTwishCooldown(channel, availableAt, explicit = false) {
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
    const hasPrevious = previousAvailableAt !== null && previousAvailableAt !== undefined;
    const isSameCooldown =
      hasPrevious &&
      (Math.abs(availableAt - previousAvailableAt) < SAME_COOLDOWN_TOLERANCE_MS ||
        // "Disponivel agora" lido de novo, sem cooldown novo no meio: e o
        // mesmo estado (antes, cada releitura resorteava o atraso e podia
        // ficar empurrando o envio pra frente).
        (previousAvailableAt <= now + SAME_COOLDOWN_TOLERANCE_MS && availableAt <= now + SAME_COOLDOWN_TOLERANCE_MS));

    if (!isSameCooldown) {
      settings.twishAvailableAt = availableAt;
      settings.twishLastSeen = now;
    } else if (!settings.twishLastSeen || now - settings.twishLastSeen >= LAST_SEEN_PERSIST_MS) {
      // Mesmo cooldown: so atualiza o "visto por ultimo" de vez em quando
      // (suficiente pra saber se o dado esta fresco; evita gravar 1x/s).
      settings.twishLastSeen = now;
    }

    if (!settings.enabled) return null;
    if (!AT.followsTwish(settings.mode) && !explicit) return null; // manual so segue o Twish em sincronizacao explicita

    const justSent = settings.lastSentAt && now - settings.lastSentAt < JUST_SENT_GUARD_MS;
    const isFreshCooldown = availableAt > now + 3000;
    if (justSent && !isFreshCooldown) return null; // leitura velha logo apos um envio nosso
    // Semi-automatico esperando o jogador enviar: so um cooldown novo (sinal
    // de que ele pescou) muda alguma coisa.
    if (settings.awaitingUser && !isFreshCooldown) return null;

    // Mesmo no "mesmo cooldown", corrige o agendamento se ele estiver mais
    // tarde do que o cooldown real permite (ex: estimativa de 10 min da vara
    // depois de um envio que o TwishGameBot nao respondeu, ou agendamento
    // feito antes da aba do Twish ser aberta).
    const latestAcceptable =
      Math.max(now, availableAt) + AT.effectiveJitterSeconds(settings, stateCache && stateCache.general) * 1000 + 2000;
    const scheduleIsWrong = !settings.nextFireAt || settings.nextFireAt > latestAcceptable;
    if (isSameCooldown && !scheduleIsWrong) return null;

    settings.awaitingUser = false; // cooldown novo = o jogador pescou (semi) ou o envio pegou
    settings.nextFireAt = Math.max(now, availableAt) + computeJitterMs(settings);
    return settings.nextFireAt;
  });

  if (rescheduled) {
    await scheduleDueAlarm(channel, rescheduled);
    console.log(`${AT.LOG_PREFIX} (Twish) "${channel}" cooldown real detectado; proximo envio as ${new Date(rescheduled).toLocaleTimeString()}`);
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
    console.warn(`${AT.LOG_PREFIX} Falha ao sincronizar abas do Twish na inicializacao:`, e);
  }
}

// Tenta enviar a mensagem fixa pra(s) aba(s) do canal e reporta se o
// content.js confirmou que o texto foi digitado e o envio foi disparado.
// NAO confirma que o TwishGameBot de fato respondeu — so que o envio
// local (Twitch) funcionou.
async function attemptSend(channel, text = FIXED_MESSAGE) {
  const tabs = await browser.tabs.query({ url: "*://*.twitch.tv/*" });
  const targets = tabs.filter((t) => extractChannelFromUrl(t.url) === channel);

  if (targets.length === 0) {
    console.warn(`${AT.LOG_PREFIX} Nenhuma aba aberta para "${channel}"; nao foi possivel enviar.`);
    return { ok: false, reason: "no-tab" };
  }

  let anyOk = false;
  const reasons = [];

  for (const tab of targets) {
    try {
      const result = await browser.tabs.sendMessage(tab.id, { type: "SEND_CHAT_MESSAGE", text });
      if (result?.ok) {
        anyOk = true;
      } else {
        reasons.push(result?.reason || "unknown");
      }
    } catch (e) {
      reasons.push("no-content-script");
      console.warn(`${AT.LOG_PREFIX} Falha ao enviar para a aba ${tab.id}:`, e);
    }
  }

  if (!anyOk) {
    console.warn(`${AT.LOG_PREFIX} Envio para "${channel}" falhou em todas as abas (${reasons.join(", ") || "sem detalhes"}).`);
  }

  return { ok: anyOk, reason: anyOk ? undefined : (reasons[0] || "unknown") };
}

// Aplica uma alteracao (parcial) nas configuracoes de um canal. O popup e a
// pagina de configuracoes mandam so o que mudou (ex: { mode: "semi" }).
// Ativar, trocar o modo ou a vara reagenda o proximo envio (com
// sincronizacao com o Twish); mudar so o atraso nao mexe no agendamento.
async function applyChannelSettings(channel, patch) {
  patch = patch || {};
  const reschedules = ["enabled", "mode", "rod"].some((k) => k in patch);

  // Busca dado fresco do Twish (cooldown real E vara equipada) ANTES de
  // entrar na fila de escrita — a leitura da pagina pode demorar.
  const twish = reschedules ? await syncTwishForChannel(channel) : { availableAt: null, rodId: null };

  const settings = await mutateChannels((channels) => {
    const previous = { ...DEFAULT_CHANNEL_SETTINGS, ...(channels[channel] || {}) };
    const now = Date.now();
    const s = { ...previous };

    if ("enabled" in patch) s.enabled = !!patch.enabled;
    if ("mode" in patch) s.mode = AT.MODES.includes(patch.mode) ? patch.mode : "manual";
    if ("rod" in patch) s.rod = AT.ROD_MINUTES[patch.rod] !== undefined ? patch.rod : DEFAULT_ROD;
    if ("notifyEvents" in patch) s.notifyEvents = !!patch.notifyEvents;
    if ("maxJitterSeconds" in patch) {
      s.maxJitterSeconds = patch.maxJitterSeconds === null ? null : clampJitterSeconds(patch.maxJitterSeconds);
    }

    if (twish.availableAt !== null) {
      s.twishAvailableAt = twish.availableAt;
      s.twishLastSeen = now;
    }
    if (twish.rodId) {
      s.rod = twish.rodId; // vara equipada detectada tem prioridade sobre a selecao manual
    }

    if (!s.enabled) {
      s.nextFireAt = null;
      s.awaitingUser = false;
    } else if (reschedules) {
      const isActivating = !previous.enabled; // transicao desativado -> ativado
      s.awaitingUser = false;
      const twishFresh =
        s.twishAvailableAt !== null && s.twishLastSeen && now - s.twishLastSeen < TWISH_DATA_FRESH_MS;
      const availableNow = twishFresh && s.twishAvailableAt <= now + 1000;

      if (isActivating && availableNow) {
        // Acabou de ativar e o Twish mostra a pesca disponivel: dispara ja,
        // em qualquer modo, sem somar o atraso aleatorio (ele existe pra
        // disfarcar o ritmo dos envios recorrentes, nao o primeiro).
        s.nextFireAt = now;
      } else if (twishFresh) {
        s.nextFireAt = Math.max(now, s.twishAvailableAt) + computeJitterMs(s);
      } else {
        s.nextFireAt = now + computeDelayMs(s, channel);
      }
    }

    channels[channel] = s;
    return s;
  });

  await updateHeartbeat();
  await updateEventsPoller();
  if ("notifyEvents" in patch && settings.notifyEvents) refreshEvents(channel, false); // estado inicial, sem notificar o que ja estava rolando
  if (!settings.enabled || reschedules) {
    await scheduleDueAlarm(channel, settings.nextFireAt);
  }
  if (!settings.enabled) clearSemiNotification(channel);
  console.log(
    `${AT.LOG_PREFIX} Configuracao de "${channel}" alterada (${Object.keys(patch).join(", ") || "nada"}):`,
    settings,
    settings.nextFireAt ? `Proximo envio as ${new Date(settings.nextFireAt).toLocaleTimeString()}` : "(sem envio agendado)"
  );
  return settings;
}

async function removeChannel(channel) {
  await mutateChannels((channels) => {
    delete channels[channel];
  });
  await scheduleDueAlarm(channel, null);
  clearSemiNotification(channel);
  await updateHeartbeat();
  await updateEventsPoller();
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
      s.nextFireAt = now + computeDelayMs({ ...DEFAULT_CHANNEL_SETTINGS, ...s }, channel);
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

// ---------------------------------------------------------------------------
// Semi-automatico
// ---------------------------------------------------------------------------

async function twitchTabsForChannel(channel) {
  const tabs = await browser.tabs.query({ url: "*://*.twitch.tv/*" });
  return tabs.filter((t) => extractChannelFromUrl(t.url) === channel);
}

// So DIGITA o comando no chat (sem enviar). O content.js nao apaga um texto
// que o jogador esteja escrevendo: nesse caso so avisa.
async function attemptType(channel) {
  const targets = await twitchTabsForChannel(channel);
  if (targets.length === 0) return { ok: false, reason: "no-tab" };
  let lastReason = "unknown";
  for (const tab of targets) {
    try {
      const result = await browser.tabs.sendMessage(tab.id, { type: "TYPE_CHAT_MESSAGE", text: FIXED_MESSAGE });
      if (result?.ok) return { ok: true, tab, typed: !!result.typed };
      lastReason = result?.reason || "unknown";
    } catch (e) {
      lastReason = "no-content-script";
    }
  }
  return { ok: false, reason: lastReason };
}

function semiNotificationId(channel) {
  return `semi:${channel}`;
}

function clearSemiNotification(channel) {
  try {
    browser.notifications.clear(semiNotificationId(channel));
  } catch (e) {
    // sem permissao/suporte: nada a limpar
  }
}

async function focusTab(tab) {
  try {
    await browser.tabs.update(tab.id, { active: true });
    await browser.windows.update(tab.windowId, { focused: true });
  } catch (e) {
    console.warn(`${AT.LOG_PREFIX} Nao consegui focar a aba da Twitch:`, e);
  }
}

// Chama o jogador conforme as opcoes gerais do semi-automatico.
async function alertUser(channel, tab, typed) {
  const { semiAuto } = await getGeneralSettings();
  if (semiAuto.focusTab && tab) await focusTab(tab);
  if (semiAuto.notify) {
    try {
      await browser.notifications.create(semiNotificationId(channel), {
        type: "basic",
        title: "Auto Twish — pesca disponível",
        message: typed
          ? `${FIXED_MESSAGE} digitado no chat de ${channel}. Aperte Enter para pescar.`
          : `Pesca disponível em ${channel} (o campo do chat já tinha texto, então não digitei nada).`
      });
    } catch (e) {
      console.warn(`${AT.LOG_PREFIX} Falha ao mostrar notificacao:`, e);
    }
  }
}

async function prepareSemiAuto(channel, source) {
  const result = await attemptType(channel);
  const nextFireAt = await mutateChannels((channels) => {
    const s = channels[channel];
    if (!s || !s.enabled || s.mode !== "semi") return null;
    if (result.ok) {
      s.awaitingUser = true;
      s.nextFireAt = null; // agora quem manda e o jogador
    } else {
      s.nextFireAt = Date.now() + RETRY_DELAY_MS;
    }
    return s.nextFireAt;
  });
  await scheduleDueAlarm(channel, nextFireAt);

  if (result.ok) {
    console.log(`${AT.LOG_PREFIX} (${source}) Semi-automatico: "${channel}" pronto, esperando o jogador enviar.`);
    await alertUser(channel, result.tab, result.typed);
  } else {
    console.warn(`${AT.LOG_PREFIX} (${source}) Semi-automatico: falha ao digitar em "${channel}" (${result.reason}); nova tentativa em ${RETRY_DELAY_MS / 1000}s.`);
  }
}

// O jogador enviou o comando de pesca por conta propria (Enter ou botao no
// chat), em qualquer modo: reinicia o ciclo a partir de agora, pra extensao
// nao mandar outro durante o cooldown. No automatico/semi, o titulo do
// Twish refina o horario em seguida.
async function recordUserSent(channel) {
  const nextFireAt = await mutateChannels((channels) => {
    const s = channels[channel];
    if (!s || !s.enabled) return undefined;
    const now = Date.now();
    s.awaitingUser = false;
    s.lastSentAt = now;
    s.nextFireAt = now + computeDelayMs({ ...DEFAULT_CHANNEL_SETTINGS, ...s }, channel);
    return s.nextFireAt;
  });
  if (nextFireAt === undefined) return;
  clearSemiNotification(channel);
  await scheduleDueAlarm(channel, nextFireAt);
  schedulePostSendCheck(channel);
  console.log(`${AT.LOG_PREFIX} "${channel}": ${FIXED_MESSAGE} enviado pelo jogador; proximo as ${new Date(nextFireAt).toLocaleTimeString()}.`);
}

// ---------------------------------------------------------------------------
// Estado do jogo por canal (eventos, peixe em destaque, convite de duelo).
// Fica numa chave propria (gameState), separada das configuracoes.
// ---------------------------------------------------------------------------
let gameStateQueue = Promise.resolve();

function mutateGameState(channel, fn) {
  const run = gameStateQueue.then(async () => {
    const { gameState } = await browser.storage.local.get("gameState");
    const all = gameState || {};
    const before = JSON.stringify(all[channel] || {});
    const cur = all[channel] || {};
    const out = await fn(cur);
    if (JSON.stringify(cur) !== before) {
      all[channel] = cur;
      await browser.storage.local.set({ gameState: all });
    }
    return out;
  });
  gameStateQueue = run.catch((e) => console.warn(`${AT.LOG_PREFIX} Falha ao gravar estado do jogo:`, e));
  return run;
}

// Eventos: API publica do Twish (nao precisa de login).
async function fetchActiveEvents(channel) {
  try {
    const r = await fetch(`https://twish.com.br/api/${encodeURIComponent(channel)}/events/active`, { cache: "no-store" });
    if (!r.ok) return null;
    const j = await r.json();
    return { event: j.event || null, grande_evento: j.grande_evento || null, fetchedAt: Date.now() };
  } catch (e) {
    return null;
  }
}

function eventKeys(ev) {
  const keys = [];
  if (ev && ev.event) keys.push(`event:${ev.event.name}`);
  if (ev && ev.grande_evento) keys.push(`grande:${ev.grande_evento.name}`);
  return keys;
}

// Atualiza os eventos de um canal; se notify, avisa os que acabaram de comecar.
async function refreshEvents(channel, notify) {
  const ev = await fetchActiveEvents(channel);
  if (!ev) return null;
  const turbo = ev.event && ev.event.kind === "cooldown_multiplier" ? ev.event : null;
  if (turbo) cooldownMultipliers.set(channel, { value: Number(turbo.value), until: Date.now() + turbo.seconds_remaining * 1000 });
  else cooldownMultipliers.delete(channel);
  const started = await mutateGameState(channel, (st) => {
    const oldKeys = eventKeys(st.events);
    // So guarda o que mudou de fato (o tempo restante muda a cada consulta).
    const sameSet = JSON.stringify(oldKeys) === JSON.stringify(eventKeys(ev));
    if (!sameSet || !st.events) st.events = ev;
    else if (ev.event || ev.grande_evento) st.events = ev; // atualiza o tempo restante enquanto houver evento
    return eventKeys(ev).filter((k) => !oldKeys.includes(k));
  });
  if (notify && started.length) {
    for (const item of [ev.grande_evento, ev.event].filter(Boolean)) {
      try {
        await browser.notifications.create(`event:${channel}:${item.name}`, {
          type: "basic",
          title: `${item.emoji || "🎉"} ${item.name} em ${channel}`,
          message: `${item.message ? item.message + " — " : ""}termina em ${AT.formatRemaining(item.seconds_remaining * 1000)}.`
        });
      } catch (e) {
        console.warn(`${AT.LOG_PREFIX} Falha ao notificar evento:`, e);
      }
    }
    console.log(`${AT.LOG_PREFIX} Evento(s) novo(s) em "${channel}":`, started);
  }
  return ev;
}

// Consulta de eventos: 1x por minuto, enquanto algum canal estiver ativado
// (evento novo pode zerar o CD da pesca — ex: Mare Turbo) ou tiver
// "Notificar eventos" ligado.
function watchesEvents(s) {
  return !!(s && (s.notifyEvents || s.enabled));
}

async function updateEventsPoller() {
  const channels = await getAllChannelSettings();
  const any = Object.values(channels).some(watchesEvents);
  const existing = await browser.alarms.get(AT.EVENTS_ALARM_NAME);
  if (any && !existing) await browser.alarms.create(AT.EVENTS_ALARM_NAME, { periodInMinutes: 1 });
  else if (!any && existing) await browser.alarms.clear(AT.EVENTS_ALARM_NAME);
}

async function pollEvents() {
  const channels = await getAllChannelSettings();
  for (const [channel, s] of Object.entries(channels)) {
    if (!watchesEvents(s)) continue;
    const before = await browser.storage.local.get("gameState");
    const hadKeys = eventKeys(((before.gameState || {})[channel] || {}).events);
    const ev = await refreshEvents(channel, !!s.notifyEvents);
    const isNew = ev && eventKeys(ev).some((k) => !hadKeys.includes(k));
    // Evento comecando pode zerar o CD da pesca (ex: Mare Turbo): confere a conta.
    if (isNew && s.enabled) schedulePostSendCheck(channel, 3000);
  }
}

// Mensagens do TwishGameBot lidas no chat (content.js).
async function onFeaturedFish(channel, fish) {
  await mutateGameState(channel, (st) => {
    st.featured = { fish, seenAt: Date.now() };
  });
  console.log(`${AT.LOG_PREFIX} Peixe em destaque em "${channel}": ${fish}`);
}

async function onDuelInvite(channel, challenger, target, windowSeconds) {
  const general = await getGeneralSettings();
  if (!general.twishLogin || target.toLowerCase() !== general.twishLogin) return; // convite pra outra pessoa
  const expiresAt = Date.now() + windowSeconds * 1000;
  await mutateGameState(channel, (st) => {
    st.duelInvite = { from: challenger, expiresAt };
  });
  console.log(`${AT.LOG_PREFIX} Convite de duelo em "${channel}" de @${challenger} (${windowSeconds}s pra aceitar).`);
  if (general.notifyDuelInvites) {
    try {
      await browser.notifications.create(`duel:${channel}`, {
        type: "basic",
        title: `⚔️ Duelo em ${channel}`,
        message: `@${challenger} te desafiou! Você tem ${AT.formatRemaining(windowSeconds * 1000)} pra usar $aceitar.`
      });
    } catch (e) {
      console.warn(`${AT.LOG_PREFIX} Falha ao notificar duelo:`, e);
    }
  }
}

async function onDuelEnd(channel, mentions) {
  const general = await getGeneralSettings();
  const me = general.twishLogin;
  if (!me || !mentions.some((m) => m.toLowerCase() === me)) return; // duelo de outras pessoas
  const until = Date.now() + AT.DUEL_COOLDOWN_MS;
  await mutateGameState(channel, (st) => {
    st.duelCooldownUntil = until;
    delete st.duelInvite;
  });
  try {
    browser.notifications.clear(`duel:${channel}`);
  } catch (e) {}
  console.log(`${AT.LOG_PREFIX} Duelo terminou em "${channel}" (${mentions.join(", ")}); proximo duelo as ${new Date(until).toLocaleTimeString()}.`);
}

// O jogador mandou um comando que nao e o de pesca (ex: $aceitar, entrar em
// torneio): alguns zeram o CD da pesca, entao confere a conta logo depois.
async function onUserOtherCommand(channel, text) {
  if (/^\$aceitar\b/i.test(text)) {
    await mutateGameState(channel, (st) => {
      delete st.duelInvite;
    });
  }
  const s = (await getAllChannelSettings())[channel];
  if (s && s.enabled) schedulePostSendCheck(channel, 5000);
}

// Ponto unico de disparo, usado tanto pelo alarme dedicado quanto pelo
// heartbeat. Usa um lock em memoria (inFlightChannels) pra garantir que,
// mesmo se os dois dispararem quase juntos, so um envio real aconteca.
async function processChannelIfDue(channel, source) {
  if (inFlightChannels.has(channel)) {
    console.log(`${AT.LOG_PREFIX} "${channel}" ja esta sendo processado; ignorando disparo duplicado vindo de "${source}".`);
    return;
  }
  inFlightChannels.add(channel);

  try {
    const settings = (await getAllChannelSettings())[channel];
    if (!settings || !settings.enabled) return;

    if (settings.awaitingUser) return; // semi: ja digitado, esperando o jogador
    if (settings.nextFireAt && Date.now() < settings.nextFireAt) return; // ainda nao esta na hora

    // Auto/semi: confere o cooldown real pela conta antes de agir, pra
    // nunca mandar o comando durante o cooldown.
    if (AT.followsTwish(settings.mode)) {
      const me = await fetchTwishMe(channel);
      if (me) {
        const parsed = parseTwishMe(me);
        const remainingMs = parsed.availableAt - Date.now();
        if (remainingMs > 1500) {
          const next = await rescheduleTo(channel, parsed.availableAt);
          console.log(`${AT.LOG_PREFIX} (${source}) "${channel}" ainda em cooldown pela conta (${Math.round(remainingMs / 1000)}s); reagendado para ${next ? new Date(next).toLocaleTimeString() : "-"}.`);
          return;
        }
      }
    }

    if (settings.mode === "semi") {
      await prepareSemiAuto(channel, source);
      return;
    }

    const result = await attemptSend(channel);
    const nextFireAt = await recordSendResult(channel, result.ok);
    if (result.ok && AT.followsTwish(settings.mode)) schedulePostSendCheck(channel);

    if (!result.ok) {
      console.warn(`${AT.LOG_PREFIX} (${source}) Falha ao enviar para "${channel}" (${result.reason}); nova tentativa em ${RETRY_DELAY_MS / 1000}s.`);
    }
    console.log(
      nextFireAt
        ? `${AT.LOG_PREFIX} (${source}) Proximo envio para "${channel}" as ${new Date(nextFireAt).toLocaleTimeString()}`
        : `${AT.LOG_PREFIX} (${source}) "${channel}" foi desativado durante o envio; nada reagendado.`
    );
  } finally {
    inFlightChannels.delete(channel);
  }
}

// Reagenda o canal pro horario real informado pelo Twish (+ atraso).
async function rescheduleTo(channel, availableAt) {
  const next = await mutateChannels((channels) => {
    const s = channels[channel];
    if (!s || !s.enabled) return null;
    s.twishAvailableAt = availableAt;
    s.twishLastSeen = Date.now();
    s.nextFireAt = Math.max(Date.now(), availableAt) + computeJitterMs(s);
    return s.nextFireAt;
  });
  if (next) await scheduleDueAlarm(channel, next);
  return next;
}

// Alguns segundos depois de pescar, confere pela conta o cooldown novo e
// acerta o proximo horario (vale mesmo sem a aba do Twish aberta).
function schedulePostSendCheck(channel, delayMs = POST_SEND_CHECK_DELAY_MS) {
  browser.alarms.create(`${CHECK_ALARM_PREFIX}${channel}`, { when: Date.now() + delayMs });
}

async function postSendCheck(channel) {
  const me = await fetchTwishMe(channel);
  if (!me) return; // sem API: fica a estimativa da vara (e o titulo da aba, se aberta)
  const parsed = parseTwishMe(me);
  await recordTwishCooldown(channel, parsed.availableAt, true);
}

// Rede de seguranca: varre todos os canais ativos a cada 1 min. So deve
// realmente disparar algo se o alarme dedicado correspondente tiver falhado.
async function heartbeatTick() {
  // Rele os titulos das abas do Twish (barato: so uma consulta de abas).
  // Assim o modo automatico se corrige sozinho mesmo quando o titulo nao
  // muda — ex: TwishGameBot nao respondeu e a aba continua em "Twish".
  const channels = await getAllChannelSettings();
  if (Object.values(channels).some((s) => s && s.enabled && s.mode === "auto")) {
    await syncAllTwishTabs();
  }
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
    console.warn(`${AT.LOG_PREFIX} Falha ao limpar alarmes antigos:`, e);
  }
}

// Ao acordar, recupera Mare Turbo ainda ativa a partir do ultimo estado salvo.
async function restoreCooldownMultipliers() {
  const { gameState } = await browser.storage.local.get("gameState");
  for (const [channel, st] of Object.entries(gameState || {})) {
    const ev = st && st.events && st.events.event;
    if (!ev || ev.kind !== "cooldown_multiplier") continue;
    const until = (st.events.fetchedAt || 0) + ev.seconds_remaining * 1000;
    if (until > Date.now()) cooldownMultipliers.set(channel, { value: Number(ev.value), until });
  }
}

async function bootstrap() {
  await restoreCooldownMultipliers();
  await clearLegacyAlarms();
  await updateHeartbeat();
  await updateEventsPoller();
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
      const twish = await syncTwishForChannel(channel);
      const existing = (await getAllChannelSettings())[channel];

      if (existing) {
        if (twish.availableAt !== null) {
          // Sincronizacao explicita: corrige o agendamento em qualquer modo
          // (respeitando "mesmo cooldown" e "acabou de enviar").
          await recordTwishCooldown(channel, twish.availableAt, true);
        }
        if (twish.rodId) {
          await mutateChannels((channels) => {
            if (channels[channel]) channels[channel].rod = twish.rodId;
          });
        }
      }
      // Canal nunca salvo: nao grava nada, mas devolve o que foi lido
      // (o popup usa pra pre-selecionar a vara e mostrar o status).

      sendResponse({ settings: existing ? await getChannelSettings(channel) : null, twish });
    })();
    return true;
  }

  if (msg?.type === "GET_ALL_STATE") {
    (async () => {
      const general = await getGeneralSettings();
      const raw = await getAllChannelSettings();
      const channels = {};
      for (const [name, s] of Object.entries(raw)) channels[name] = { ...DEFAULT_CHANNEL_SETTINGS, ...s };
      sendResponse({ general, channels });
    })();
    return true;
  }

  if (msg?.type === "UPDATE_GENERAL_SETTINGS") {
    (async () => {
      const patch = msg.patch || {};
      await mutateGeneral((g) => {
        if ("defaultMaxJitterSeconds" in patch) g.defaultMaxJitterSeconds = clampJitterSeconds(patch.defaultMaxJitterSeconds);
        if ("notifyDuelInvites" in patch) g.notifyDuelInvites = !!patch.notifyDuelInvites;
        if (patch.semiAuto) {
          g.semiAuto = { ...g.semiAuto };
          if ("focusTab" in patch.semiAuto) g.semiAuto.focusTab = !!patch.semiAuto.focusTab;
          if ("notify" in patch.semiAuto) g.semiAuto.notify = !!patch.semiAuto.notify;
        }
      });
      sendResponse({ general: await getGeneralSettings() });
    })();
    return true;
  }

  if (msg?.type === "REMOVE_CHANNEL") {
    removeChannel(msg.channel).then(() => sendResponse({ ok: true }));
    return true;
  }

  // Vem do content.js: mensagens do TwishGameBot lidas no chat.
  if (msg?.type === "CHAT_FEATURED_FISH" || msg?.type === "CHAT_DUEL_INVITE" || msg?.type === "CHAT_DUEL_END") {
    const channel = extractChannelFromUrl(sender?.tab?.url || "");
    if (!channel) return false;
    if (msg.type === "CHAT_FEATURED_FISH" && msg.fish) onFeaturedFish(channel, String(msg.fish).slice(0, 60));
    if (msg.type === "CHAT_DUEL_END" && Array.isArray(msg.mentions)) onDuelEnd(channel, msg.mentions.slice(0, 10).map(String));
    if (msg.type === "CHAT_DUEL_INVITE" && msg.challenger && msg.target) {
      onDuelInvite(channel, String(msg.challenger), String(msg.target), Math.max(1, Number(msg.windowSeconds) || 300));
    }
    return false;
  }

  // Popup: estado do jogo do canal (atualiza os eventos na hora).
  if (msg?.type === "GET_GAME_STATE") {
    (async () => {
      await refreshEvents(msg.channel, false);
      const { gameState } = await browser.storage.local.get("gameState");
      sendResponse({ state: (gameState || {})[msg.channel] || {} });
    })();
    return true;
  }

  // Popup: envia um comando avulso no chat (ex: $destaque), so quando o jogador clica.
  if (msg?.type === "SEND_CHAT_COMMAND") {
    const allowed = ["$destaque"];
    if (!allowed.includes(msg.text)) {
      sendResponse({ ok: false, reason: "comando-nao-permitido" });
      return false;
    }
    attemptSend(msg.channel, msg.text).then((r) => sendResponse(r));
    return true;
  }

  // Vem do content.js: o jogador enviou o comando de pesca manualmente.
  if (msg?.type === "USER_SENT_COMMAND") {
    const channel = extractChannelFromUrl(sender?.tab?.url || "");
    if (channel && msg.text === FIXED_MESSAGE) recordUserSent(channel);
    else if (channel && typeof msg.text === "string" && msg.text.startsWith("$")) onUserOtherCommand(channel, msg.text);
    return false;
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

if (browser.notifications && browser.notifications.onClicked) {
  browser.notifications.onClicked.addListener(async (id) => {
    const m = /^(semi|duel|event):([^:]+)/.exec(id);
    if (!m) return;
    const channel = m[2];
    const [tab] = await twitchTabsForChannel(channel);
    if (tab) await focusTab(tab);
    browser.notifications.clear(id);
  });
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === HEARTBEAT_NAME) {
    heartbeatTick();
    return;
  }
  if (alarm.name === AT.EVENTS_ALARM_NAME) {
    pollEvents();
    return;
  }
  if (alarm.name.startsWith(CHECK_ALARM_PREFIX)) {
    postSendCheck(alarm.name.slice(CHECK_ALARM_PREFIX.length));
    return;
  }
  const channel = channelFromDueAlarmName(alarm.name);
  if (channel) {
    processChannelIfDue(channel, "alarme dedicado");
  }
});

// So acorda a extensao quando o TITULO de uma aba do Twish muda. Antes, o
// listener recebia qualquer mudanca de qualquer aba do navegador (carregar,
// icone, audio, titulo da Twitch...) e filtrava depois.
function onTwishTabUpdated(tabId, changeInfo, tab) {
  if (changeInfo.title === undefined) return;
  handleTwishTabUpdate(tab).catch((e) => console.warn(`${AT.LOG_PREFIX} Falha ao processar titulo do Twish:`, e));
}
try {
  browser.tabs.onUpdated.addListener(onTwishTabUpdated, { urls: TWISH_URL_PATTERNS, properties: ["title"] });
} catch (e) {
  // Navegador sem suporte ao filtro: cai pro listener sem filtro.
  browser.tabs.onUpdated.addListener(onTwishTabUpdated);
}
