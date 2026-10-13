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
// Turbo ativo (kit.js): { until, cdMs } — Turbo de Pesca 20 s, Turbo Torneio 10 s.
const boostUntil = new Map();

function computeDelayMs(settings, channel) {
  const baseMinutes = ROD_MINUTES[settings.rod] || ROD_MINUTES[DEFAULT_ROD];
  let baseMs = baseMinutes * 60 * 1000 * cooldownMultiplierFor(channel);
  const boost = boostUntil.get(channel);
  if (boost && boost.until > Date.now()) baseMs = Math.min(baseMs, boost.cdMs);
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
  } else if (!anyEnabled && existing && !safetyLocked) {
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

// Chamada generica a API do Twish com o login do jogador. Tenta direto
// daqui; se o site responder 401/403 (cookies nao enviados), repete a mesma
// chamada de dentro de uma aba aberta do twish.com.br.
// Devolve { ok, status, data, via } (ok=false com status 0 se nao deu).
// Pra POST so repete pela aba quando a primeira resposta foi 401/403 (o
// pedido nao foi aceito), nunca depois de erro de rede (evita compra dupla).
async function twishApi(path, { method = "GET", body } = {}) {
  const url = `https://twish.com.br${path}`;
  const init = {
    method,
    credentials: "include",
    cache: "no-store",
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined
  };

  let direct = null;
  try {
    const r = await fetch(url, init);
    const text = await r.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch (e) {
      data = null;
    }
    direct = { ok: r.ok, status: r.status, data, via: "conta" };
    if (r.ok || (r.status !== 401 && r.status !== 403)) return direct;
  } catch (e) {
    if (method !== "GET") return { ok: false, status: 0, data: null, via: "erro de rede" };
  }

  try {
    const tabs = await browser.tabs.query({ url: TWISH_URL_PATTERNS });
    for (const tab of tabs) {
      if (tab.id === undefined) continue;
      try {
        const results = await browser.scripting.executeScript({
          target: { tabId: tab.id },
          func: (u, i) =>
            fetch(u, i)
              .then(async (r) => {
                const t = await r.text();
                let d = null;
                try {
                  d = t ? JSON.parse(t) : null;
                } catch (e) {}
                return { ok: r.ok, status: r.status, data: d };
              })
              .catch(() => null),
          args: [url, init]
        });
        const res = results?.[0]?.result;
        if (res && (res.ok || (res.status !== 401 && res.status !== 403))) return { ...res, via: "conta (pela aba)" };
      } catch (e) {
        // aba sem permissao/fechando: tenta a proxima
      }
    }
  } catch (e) {
    // ignora
  }
  return direct || { ok: false, status: 0, data: null, via: null };
}

async function fetchTwishMe(channel) {
  const r = await twishApi(`/api/${encodeURIComponent(channel)}/me`);
  const ok = r.ok && isValidMe(r.data);
  if (ok) recordStats(channel, r.data);
  return ok ? { data: r.data, via: r.via } : null;
}

// ---------------------------------------------------------------------------
// Estatisticas (storage "stats"), por canal (barco):
//   { first: foto, days: { "AAAA-MM-DD": { start: foto, end: foto, counts: {...} } } }
// foto = { at, casts, points, xp, level, coins, duelWins, tourneyWins } — lida
// do /me (no maximo 1x por minuto por canal). O dia do jogo vira as 00:30.
// counts: pescarExt ($pescar da extensao) e pescarVoce ($pescar seu).
// ---------------------------------------------------------------------------
const STATS_WRITE_MS = 60 * 1000;
const STATS_KEEP_DAYS = 30;
const statsLastWrite = new Map();
let statsChain = Promise.resolve();
function mutateStats(fn) {
  statsChain = statsChain
    .then(async () => {
      const { stats } = await browser.storage.local.get("stats");
      const all = stats && typeof stats === "object" ? stats : {};
      fn(all);
      for (const c of Object.values(all)) {
        const days = Object.keys((c && c.days) || {}).sort();
        for (const d of days.slice(0, Math.max(0, days.length - STATS_KEEP_DAYS))) delete c.days[d];
      }
      await browser.storage.local.set({ stats: all });
    })
    .catch(() => {});
  return statsChain;
}
function statsDay(c, day) {
  c.days = c.days || {};
  if (!c.days[day]) {
    const prev = Object.keys(c.days).sort().pop();
    c.days[day] = { start: prev ? c.days[prev].end : null, end: null, counts: {} };
  }
  return c.days[day];
}
function recordStats(channel, d) {
  if (!channel || Date.now() - (statsLastWrite.get(channel) || 0) < STATS_WRITE_MS) return;
  statsLastWrite.set(channel, Date.now());
  const n = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);
  const snap = { at: Date.now(), casts: n(d.casts), points: n(d.points), xp: n(d.xp), level: n(d.level), coins: n(d.twishcoins), duelWins: n(d.duel_wins), tourneyWins: n(d.tournament_victories) };
  mutateStats((all) => {
    const c = all[channel] || (all[channel] = {});
    if (!c.first) c.first = snap;
    const day = statsDay(c, AT.gameDay());
    if (!day.start) day.start = snap;
    day.end = snap;
  });
}
function countStat(channel, key) {
  if (!channel) return;
  mutateStats((all) => {
    const c = all[channel] || (all[channel] = {});
    const day = statsDay(c, AT.gameDay());
    day.counts[key] = (day.counts[key] || 0) + 1;
  });
}

// ---------------------------------------------------------------------------
// $destaque automatico: em canal ativado, se ainda nao leu o peixe em destaque
// do dia do jogo (vira as 00:30), pede uma vez (e tenta de novo 1x depois de
// 10 min se a resposta nao foi lida).
// ---------------------------------------------------------------------------
const FEATURED_RETRY_MS = 10 * 60 * 1000;
async function maybeAutoFeatured(channel, source) {
  const general = await getGeneralSettings();
  const s = (await getAllChannelSettings())[channel];
  if (!s || !s.enabled || safetyLocked) return;
  if (!AT.effectiveAutoFeatured(s, general).enabled) return;
  const { gameState } = await browser.storage.local.get("gameState");
  const st = (gameState || {})[channel] || {};
  const day = AT.gameDay();
  if (st.featured && st.featured.seenAt >= AT.gameDayStart()) return; // ja tem o de hoje
  const ask = st.featuredAsk && st.featuredAsk.day === day ? st.featuredAsk : { day, count: 0, at: 0 };
  if (ask.count >= 2 || Date.now() - ask.at < FEATURED_RETRY_MS) return;
  if ((await twitchTabsForChannel(channel)).length === 0) return;
  await mutateGameState(channel, (x) => {
    x.featuredAsk = { day, count: ask.count + 1, at: Date.now() };
  });
  const r = await enqueueCommand(channel, AT.FEATURED_COMMAND, { reason: `destaque do dia (${source})` });
  logActivity(channel, "destaque", r.ok ? `Pedi o ${AT.FEATURED_COMMAND} do dia.` : `Falha ao pedir o ${AT.FEATURED_COMMAND} (${r.reason}).`);
}

// ---------------------------------------------------------------------------
// Backup das configuracoes (exportar/importar)
// ---------------------------------------------------------------------------
async function exportSettings() {
  const state = await loadState();
  const channels = {};
  for (const [name, s] of Object.entries(state.channels)) {
    const c = { ...s };
    for (const k of AT.CHANNEL_RUNTIME_KEYS) delete c[k];
    channels[name] = c;
  }
  const { acquisitionList } = await browser.storage.local.get("acquisitionList");
  return {
    app: AT.BACKUP_APP,
    format: AT.BACKUP_FORMAT,
    version: browser.runtime.getManifest().version,
    exportedAt: new Date().toISOString(),
    general: state.general,
    channels,
    acquisitionList: Array.isArray(acquisitionList) ? acquisitionList : []
  };
}

async function importSettings(data) {
  if (!data || typeof data !== "object" || data.app !== AT.BACKUP_APP) throw new Error("não é um backup do Auto Twish");
  if (Number(data.format) > AT.BACKUP_FORMAT) throw new Error("backup de uma versão mais nova da extensão");
  const general = AT.mergeGeneral(data.general && typeof data.general === "object" ? data.general : {});
  let nChannels = 0;
  await mutateGeneral((g) => {
    const login = g.twishLogin; // a conta e lida do site; nao vem do backup
    for (const k of Object.keys(g)) delete g[k];
    Object.assign(g, general, { twishLogin: login || general.twishLogin || null });
  });
  await mutateChannels((channels) => {
    for (const [name, raw] of Object.entries(data.channels && typeof data.channels === "object" ? data.channels : {})) {
      const id = String(name).toLowerCase();
      if (!/^[a-z0-9_]{1,40}$/.test(id) || !raw || typeof raw !== "object") continue;
      const cur = channels[id] || {};
      const clean = { ...raw };
      for (const k of AT.CHANNEL_RUNTIME_KEYS) delete clean[k];
      const runtime = Object.fromEntries(AT.CHANNEL_RUNTIME_KEYS.map((k) => [k, k in cur ? cur[k] : DEFAULT_CHANNEL_SETTINGS[k]]));
      channels[id] = { ...DEFAULT_CHANNEL_SETTINGS, ...clean, ...runtime };
      if (!channels[id].enabled) channels[id].nextFireAt = null;
      nChannels++;
    }
  });
  let nAcq = 0;
  if (Array.isArray(data.acquisitionList)) {
    const list = data.acquisitionList.filter((e) => AT.isValidAcquisition(e));
    nAcq = list.length;
    await browser.storage.local.set({ acquisitionList: list });
  }
  // Reaplica tudo que depende das configuracoes.
  await updateHeartbeat();
  await updateEventsPoller();
  await restoreDueAlarms();
  await reevaluateTurboSell();
  for (const fn of [
    typeof onProtectionSettingsChanged === "function" && onProtectionSettingsChanged,
    typeof onKitSettingsChanged === "function" && onKitSettingsChanged,
    typeof onInvDumpSettingsChanged === "function" && onInvDumpSettingsChanged,
    typeof onUpgradeSettingsChanged === "function" && onUpgradeSettingsChanged,
    typeof onRemedySettingsChanged === "function" && onRemedySettingsChanged
  ]) if (fn) fn(null);
  if (typeof reevaluateShopping === "function") await reevaluateShopping(null);
  if (typeof scheduleMarket === "function" && general.market && general.market.enabled) await scheduleMarket({ soon: true });
  logActivity(null, "backup", `Configurações importadas (${nChannels} canal(is), ${nAcq} item(ns) do Mercado; backup da v ${data.version || "?"}).`);
  return { channels: nChannels, acquisition: nAcq, version: data.version || null };
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

// ---------------------------------------------------------------------------
// Fila de comandos no chat
// Todo comando (pesca, $destaque, $aceitar, $vender...) passa por aqui: um
// por vez, e com um intervalo aleatorio entre dois comandos no mesmo canal,
// pra nao sair uma rajada robotica. Respeita a trava de seguranca.
// ---------------------------------------------------------------------------
const CHAT_MIN_GAP_MS = 2500; // intervalo minimo entre dois comandos no mesmo canal
const CHAT_GAP_JITTER_MS = 2500; // + ate isso, aleatorio
let chatChain = Promise.resolve();
const lastChatAt = new Map(); // canal -> horario do ultimo comando enviado

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// gap: false = sem o intervalo aleatorio (ex: Protecao, que deve ser imediata).
// Os comandos continuam saindo um por vez.
function attemptSend(channel, text = FIXED_MESSAGE, { gap = true } = {}) {
  const run = chatChain.then(async () => {
    if (gap) {
      const last = lastChatAt.get(channel) || 0;
      const wait = last + CHAT_MIN_GAP_MS + Math.random() * CHAT_GAP_JITTER_MS - Date.now();
      if (wait > 0) await sleep(wait);
    }
    const r = await sendChatNow(channel, text);
    if (r.ok) lastChatAt.set(channel, Date.now());
    return r;
  });
  chatChain = run.catch(() => {});
  return run;
}

// Comando de uma automacao: espera um pouco (reacao "humana") e entra na fila.
async function enqueueCommand(channel, text, { delayMs = 0, reason = "", gap = true } = {}) {
  if (delayMs > 0) await sleep(delayMs);
  if (safetyLocked) return { ok: false, reason: "verificacao-pendente" };
  const r = await attemptSend(channel, text, { gap });
  console.log(`${AT.LOG_PREFIX} [fila] "${text}" em "${channel}"${reason ? ` (${reason})` : ""}: ${r.ok ? "enviado" : `falhou (${r.reason})`}.`);
  return r;
}

// ---------------------------------------------------------------------------
// Chrome: digitar/enviar DENTRO da pagina (mundo "MAIN").
// No Chrome, eventos disparados pelo content script (mundo isolado) nao sao
// aceitos pelo editor do chat da Twitch (Slate): o texto aparece na tela mas
// o editor continua vazio e o envio nao sai. A mesma rotina, executada no
// mundo da pagina, funciona (testado na Twitch real, v 0.5.3). O Firefox
// continua usando o content script, que la funciona.
// A funcao abaixo e serializada e roda na pagina: nao pode usar nada de fora.
// ---------------------------------------------------------------------------
function pageChatAction(text, sendIt) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const fieldText = (el) => (el.innerText || el.textContent || "").trim();
  const findInput = () => {
    for (const sel of [
      '[data-a-target="chat-input"] [contenteditable="true"]',
      '.chat-wysiwyg-input__editor[contenteditable="true"]',
      'div[role="textbox"][contenteditable="true"]'
    ]) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  };
  const selectAll = (el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  };
  return (async () => {
    if (window.__autoTwishBusy) return { ok: false, reason: "already-sending" };
    window.__autoTwishBusy = true;
    try {
      const input = findInput();
      if (!input) return { ok: false, reason: "input-not-found" };
      if (!sendIt) {
        const cur = fieldText(input);
        if (cur === text) return { ok: true, typed: true };
        if (cur !== "") return { ok: true, typed: false }; // rascunho do jogador: nao mexe
      }
      for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
        input.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window }));
      }
      input.focus();
      await wait(80);
      selectAll(input);
      await wait(60);
      input.dispatchEvent(new InputEvent("beforeinput", { inputType: "insertText", data: text, bubbles: true, cancelable: true, composed: true }));
      let ok = false;
      for (let i = 0; i < 8 && !ok; i++) {
        await wait(50);
        ok = fieldText(input) === text;
      }
      if (!ok) {
        selectAll(input);
        document.execCommand("insertText", false, text);
        ok = fieldText(input) === text;
      }
      if (!ok) return { ok: false, reason: "insert-mismatch" };
      if (!sendIt) return { ok: true, typed: true };
      await wait(150);
      const btn = document.querySelector('[data-a-target="chat-send-button"]');
      if (btn && !btn.disabled) btn.click();
      else {
        for (const type of ["keydown", "keypress", "keyup"]) {
          input.dispatchEvent(new KeyboardEvent(type, { key: "Enter", code: "Enter", keyCode: 13, which: 13, bubbles: true, cancelable: true }));
        }
      }
      await wait(300);
      if (fieldText(input) === text) return { ok: false, reason: "send-not-confirmed" };
      return { ok: true };
    } finally {
      window.__autoTwishBusy = false;
    }
  })();
}

// Envia (SEND_CHAT_MESSAGE) ou so digita (TYPE_CHAT_MESSAGE) numa aba.
async function chatInTab(tabId, type, text) {
  if (AT.browserName() === "Chrome") {
    try {
      const res = await browser.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        func: pageChatAction,
        args: [text, type === "SEND_CHAT_MESSAGE"]
      });
      const r = res && res[0] && res[0].result;
      if (r) return r;
    } catch (e) {
      console.warn(`${AT.LOG_PREFIX} Falha ao digitar pela pagina; tentando pelo content script:`, e);
    }
  }
  return browser.tabs.sendMessage(tabId, { type, text });
}

// Tenta enviar a mensagem pra(s) aba(s) do canal e reporta se o
// content.js confirmou que o texto foi digitado e o envio foi disparado.
// NAO confirma que o TwishGameBot de fato respondeu — so que o envio
// local (Twitch) funcionou. Use attemptSend (fila), nunca esta direto.
async function sendChatNow(channel, text) {
  if (safetyLocked) return { ok: false, reason: "verificacao-pendente" };
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
      const result = await chatInTab(tab.id, "SEND_CHAT_MESSAGE", text);
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
    if ("notifyBigEvents" in patch) s.notifyBigEvents = !!patch.notifyBigEvents;
    // Excecoes do canal: null volta a usar o valor geral.
    if ("duelAccept" in patch) {
      s.duelAccept = patch.duelAccept === null ? null : AT.sanitizeDuelAccept({ ...AT.effectiveDuelAccept(previous, stateCache && stateCache.general), ...patch.duelAccept });
    }
    for (const [key, eff, merge] of [
      ["eventKit", AT.effectiveEventKit, (a, b) => mergeEventKit(a, b)],
      ["tournament", AT.effectiveTournament, (a, b) => AT.sanitizeTournament({ ...a, ...b })],
      ["duelBait", AT.effectiveDuelBait, (a, b) => AT.sanitizeDuelBait({ ...a, ...b })],
      ["invDump", AT.effectiveInvDump, (a, b) => AT.sanitizeInvDump({ ...a, ...b })],
      ["autoBoard", AT.effectiveAutoBoard, (a, b) => mergeAutoBoard(a, b)],
      ["autoUpgrade", AT.effectiveAutoUpgrade, (a, b) => mergeAutoUpgrade(a, b)],
      ["autoFeatured", AT.effectiveAutoFeatured, (a, b) => AT.sanitizeAutoFeatured({ ...a, ...b })],
      ["autoRemedy", AT.effectiveAutoRemedy, (a, b) => AT.sanitizeAutoRemedy({ ...a, ...b })]
    ]) {
      if (key in patch) s[key] = patch[key] === null ? null : merge(eff(previous, stateCache && stateCache.general), patch[key]);
    }
    if ("shopList" in patch) {
      s.shopList = patch.shopList === null ? null : AT.sanitizeShopList({ ...AT.effectiveShopList(previous, stateCache && stateCache.general), ...patch.shopList });
    }
    if ("protection" in patch) {
      s.protection = patch.protection === null ? null : AT.sanitizeProtection({ ...AT.effectiveProtection(previous, stateCache && stateCache.general), ...patch.protection });
    }
    if ("turboSell" in patch) {
      s.turboSell = patch.turboSell === null ? null : AT.sanitizeTurboSell({ ...AT.effectiveTurboSell(previous, stateCache && stateCache.general), ...patch.turboSell });
    }
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
  if (("notifyEvents" in patch && settings.notifyEvents) || ("notifyBigEvents" in patch && settings.notifyBigEvents)) refreshEvents(channel, false); // estado inicial, sem notificar o que ja estava rolando
  if ("turboSell" in patch) await reevaluateTurboSell(channel);
  if ("invDump" in patch && typeof onInvDumpSettingsChanged === "function") onInvDumpSettingsChanged(channel);
  if ((("enabled" in patch && settings.enabled) || "autoFeatured" in patch) && settings.enabled) setTimeout(() => maybeAutoFeatured(channel, "ativado").catch(() => {}), 4000);
  if ("autoRemedy" in patch && typeof onRemedySettingsChanged === "function") onRemedySettingsChanged(channel);
  if (("autoUpgrade" in patch || "shopList" in patch) && typeof onUpgradeSettingsChanged === "function") onUpgradeSettingsChanged(channel);
  if ("protection" in patch) onProtectionSettingsChanged(channel);
  if ("shopList" in patch) await reevaluateShopping(channel);
  if (["eventKit", "tournament", "duelBait"].some((k) => k in patch) && typeof onKitSettingsChanged === "function") onKitSettingsChanged(channel);
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

// Ligar/desligar a Venda Turbinada: agenda (ou cancela) na hora, a partir
// dos eventos ja conhecidos, e busca eventos frescos.
async function reevaluateTurboSell(only) {
  await updateEventsPoller();
  const channels = await getAllChannelSettings();
  for (const channel of Object.keys(channels)) {
    if (only && channel !== only) continue;
    const ev = await refreshEvents(channel, false);
    if (!ev) {
      const { gameState } = await browser.storage.local.get("gameState");
      await scheduleTurboSell(channel, ((gameState || {})[channel] || {}).events || null);
    }
  }
}

// Mescla parcial da configuracao de eventos (por evento).
function mergeAutoUpgrade(cur, patch) {
  const base = AT.sanitizeAutoUpgrade(cur);
  const p = patch || {};
  return AT.sanitizeAutoUpgrade({ ...base, ...p, categories: { ...base.categories, ...(p.categories || {}) } });
}

function mergeAutoBoard(cur, patch) {
  const base = AT.sanitizeAutoBoard(cur);
  const p = patch || {};
  const seas = { ...base.seas };
  for (const id of AT.EXPEDITION_SEA_IDS) if (p.seas && p.seas[id]) seas[id] = { ...seas[id], ...p.seas[id] };
  return AT.sanitizeAutoBoard({ ...base, ...p, seas });
}

function mergeEventKit(cur, patch) {
  const base = AT.sanitizeEventKit(cur);
  const out = {};
  for (const k of AT.KIT_EVENTS) {
    const p = (patch && patch[k]) || {};
    if (k === AT.LUCK_KIND) {
      const tiers = { ...base[k].tiers };
      for (const t of AT.LUCK_TIERS) if (p.tiers && p.tiers[t]) tiers[t] = { ...tiers[t], ...p.tiers[t] };
      out[k] = { ...base[k], ...p, tiers };
    } else out[k] = { ...base[k], ...p };
  }
  return AT.sanitizeEventKit(out);
}

async function removeChannel(channel) {
  await mutateChannels((channels) => {
    delete channels[channel];
  });
  await browser.alarms.clear(`${SELL_ALARM_PREFIX}${channel}`);
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
      const result = await chatInTab(tab.id, "TYPE_CHAT_MESSAGE", FIXED_MESSAGE);
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

// Atualiza os eventos de um canal e avisa os que acabaram de comecar.
// notify: false | true (evento e Grande Evento) | { event, big }.
async function refreshEvents(channel, notify) {
  const want = notify && typeof notify === "object" ? notify : { event: !!notify, big: !!notify };
  const ev = await fetchActiveEvents(channel);
  if (!ev) return null;
  const turbo = ev.event && ev.event.kind === "cooldown_multiplier" ? ev.event : null;
  if (turbo) cooldownMultipliers.set(channel, { value: Number(turbo.value), until: Date.now() + turbo.seconds_remaining * 1000 });
  else cooldownMultipliers.delete(channel);
  const started = await mutateGameState(channel, (st) => {
    const oldKeys = eventKeys(st.events);
    // 1a vez com o registro de avisos: o que ja era conhecido conta como avisado.
    if (!Array.isArray(st.notifiedEvents)) st.notifiedEvents = oldKeys;
    // So guarda o que mudou de fato (o tempo restante muda a cada consulta).
    const sameSet = JSON.stringify(oldKeys) === JSON.stringify(eventKeys(ev));
    if (!sameSet || !st.events) st.events = ev;
    else if (ev.event || ev.grande_evento) st.events = ev; // atualiza o tempo restante enquanto houver evento
    return eventKeys(ev).filter((k) => !oldKeys.includes(k));
  });
  // Avisos: compara com o que ja foi avisado (nao com "comecou nesta consulta"),
  // assim uma atualizacao feita antes pelo popup/automacao nao engole o aviso.
  const toNotify = await mutateGameState(channel, (st) => {
    const now = eventKeys(ev);
    const done = Array.isArray(st.notifiedEvents) ? st.notifiedEvents : [];
    const fresh = now.filter((k) => !done.includes(k));
    const wanted = (k) => (k.startsWith("grande:") ? want.big : want.event);
    const out = fresh.filter(wanted);
    // Consulta que nao avisa nada (popup, automacoes): nao marca nada, para a
    // consulta periodica ainda avisar. Consulta que avisa: marca tudo que viu.
    const marks = want.big || want.event ? fresh : [];
    st.notifiedEvents = [...now.filter((k) => done.includes(k)), ...marks];
    return out;
  });
  if (toNotify.length) {
    const items = [];
    if (ev.grande_evento && toNotify.includes(`grande:${ev.grande_evento.name}`)) items.push({ item: ev.grande_evento, big: true });
    if (ev.event && toNotify.includes(`event:${ev.event.name}`)) items.push({ item: ev.event, big: false });
    for (const { item, big } of items) {
      try {
        await browser.notifications.create(`event:${channel}:${item.name}`, {
          type: "basic",
          title: `${item.emoji || (big ? "🌊" : "🎉")} ${big ? "Grande Evento: " : ""}${item.name} em ${channel}`,
          message: `${item.message ? item.message + " — " : ""}termina em ${AT.formatRemaining(item.seconds_remaining * 1000)}.`
        });
      } catch (e) {
        console.warn(`${AT.LOG_PREFIX} Falha ao notificar evento:`, e);
      }
    }
    console.log(`${AT.LOG_PREFIX} Evento(s) avisado(s) em "${channel}":`, toNotify);
  }
  if (started.length && typeof logActivity === "function") {
    for (const k of started) logActivity(channel, "evento", k.startsWith("grande:") ? `Grande Evento começou: ${k.slice(7)}` : `Evento começou: ${k.slice(6)}`);
  }
  await scheduleTurboSell(channel, ev);
  if (typeof scheduleShopping === "function") await scheduleShopping(channel, ev);
  if (typeof onKitEvents === "function") await onKitEvents(channel, ev);
  if (typeof onUpgradeEvents === "function") await onUpgradeEvents(channel, ev);
  return ev;
}

// Consulta de eventos: 1x por minuto, enquanto algum canal estiver ativado
// (evento novo pode zerar o CD da pesca — ex: Mare Turbo) ou tiver
// "Notificar eventos" ligado.
function watchesEvents(s, general) {
  if (!s) return false;
  const shop = AT.effectiveShopList(s, general);
  const kit = AT.effectiveEventKit(s, general);
  return !!(
    s.notifyEvents ||
    AT.notifiesBigEvents(s) ||
    s.enabled ||
    AT.effectiveTurboSell(s, general).enabled ||
    (shop.enabled && shop.items.length) ||
    AT.effectiveAutoUpgrade(s, general).enabled ||
    AT.KIT_EVENTS.some((k) => AT.kitIsActive(kit[k]))
  );
}

async function updateEventsPoller() {
  const channels = await getAllChannelSettings();
  const general = await getGeneralSettings();
  const any = Object.values(channels).some((s) => watchesEvents(s, general));
  const existing = await browser.alarms.get(AT.EVENTS_ALARM_NAME);
  if (any && !existing) await browser.alarms.create(AT.EVENTS_ALARM_NAME, { periodInMinutes: 1 });
  else if (!any && existing) await browser.alarms.clear(AT.EVENTS_ALARM_NAME);
}

async function pollEvents() {
  const channels = await getAllChannelSettings();
  const general = await getGeneralSettings();
  for (const [channel, s] of Object.entries(channels)) {
    if (!watchesEvents(s, general)) {
      await browser.alarms.clear(`${SELL_ALARM_PREFIX}${channel}`);
      continue;
    }
    const before = await browser.storage.local.get("gameState");
    const hadKeys = eventKeys(((before.gameState || {})[channel] || {}).events);
    const ev = await refreshEvents(channel, { event: !!s.notifyEvents, big: AT.notifiesBigEvents(s) });
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
  maybeAutoAcceptDuel(channel, challenger, expiresAt).catch((e) => console.warn(`${AT.LOG_PREFIX} Falha no aceite automatico de duelo:`, e));
}

// Aceite automatico de duelo (desligado por padrao). Aceitar zera o CD da
// pesca, entao a regra do jogador decide se compensa.
async function maybeAutoAcceptDuel(channel, challenger, expiresAt) {
  const general = await getGeneralSettings();
  const s = (await getAllChannelSettings())[channel] || null;
  const cfg = AT.effectiveDuelAccept(s, general);
  if (!cfg.enabled) return;

  let remainingMs = null;
  let fullMs = null;
  if (cfg.rule !== "always") {
    let rodId = null;
    const me = await fetchTwishMe(channel);
    if (me) {
      const p = parseTwishMe(me);
      remainingMs = Math.max(0, p.availableAt - Date.now());
      rodId = p.rodId;
    } else if (s && s.twishAvailableAt !== null && s.twishLastSeen && Date.now() - s.twishLastSeen < TWISH_DATA_FRESH_MS) {
      remainingMs = Math.max(0, s.twishAvailableAt - Date.now());
    }
    const minutes = ROD_MINUTES[rodId || (s && s.rod)] || ROD_MINUTES[DEFAULT_ROD];
    fullMs = minutes * 60000 * cooldownMultiplierFor(channel);
  }

  const d = AT.duelAcceptDecision(cfg, { remainingMs, fullMs });
  if (!d.accept) {
    console.log(`${AT.LOG_PREFIX} Duelo de @${challenger} em "${channel}" NAO aceito automaticamente: ${d.why}.`);
    return;
  }

  // Reacao "humana": 3 a 10 s, sem passar do prazo do convite.
  const room = Math.max(0, expiresAt - Date.now() - 5000);
  const delayMs = Math.min(room, 3000 + Math.random() * 7000);
  await sleep(delayMs);

  // Em expedicao nao da para duelar (em nenhum canal).
  if (await currentExpedition(channel, "duelo")) {
    console.log(`${AT.LOG_PREFIX} Duelo de @${challenger} em "${channel}" NAO aceito: em expedicao.`);
    return;
  }

  // O convite ainda esta de pe? (o jogador pode ter aceitado/recusado na mao)
  const { gameState } = await browser.storage.local.get("gameState");
  const inv = ((gameState || {})[channel] || {}).duelInvite;
  if (!inv || inv.from !== challenger || inv.expiresAt <= Date.now()) return;

  const r = await enqueueCommand(channel, AT.DUEL_ACCEPT_COMMAND, { reason: `duelo de @${challenger}; ${d.why}` });
  if (!r.ok) return;
  await mutateGameState(channel, (st) => {
    delete st.duelInvite;
  });
  try {
    browser.notifications.clear(`duel:${channel}`);
  } catch (e) {}
  await notifyAutomation(`duel-auto:${channel}`, `⚔️ Duelo aceito em ${channel}`, `Aceitei o duelo de @${challenger} (${d.why}).`);
  if (typeof onDuelAccepted === "function") await onDuelAccepted(channel);
  // Aceitar duelo zera o CD da pesca: confere a conta logo depois.
  if (s && s.enabled) schedulePostSendCheck(channel, 5000);
}

// ---------------------------------------------------------------------------
// Registro de atividades (storage "activity": [{ at, channel, kind, msg }],
// mais novo primeiro, ate ACTIVITY_MAX). Toda automacao que age passa por
// notifyAutomation, que registra aqui; outros pontos chamam logActivity direto.
// ---------------------------------------------------------------------------
const ACTIVITY_MAX = 300;
const AUTOMATION_KINDS = {
  "duel-auto": "duelo",
  "sell-auto": "venda",
  "board-auto": "expedição",
  "invdump-auto": "Inv Dump",
  "kit-auto": "eventos",
  "protect-auto": "proteção",
  "shop-auto": "compras",
  "upgrade-auto": "aprimoramento",
  "remedy-auto": "remédio",
  "featured-auto": "destaque"
};
let activityChain = Promise.resolve();
function logActivity(channel, kind, msg) {
  activityChain = activityChain
    .then(async () => {
      const { activity } = await browser.storage.local.get("activity");
      const list = Array.isArray(activity) ? activity : [];
      list.unshift({ at: Date.now(), channel: channel || null, kind: String(kind || "").slice(0, 24), msg: String(msg || "").slice(0, 400) });
      await browser.storage.local.set({ activity: list.slice(0, ACTIVITY_MAX) });
    })
    .catch(() => {});
  return activityChain;
}

async function notifyAutomation(id, title, message) {
  const m = /^([a-z-]+):(.*)$/.exec(id);
  logActivity(m ? m[2].split(":")[0] : null, (m && AUTOMATION_KINDS[m[1]]) || "automação", message);
  const general = await getGeneralSettings();
  if (!general.notifyAutomations) return;
  try {
    await browser.notifications.create(id, { type: "basic", title, message });
  } catch (e) {
    console.warn(`${AT.LOG_PREFIX} Falha ao notificar automacao:`, e);
  }
}

// ---------------------------------------------------------------------------
// Venda Turbinada (kind "sell_multiplier"): $vender todos perto do fim.
// Peixes protegidos com $whitelist nao sao vendidos pelo jogo.
// ---------------------------------------------------------------------------
const SELL_ALARM_PREFIX = "auto-twish-sell:";
const SAME_EVENT_TOLERANCE_MS = 3 * 60 * 1000; // fim calculado varia alguns segundos entre consultas
const sellingNow = new Set();

function turboSellEvent(ev) {
  return ev && ev.event && ev.event.kind === "sell_multiplier" ? ev.event : null;
}

// Agenda (ou cancela) a venda do canal a partir dos eventos conhecidos.
async function scheduleTurboSell(channel, ev) {
  const alarmName = `${SELL_ALARM_PREFIX}${channel}`;
  const general = await getGeneralSettings();
  const s = (await getAllChannelSettings())[channel] || null;
  const cfg = AT.effectiveTurboSell(s, general);
  const sell = turboSellEvent(ev);
  if (!cfg.enabled || !sell) {
    await browser.alarms.clear(alarmName);
    return null;
  }
  const endsAt = (ev.fetchedAt || Date.now()) + Number(sell.seconds_remaining) * 1000;
  const { gameState } = await browser.storage.local.get("gameState");
  const soldEnd = ((gameState || {})[channel] || {}).turboSoldEndsAt;
  if (soldEnd && Math.abs(soldEnd - endsAt) < SAME_EVENT_TOLERANCE_MS) {
    await browser.alarms.clear(alarmName);
    return null; // ja vendeu neste evento
  }
  if (endsAt - Date.now() < 3000) return null; // tarde demais
  // Alvo: X s antes do fim, com ate 5 s a mais de antecedencia (aleatorio).
  const target = endsAt - cfg.secondsBeforeEnd * 1000 - Math.random() * 5000;
  const when = Math.max(Date.now() + 1000, target);
  const existing = await browser.alarms.get(alarmName);
  // Nao resorteia a cada consulta: so troca se o alvo mudou de verdade.
  if (!existing || Math.abs(existing.scheduledTime - target) > 15000) {
    await browser.alarms.create(alarmName, { when });
    console.log(`${AT.LOG_PREFIX} Venda Turbinada em "${channel}": $vender todos agendado para ${new Date(when).toLocaleTimeString()} (evento termina ${new Date(endsAt).toLocaleTimeString()}).`);
  }
  return when;
}

async function runTurboSell(channel) {
  if (sellingNow.has(channel)) return;
  sellingNow.add(channel);
  try {
    const general = await getGeneralSettings();
    const s = (await getAllChannelSettings())[channel] || null;
    const cfg = AT.effectiveTurboSell(s, general);
    if (!cfg.enabled) return;
    const ev = await fetchActiveEvents(channel); // confere na hora se o evento segue ativo
    const sell = turboSellEvent(ev);
    if (!sell) {
      console.log(`${AT.LOG_PREFIX} Venda Turbinada em "${channel}" ja acabou; nada vendido.`);
      return;
    }
    const endsAt = ev.fetchedAt + Number(sell.seconds_remaining) * 1000;
    const { gameState } = await browser.storage.local.get("gameState");
    const soldEnd = ((gameState || {})[channel] || {}).turboSoldEndsAt;
    if (soldEnd && Math.abs(soldEnd - endsAt) < SAME_EVENT_TOLERANCE_MS) return;
    if (await checkChallenge("venda turbinada")) return;
    // Antes de vender tudo, garante as especies protegidas na whitelist.
    await syncProtection(channel, "antes da venda");

    const r = await enqueueCommand(channel, AT.SELL_ALL_COMMAND, { reason: `Venda Turbinada (x${sell.value})` });
    if (r.ok) {
      await mutateGameState(channel, (st) => {
        st.turboSoldEndsAt = endsAt;
      });
      await notifyAutomation(`sell-auto:${channel}`, `💰 Venda Turbinada em ${channel}`, `Enviei ${AT.SELL_ALL_COMMAND} (x${sell.value}). Peixes na whitelist não são vendidos.`);
    } else if (endsAt - Date.now() > 10000) {
      // Falhou (ex: aba fechada): tenta de novo daqui a pouco, se ainda der tempo.
      await browser.alarms.create(`${SELL_ALARM_PREFIX}${channel}`, { when: Date.now() + 5000 });
    }
  } finally {
    sellingNow.delete(channel);
  }
}

// Configuracao de duelo do canal (o streamer escolhe o CD pos-duelo):
// GET /api/{canal}/settings -> values.duel_cooldown_seconds, duels_enabled.
// Guardada em gameState[canal].duelSettings por algumas horas. Sem leitura
// (o site so mostra os valores em alguns canais), fica o padrao de 30 min.
const DUEL_SETTINGS_TTL_MS = 6 * 60 * 60 * 1000;
async function readDuelSettings(channel, { fresh = false } = {}) {
  const { gameState } = await browser.storage.local.get("gameState");
  const cur = ((gameState || {})[channel] || {}).duelSettings;
  if (!fresh && cur && Date.now() - (cur.fetchedAt || 0) < DUEL_SETTINGS_TTL_MS) return cur;
  const r = await twishApi(`/api/${encodeURIComponent(channel)}/settings`);
  const v = r.ok && r.data && r.data.values && typeof r.data.values === "object" ? r.data.values : null;
  const secs = v ? Number(v.duel_cooldown_seconds) : NaN;
  const next = {
    cooldownSec: Number.isFinite(secs) && secs > 0 ? Math.round(secs) : null, // null = padrao
    enabled: v && typeof v.duels_enabled === "boolean" ? v.duels_enabled : null,
    fetchedAt: Date.now()
  };
  await mutateGameState(channel, (st) => {
    st.duelSettings = next;
  });
  return next;
}
function duelCooldownMs(ds) {
  return ds && ds.cooldownSec ? ds.cooldownSec * 1000 : AT.DUEL_COOLDOWN_MS;
}

async function onDuelEnd(channel, mentions) {
  const general = await getGeneralSettings();
  const me = general.twishLogin;
  if (!me || !mentions.some((m) => m.toLowerCase() === me)) return; // duelo de outras pessoas
  const ds = await readDuelSettings(channel).catch(() => null);
  const until = Date.now() + duelCooldownMs(ds);
  await mutateGameState(channel, (st) => {
    st.duelCooldownUntil = until;
    st.duelEndedAt = Date.now();
    delete st.duelInvite;
  });
  try {
    browser.notifications.clear(`duel:${channel}`);
  } catch (e) {}
  console.log(`${AT.LOG_PREFIX} Duelo terminou em "${channel}" (${mentions.join(", ")}); proximo duelo as ${new Date(until).toLocaleTimeString()}.`);
  logActivity(channel, "duelo", `Duelo terminou (${mentions.map((x) => "@" + x).join(", ")}); próximo duelo às ${new Date(until).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.`);
  if (typeof onDuelFinished === "function") await onDuelFinished(channel);
}

// O jogador mandou um comando que nao e o de pesca (ex: $aceitar, entrar em
// torneio): alguns zeram o CD da pesca, entao confere a conta logo depois.
async function onUserOtherCommand(channel, text) {
  if (/^\$aceitar\b/i.test(text)) {
    await mutateGameState(channel, (st) => {
      delete st.duelInvite;
    });
    if (typeof onDuelAccepted === "function") await onDuelAccepted(channel);
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

    // Trava de seguranca: confere a verificacao antes de qualquer envio.
    if (await checkChallenge(source)) {
      console.warn(`${AT.LOG_PREFIX} (${source}) "${channel}": verificacao pendente, envio pausado.`);
      return; // o heartbeat tenta de novo quando a trava sair
    }

    // Trava da Expedicao: no mar, so pesca no canal por onde zarpou.
    const exp = await expeditionBlocks(channel, source);
    if (exp) {
      const next = await postponeForExpedition(channel, exp);
      console.log(`${AT.LOG_PREFIX} (${source}) "${channel}": em expedicao pelo canal "${exp.boat || "?"}"; $pescar pausado ate ${next ? new Date(next).toLocaleTimeString() : "-"}.`);
      return;
    }

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
    if (result.ok && typeof scheduleInvDump === "function") scheduleInvDump(channel);
    if (result.ok && typeof noteFishForBoarding === "function") noteFishForBoarding(channel);
    if (result.ok && typeof scheduleProtectAfterCatch === "function") scheduleProtectAfterCatch(channel);
    if (result.ok && typeof scheduleUpgrade === "function") scheduleUpgrade(channel);
    if (result.ok) countStat(channel, "pescarExt");
    if (result.ok && typeof scheduleRemedy === "function") scheduleRemedy(channel);

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

// ---------------------------------------------------------------------------
// Trava de seguranca (verificacao anti-bot do Twish)
//
// GET /api/me/challenge responde { state: "pending", seconds_left } quando o
// jogo pede a verificacao em twish.com.br/verificacao. Enquanto estiver
// pendente, nenhum comando e enviado e o Mercado para. Retoma sozinho quando
// deixar de estar pendente (conferido 1x por minuto pelo heartbeat).
// A extensao so LE esse estado; nunca responde a verificacao.
// ---------------------------------------------------------------------------
let safetyLocked = false; // espelho em memoria de gameState.__safety

async function readSafetyLock() {
  const { safety } = await browser.storage.local.get("safety");
  safetyLocked = !!(safety && safety.locked);
  return safety || { locked: false };
}

async function checkChallenge(source) {
  const r = await twishApi("/api/me/challenge");
  if (!r.ok || !r.data) return safetyLocked; // sem login/sem resposta: mantem como esta
  const pending = r.data.state === "pending";
  const { safety } = await browser.storage.local.get("safety");
  const wasLocked = !!(safety && safety.locked);

  if (pending && !wasLocked) {
    await browser.storage.local.set({ safety: { locked: true, since: Date.now(), secondsLeft: Number(r.data.seconds_left) || null } });
    safetyLocked = true;
    console.warn(`${AT.LOG_PREFIX} (${source}) Verificacao anti-bot pendente: envios e Mercado pausados.`);
    logActivity(null, "trava", "Verificação anti-bot pendente: envios e Mercado pausados.");
    try {
      await browser.notifications.create("safety", {
        type: "basic",
        title: "Auto Twish — verificação pedida",
        message: `O Twish pediu a verificação. Envios pausados até você resolver em twish.com.br/verificacao${r.data.seconds_left ? ` (${AT.formatRemaining(r.data.seconds_left * 1000)} restantes)` : ""}.`
      });
    } catch (e) {}
    alertVerification(source).catch((e) => console.warn(`${AT.LOG_PREFIX} Falha no alerta de verificação:`, e));
    await ensureHeartbeatForSafety();
  } else if (!pending && wasLocked) {
    await browser.storage.local.set({ safety: { locked: false, releasedAt: Date.now() } });
    safetyLocked = false;
    console.log(`${AT.LOG_PREFIX} (${source}) Verificacao resolvida: retomando.`);
    logActivity(null, "trava", "Verificação resolvida: envios retomados.");
    try {
      browser.notifications.clear("safety");
      await browser.notifications.create("safety-ok", {
        type: "basic",
        title: "Auto Twish — retomando",
        message: "A verificação não está mais pendente. Os envios voltaram."
      });
    } catch (e) {}
    await rescheduleAfterSafety();
  }
  return pending;
}

// Alerta da verificacao: abre twish.com.br/verificacao numa janela nova em
// foco e/ou toca um som (opcoes gerais; desligadas por padrao). Depois do
// primeiro, repete o aviso (som, notificacao e janela na frente) a cada 20 s,
// mais 5 vezes, enquanto a verificacao continuar pendente. Uma sequencia a
// cada 3 min. So avisa — a verificacao e sempre resolvida pelo jogador.
const VERIFY_URL = "https://twish.com.br/verificacao";
const VERIFY_ALERT_GAP_MS = 3 * 60 * 1000;
const VERIFY_REPEAT_ALARM = "auto-twish-verify-repeat";
const VERIFY_REPEAT_MS = 20 * 1000;
const VERIFY_REPEAT_TIMES = 5;
let lastVerifyAlertAt = 0;

async function alertVerification(source) {
  const cfg = AT.sanitizeVerifyAlert((await getGeneralSettings()).verifyAlert);
  if (!cfg.openWindow && !cfg.sound) return;
  const { verifyAlert } = await browser.storage.local.get("verifyAlert");
  const last = Math.max(lastVerifyAlertAt, Number(verifyAlert && verifyAlert.at) || 0);
  if (Date.now() - last < VERIFY_ALERT_GAP_MS) return;
  lastVerifyAlertAt = Date.now();
  await browser.storage.local.set({ verifyAlert: { at: lastVerifyAlertAt, source } });
  logActivity(null, "trava", `Verificação pedida (${source}): ${[cfg.openWindow && "janela aberta", cfg.sound && "alerta sonoro"].filter(Boolean).join(" e ")}.`);
  if (cfg.sound) playAlertSound().catch((e) => console.warn(`${AT.LOG_PREFIX} Falha ao tocar o alerta:`, e));
  if (cfg.openWindow) await openVerificationWindow();
  await browser.storage.local.set({ verifyAlert: { at: lastVerifyAlertAt, source, repeatsLeft: VERIFY_REPEAT_TIMES } });
  await browser.alarms.create(VERIFY_REPEAT_ALARM, { when: Date.now() + VERIFY_REPEAT_MS });
}

// Repeticao do alerta (a cada 20 s). Para quando a verificacao deixa de estar pendente.
async function repeatVerificationAlert() {
  const { verifyAlert } = await browser.storage.local.get("verifyAlert");
  const left = Number(verifyAlert && verifyAlert.repeatsLeft) || 0;
  if (left <= 0) return;
  const r = await twishApi("/api/me/challenge");
  if (r.ok && r.data && r.data.state !== "pending") {
    await browser.storage.local.set({ verifyAlert: { ...verifyAlert, repeatsLeft: 0 } });
    if (safetyLocked) await checkChallenge("alerta");
    return;
  }
  const cfg = AT.sanitizeVerifyAlert((await getGeneralSettings()).verifyAlert);
  const n = VERIFY_REPEAT_TIMES - left + 1;
  await browser.storage.local.set({ verifyAlert: { ...verifyAlert, repeatsLeft: left - 1 } });
  if (cfg.sound) playAlertSound().catch((e) => console.warn(`${AT.LOG_PREFIX} Falha ao tocar o alerta:`, e));
  if (cfg.openWindow) await openVerificationWindow().catch(() => {});
  try {
    await browser.notifications.create("verify-repeat", {
      type: "basic",
      title: `Auto Twish — verificação pendente (aviso ${n + 1} de ${VERIFY_REPEAT_TIMES + 1})`,
      message: "Resolva em twish.com.br/verificacao para continuar pescando."
    });
  } catch (e) {}
  if (left - 1 > 0) await browser.alarms.create(VERIFY_REPEAT_ALARM, { when: Date.now() + VERIFY_REPEAT_MS });
}
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === VERIFY_REPEAT_ALARM) repeatVerificationAlert().catch((e) => console.warn(`${AT.LOG_PREFIX} Falha ao repetir o alerta:`, e));
});

async function openVerificationWindow() {
  // Ja aberta? Traz para a frente em vez de abrir outra.
  const open = await browser.tabs.query({ url: ["*://twish.com.br/verificacao*", "*://*.twish.com.br/verificacao*"] }).catch(() => []);
  if (open.length) {
    const t = open[0];
    await browser.tabs.update(t.id, { active: true });
    await browser.windows.update(t.windowId, { focused: true, drawAttention: true });
    return;
  }
  const w = await browser.windows.create({ url: VERIFY_URL, focused: true, type: "normal" });
  if (w && w.id !== undefined) browser.windows.update(w.id, { focused: true, drawAttention: true }).catch(() => {});
}

// Tres bipes. Firefox: a pagina de fundo toca direto. Chrome: o service worker
// nao tem audio, entao toca num documento offscreen (offscreen.html).
async function playAlertSound() {
  if (typeof AudioContext !== "undefined" && typeof document !== "undefined") {
    AT.playBeeps(new AudioContext());
    return;
  }
  // Chrome: chrome-compat.js define self.__atOffscreenPlay (documento offscreen).
  if (typeof self.__atOffscreenPlay === "function") await self.__atOffscreenPlay();
}

// Durante a trava o heartbeat precisa existir pra conferir de novo.
async function ensureHeartbeatForSafety() {
  const existing = await browser.alarms.get(HEARTBEAT_NAME);
  if (!existing) await browser.alarms.create(HEARTBEAT_NAME, { periodInMinutes: 1 });
}

// Ao sair da trava, quem estava atrasado volta com um atraso aleatorio (nao
// todos no mesmo segundo).
async function rescheduleAfterSafety() {
  const changed = await mutateChannels((channels) => {
    const out = [];
    for (const [name, s] of Object.entries(channels)) {
      if (!s || !s.enabled || s.awaitingUser) continue;
      if (!s.nextFireAt || s.nextFireAt < Date.now()) {
        s.nextFireAt = Date.now() + 3000 + computeJitterMs(s);
        out.push([name, s.nextFireAt]);
      }
    }
    return out;
  });
  for (const [name, when] of changed) await scheduleDueAlarm(name, when);
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

// ---------------------------------------------------------------------------
// Trava da Expedicao
//
// Durante uma expedicao (30 min no mar) o jogador so pode pescar no barco
// (canal) por onde zarpou. GET /api/{canal}/expeditions devolve "mine" (id da
// expedicao do jogador; o mesmo em qualquer canal) e as viagens no mar
// ("voyages", state "at_sea", com seconds_to_end e a tripulacao; crew[].boat
// e o canal por onde cada um zarpou). Sala aberta (lobby) ainda nao trava.
// No mar, o $pescar fica pausado em todos os outros canais e volta sozinho
// quando a viagem termina; aceitar duelo e entrar em torneio ficam
// bloqueados em TODOS os canais. A extensao so LE esse estado.
// Reserva sem API: a mensagem do bot "⛵ Zarpou à <mar>: @a, @b! Por 30 min
// o $pescar de vocês pesca no mar." (content.js) liga a trava na hora, com o
// canal da mensagem como canal da expedicao, ate o fim dos minutos citados.
// ---------------------------------------------------------------------------
const EXPEDITION_MAX_AGE_MS = 20 * 1000; // fora do mar: antes de pescar, confere se o estado tiver mais que isso
const EXPEDITION_AT_SEA_RECHECK_MS = 5 * 60 * 1000; // no mar: confere de novo a cada 5 min
const EXPEDITION_OVERTIME_MS = 30 * 1000; // passou do fim e ainda consta no mar: confere de novo em 30 s
const EXPEDITION_CHAT_GRACE_MS = 3 * 60 * 1000; // a API pode demorar a mostrar a viagem que o chat anunciou
let expeditionState = null; // { atSea, id, sea, kind, boat, endsAt, checkedAt }

async function readExpeditionState() {
  if (expeditionState) return expeditionState;
  const { expedition } = await browser.storage.local.get("expedition");
  expeditionState = expedition || null;
  return expeditionState;
}

function expeditionIsFresh(st) {
  if (!st || !st.checkedAt) return false;
  const age = Date.now() - st.checkedAt;
  if (st.atSea) return Date.now() < st.endsAt && age < EXPEDITION_AT_SEA_RECHECK_MS;
  return age < EXPEDITION_MAX_AGE_MS;
}

// Le a expedicao do jogador pela conta. Devolve o estado novo, ou null se a
// API nao respondeu (sem login etc.).
async function refreshExpedition(channel, source) {
  const base = `/api/${encodeURIComponent(channel)}/expeditions`;
  const r = await twishApi(base);
  if (!r.ok || !r.data || typeof r.data !== "object" || !Array.isArray(r.data.voyages)) return null;
  const mineId = r.data.mine || null;
  let trip = mineId ? r.data.voyages.find((v) => v && v.id === mineId) : null;
  if (mineId && !trip) {
    const d = await twishApi(`${base}/${encodeURIComponent(mineId)}`);
    if (d.ok && d.data && d.data.id === mineId) trip = d.data;
  }

  let st = { atSea: false, checkedAt: Date.now() };
  if (trip && trip.state === "at_sea") {
    let login = (await getGeneralSettings()).twishLogin || null;
    if (!login) {
      const me = await fetchTwishMe(channel);
      if (me && me.data.login) {
        login = String(me.data.login).toLowerCase();
        await rememberTwishLogin(login);
      }
    }
    const crew = Array.isArray(trip.crew) ? trip.crew : [];
    const mine = crew.find((c) => c && login && String(c.handle || "").toLowerCase() === login) || (crew.length === 1 ? crew[0] : null);
    const secs = Number(trip.seconds_to_end);
    st = {
      atSea: true,
      id: trip.id,
      sea: trip.sea || null,
      kind: trip.kind || null,
      boat: mine && mine.boat ? String(mine.boat).toLowerCase() : null,
      endsAt: Date.now() + (Number.isFinite(secs) && secs > 0 ? secs * 1000 : EXPEDITION_OVERTIME_MS),
      checkedAt: Date.now()
    };
  }

  const prev = await readExpeditionState();
  const wasAtSea = !!(prev && prev.atSea);
  if (!st.atSea && wasAtSea && prev.source === "chat" && Date.now() - (prev.chatAt || 0) < EXPEDITION_CHAT_GRACE_MS && Date.now() < prev.endsAt) {
    return prev; // o chat acabou de anunciar a partida: espera a API alcancar
  }
  if (st.atSea) st.source = "api";
  if (st.atSea && (!wasAtSea || prev.id !== st.id)) {
    console.log(`${AT.LOG_PREFIX} (${source}) Expedicao no mar (${st.sea || "?"}, pelo canal "${st.boat || "?"}"): $pescar pausado nos outros canais ate ${new Date(st.endsAt).toLocaleTimeString()}.`);
    logActivity(st.boat, "expedição", `No mar (${AT.EXPEDITION_SEAS[st.sea] || st.sea || "?"}): $pescar pausado nos outros canais, duelo e torneio bloqueados.`);
  } else if (!st.atSea && wasAtSea) {
    console.log(`${AT.LOG_PREFIX} (${source}) Expedicao terminou: $pescar liberado em todos os canais.`);
    logActivity(prev.boat, "expedição", "Expedição terminou: $pescar liberado em todos os canais.");
    if (typeof onExpeditionEnded === "function") onExpeditionEnded(prev.boat);
  }
  expeditionState = st;
  await browser.storage.local.set({ expedition: st });
  if (!st.atSea && wasAtSea) await rescheduleAfterSafety(); // quem ficou parado volta (com atraso aleatorio)
  return st;
}

// O jogador esta no mar? Devolve o estado da expedicao ou null.
async function currentExpedition(channel, source) {
  let st = await readExpeditionState();
  let fresh = expeditionIsFresh(st);
  if (!fresh) {
    const n = await refreshExpedition(channel, source);
    if (n) {
      st = n;
      fresh = true;
    }
  }
  if (!st || !st.atSea) return null;
  if (!fresh && Date.now() >= st.endsAt) return null; // sem como conferir: nao trava alem do fim previsto
  return st;
}

// O $pescar neste canal esta travado pela expedicao? Devolve o estado da
// expedicao (trava) ou null (pode pescar).
async function expeditionBlocks(channel, source) {
  const st = await currentExpedition(channel, source);
  if (!st) return null;
  if (st.boat && st.boat === channel) return null; // canal por onde zarpou: pesca normal
  return st;
}

// content.js: o bot anunciou a partida de uma expedicao neste canal.
async function onExpeditionDepartedChat(channel, seaName, mentions, minutes) {
  const login = (await getGeneralSettings()).twishLogin || null;
  if (!login || !mentions.includes(login)) return;
  const norm = (x) => String(x || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  const sea = Object.keys(AT.EXPEDITION_SEAS).find((id) => norm(AT.EXPEDITION_SEAS[id]) === norm(seaName)) || null;
  const prev = await readExpeditionState();
  if (prev && prev.atSea && prev.source === "api" && Date.now() < prev.endsAt) return; // a API ja sabe (e e mais precisa)
  const st = {
    atSea: true,
    id: null,
    sea,
    seaName: sea ? null : String(seaName || "").slice(0, 40) || null,
    kind: null,
    boat: channel,
    endsAt: Date.now() + Math.min(Math.max(Number(minutes) || 30, 1), 120) * 60000,
    checkedAt: Date.now(),
    chatAt: Date.now(),
    source: "chat"
  };
  expeditionState = st;
  await browser.storage.local.set({ expedition: st });
  console.log(`${AT.LOG_PREFIX} (chat) Expedicao anunciada em "${channel}" (${seaName}): $pescar pausado nos outros canais, duelo e torneio bloqueados ate ${new Date(st.endsAt).toLocaleTimeString()}.`);
  logActivity(channel, "expedição", `Zarpou (${seaName}, visto no chat): $pescar pausado nos outros canais, duelo e torneio bloqueados.`);
}

// Empurra o proximo $pescar do canal para o fim da expedicao (+ atraso).
async function postponeForExpedition(channel, st) {
  const next = await mutateChannels((channels) => {
    const s = channels[channel];
    if (!s || !s.enabled) return null;
    s.nextFireAt = Math.max(st.endsAt, Date.now() + EXPEDITION_OVERTIME_MS) + computeJitterMs(s);
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
  // Com a trava ligada, so confere se ja pode sair dela.
  await readSafetyLock();
  if (safetyLocked && (await checkChallenge("heartbeat"))) return;

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
      await maybeAutoFeatured(channel, "heartbeat").catch(() => {});
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

// ---------------------------------------------------------------------------
// Aviso de versao nova (storage "update": { latest, tag, url, checkedAt }).
// GET https://api.github.com/repos/<AT.UPDATE_REPO>/tags — a API do GitHub
// aceita chamadas de qualquer origem (CORS), sem permissao extra. Confere ao
// iniciar e a cada AT.UPDATE_CHECK_HOURS horas.
// ---------------------------------------------------------------------------
const UPDATE_ALARM_NAME = "auto-twish-update";
async function checkForUpdate(source) {
  if (!AT.UPDATE_REPO) return null;
  try {
    const r = await fetch(`https://api.github.com/repos/${AT.UPDATE_REPO}/tags?per_page=100`, { cache: "no-store", headers: { Accept: "application/vnd.github+json" } });
    if (!r.ok) return null;
    const tags = await r.json();
    const current = AT.parseVersion(browser.runtime.getManifest().version);
    let best = null;
    for (const t of Array.isArray(tags) ? tags : []) {
      const v = AT.parseVersion(t && t.name);
      if (v && (!best || AT.compareVersions(v, best.v) > 0)) best = { v, tag: t.name };
    }
    const newer = best && current && AT.compareVersions(best.v, current) > 0;
    const update = {
      checkedAt: Date.now(),
      latest: newer ? best.v.join(".") : null,
      tag: newer ? best.tag : null,
      url: newer ? `https://github.com/${AT.UPDATE_REPO}/releases/tag/${encodeURIComponent(best.tag)}` : null
    };
    const { update: prev } = await browser.storage.local.get("update");
    await browser.storage.local.set({ update });
    if (newer && (!prev || prev.latest !== update.latest)) logActivity(null, "versão", `Versão nova disponível no GitHub: v ${update.latest} (você está na v ${current.join(".")}).`);
    return update;
  } catch (e) {
    console.warn(`${AT.LOG_PREFIX} (${source}) Falha ao conferir versão nova:`, e);
    return null;
  }
}
async function setupUpdateCheck() {
  if (!AT.UPDATE_REPO) return;
  if (!(await browser.alarms.get(UPDATE_ALARM_NAME))) await browser.alarms.create(UPDATE_ALARM_NAME, { periodInMinutes: AT.UPDATE_CHECK_HOURS * 60 });
  const { update } = await browser.storage.local.get("update");
  if (!update || Date.now() - (update.checkedAt || 0) > 60 * 60 * 1000) await checkForUpdate("inicio");
}
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === UPDATE_ALARM_NAME) checkForUpdate("alarme");
});

async function bootstrap() {
  await readSafetyLock();
  await restoreCooldownMultipliers();
  await clearLegacyAlarms();
  await updateHeartbeat();
  await updateEventsPoller();
  await restoreDueAlarms();
  await syncAllTwishTabs();
  setupUpdateCheck().catch(() => {});
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
        if ("notifyAutomations" in patch) g.notifyAutomations = !!patch.notifyAutomations;
        if (patch.duelAccept) g.duelAccept = AT.sanitizeDuelAccept({ ...g.duelAccept, ...patch.duelAccept });
        if (patch.turboSell) g.turboSell = AT.sanitizeTurboSell({ ...g.turboSell, ...patch.turboSell });
        if (patch.invDump) g.invDump = AT.sanitizeInvDump({ ...g.invDump, ...patch.invDump });
        if (patch.autoBoard) g.autoBoard = mergeAutoBoard(g.autoBoard, patch.autoBoard);
        if (patch.autoUpgrade) g.autoUpgrade = mergeAutoUpgrade(g.autoUpgrade, patch.autoUpgrade);
        if (patch.autoFeatured) g.autoFeatured = AT.sanitizeAutoFeatured({ ...g.autoFeatured, ...patch.autoFeatured });
        if (patch.autoRemedy) g.autoRemedy = AT.sanitizeAutoRemedy({ ...g.autoRemedy, ...patch.autoRemedy });
        if (patch.protection) g.protection = AT.sanitizeProtection({ ...g.protection, ...patch.protection });
        if (patch.shopList) g.shopList = AT.sanitizeShopList({ ...g.shopList, ...patch.shopList });
        if (patch.eventKit) g.eventKit = mergeEventKit(g.eventKit, patch.eventKit);
        if (patch.tournament) g.tournament = AT.sanitizeTournament({ ...g.tournament, ...patch.tournament });
        if (patch.duelBait) g.duelBait = AT.sanitizeDuelBait({ ...g.duelBait, ...patch.duelBait });
        if (patch.verifyAlert) g.verifyAlert = AT.sanitizeVerifyAlert({ ...g.verifyAlert, ...patch.verifyAlert });
        if (patch.semiAuto) {
          g.semiAuto = { ...g.semiAuto };
          if ("focusTab" in patch.semiAuto) g.semiAuto.focusTab = !!patch.semiAuto.focusTab;
          if ("notify" in patch.semiAuto) g.semiAuto.notify = !!patch.semiAuto.notify;
        }
      });
      if (patch.turboSell) await reevaluateTurboSell();
      if (patch.invDump && typeof onInvDumpSettingsChanged === "function") onInvDumpSettingsChanged(null);
      if (patch.autoRemedy && typeof onRemedySettingsChanged === "function") onRemedySettingsChanged(null);
      if (patch.autoFeatured) {
        for (const ch of Object.keys(await getAllChannelSettings())) setTimeout(() => maybeAutoFeatured(ch, "configuração").catch(() => {}), 3000);
      }
      if ((patch.autoUpgrade || (patch.shopList && "reserve" in patch.shopList)) && typeof onUpgradeSettingsChanged === "function") onUpgradeSettingsChanged(null);
      if (patch.protection) onProtectionSettingsChanged(null);
      if (patch.shopList) await reevaluateShopping(null);
      if ((patch.eventKit || patch.tournament || patch.duelBait) && typeof onKitSettingsChanged === "function") onKitSettingsChanged(null);
      sendResponse({ general: await getGeneralSettings() });
    })();
    return true;
  }

  if (msg?.type === "REMOVE_CHANNEL") {
    removeChannel(msg.channel).then(() => sendResponse({ ok: true }));
    return true;
  }

  // Vem do content.js: mensagens do TwishGameBot lidas no chat.
  // Bot falou de verificacao marcando o jogador: confere a trava na hora.
  if (msg?.type === "CHAT_EXPEDITION_DEPARTED") {
    const channel = extractChannelFromUrl(sender?.tab?.url || "");
    const mentions = Array.isArray(msg.mentions) ? msg.mentions.slice(0, 20).map((m) => String(m).toLowerCase()) : [];
    if (channel) onExpeditionDepartedChat(channel, String(msg.sea || ""), mentions, msg.minutes);
    return false;
  }

  if (msg?.type === "TEST_VERIFY_SOUND") {
    playAlertSound().catch((e) => console.warn(`${AT.LOG_PREFIX} Falha ao tocar o alerta:`, e));
    return false;
  }
  if (msg?.type === "CHAT_VERIFICATION_HINT") {
    (async () => {
      const general = await getGeneralSettings();
      const mentions = Array.isArray(msg.mentions) ? msg.mentions.map((m) => String(m).toLowerCase()) : [];
      if (general.twishLogin && mentions.includes(general.twishLogin)) {
        // Mensagem com o link da verificacao marcando o jogador: avisa na hora.
        if (msg.link) await alertVerification("chat");
        await checkChallenge("chat");
      }
    })();
    return false;
  }

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

  // Configuracoes: backup.
  if (msg?.type === "EXPORT_SETTINGS") {
    exportSettings().then((data) => sendResponse({ ok: true, data }), (e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }
  if (msg?.type === "IMPORT_SETTINGS") {
    importSettings(msg.data).then((r) => sendResponse({ ok: true, ...r }), (e) => sendResponse({ ok: false, error: String(e.message || e) }));
    return true;
  }

  // Popup: estado da expedicao (le da conta se estiver velho).
  if (msg?.type === "GET_EXPEDITION") {
    (async () => {
      let st = await readExpeditionState();
      if (msg.channel && !expeditionIsFresh(st)) st = (await refreshExpedition(msg.channel, "popup")) || st;
      sendResponse({ expedition: st });
    })();
    return true;
  }

  // Popup/configuracoes: estado da trava de seguranca.
  if (msg?.type === "GET_SAFETY") {
    readSafetyLock().then((s) => sendResponse({ safety: s }));
    return true;
  }

  // Popup: estado do jogo do canal (atualiza os eventos na hora).
  if (msg?.type === "GET_GAME_STATE") {
    (async () => {
      await refreshEvents(msg.channel, false);
      await readDuelSettings(msg.channel).catch(() => null); // CD pos-duelo do canal (em cache)
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
    if (channel && msg.text === FIXED_MESSAGE) {
      recordUserSent(channel);
      if (typeof scheduleInvDump === "function") scheduleInvDump(channel);
      if (typeof noteFishForBoarding === "function") noteFishForBoarding(channel);
      if (typeof scheduleProtectAfterCatch === "function") scheduleProtectAfterCatch(channel);
      if (typeof scheduleUpgrade === "function") scheduleUpgrade(channel);
      if (typeof scheduleRemedy === "function") scheduleRemedy(channel);
      countStat(channel, "pescarVoce");
    }
    else if (channel && typeof msg.text === "string" && msg.text.startsWith("$")) onUserOtherCommand(channel, msg.text);
    return false;
  }

  if (msg?.type === "UPDATE_CHANNEL_SETTINGS") {
    applyChannelSettings(msg.channel, msg.settings).then((settings) => sendResponse({ ok: true, settings }));
    return true;
  }

  if (msg?.type === "SEND_NOW") {
    (async () => {
      const exp = await expeditionBlocks(msg.channel, "popup");
      if (exp) {
        await postponeForExpedition(msg.channel, exp);
        sendResponse({ ok: false, reason: "em-expedicao", settings: await getChannelSettings(msg.channel) });
        return;
      }
      const result = await attemptSend(msg.channel);
      await recordSendResult(msg.channel, result.ok); // so reagenda se o canal estiver ativado
      if (result.ok && typeof scheduleInvDump === "function") scheduleInvDump(msg.channel);
      if (result.ok && typeof noteFishForBoarding === "function") noteFishForBoarding(msg.channel);
      if (result.ok && typeof scheduleProtectAfterCatch === "function") scheduleProtectAfterCatch(msg.channel);
      if (result.ok && typeof scheduleUpgrade === "function") scheduleUpgrade(msg.channel);
      if (result.ok) countStat(msg.channel, "pescarExt");
      if (result.ok && typeof scheduleRemedy === "function") scheduleRemedy(msg.channel);
      sendResponse({ ok: result.ok, reason: result.reason, settings: await getChannelSettings(msg.channel) });
    })();
    return true;
  }
});

if (browser.notifications && browser.notifications.onClicked) {
  browser.notifications.onClicked.addListener(async (id) => {
    const m = /^(semi|duel|duel-auto|sell-auto|protect-auto|shop-auto|kit-auto|invdump-auto|board-auto|upgrade-auto|remedy-auto|featured-auto|event):([^:]+)/.exec(id);
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
  if (alarm.name.startsWith(SELL_ALARM_PREFIX)) {
    runTurboSell(alarm.name.slice(SELL_ALARM_PREFIX.length));
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
