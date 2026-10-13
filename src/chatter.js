// chatter.js — Mensagens aleatorias no chat (desligado por padrao; geral +
// excecao por canal). So age em canal ATIVADO na extensao.
//
//   - Neutras ("Kappa", "duelo?"...): uma a cada 15–90 min por canal (alarme
//     proprio, sorteado de novo a cada mensagem). As que chamam para duelo
//     nao saem quando nao da para duelar (CD de duelo, convite pendente,
//     duelos desligados no canal ou em expedicao).
//   - Duelo: 50% de chance depois de um duelo seu (lista de vitoria ou de
//     derrota; empate nao tem reacao).
//   - Pesca: depois de um $pescar seu (da extensao ou digitado por voce), a
//     primeira resposta do TwishGameBot que te marca e lida como o resultado:
//     sem peixe -> 20%; peixe Comum/Incomum 25%, Raro 50%, Lendario/Mitico 75%,
//     Secreto em diante 100%. A raridade vem do bestiario do Twish (nome da
//     especie na mensagem) ou, sem bestiario, da palavra da raridade.
//
// As mensagens entram na fila de comandos (um por vez, com intervalo) e so
// sao enviadas com o campo do chat VAZIO: nunca apagam o que voce estiver
// digitando nem o $pescar do semi-automatico. Listas e chances: shared.js
// (AT.CHATTER_MESSAGES, AT.CHATTER_CHANCES, AT.CHATTER_TIER_GROUP).
// ---------------------------------------------------------------------------

const CHATTER_ALARM_PREFIX = "auto-twish-chatter:";
const CHATTER_CAST_WINDOW_MS = 20 * 1000; // espera a resposta do bot por ate isso depois do $pescar
const CHATTER_MIN_GAP_MS = 20 * 1000; // no maximo 1 mensagem aleatoria a cada 20 s por canal
const CHATTER_REACT_MIN_MS = 2000; // reacao "humana": 2–8 s depois da mensagem do bot
const CHATTER_REACT_JITTER_MS = 6000;
const CHATTER_DUEL_DEDUP_MS = 2 * 60 * 1000; // o mesmo fim de duelo pode chegar por 2 abas
const CHATTER_SPECIES_TTL_MS = 6 * 60 * 60 * 1000;
const CHATTER_SPECIES_RETRY_MS = 5 * 60 * 1000;

const chatterCastWindows = new Map(); // canal -> fim da janela de espera da resposta da pesca
const chatterLastAt = new Map(); // canal -> horario da ultima mensagem aleatoria
const chatterLastText = new Map(); // canal -> ultima mensagem aleatoria
const chatterDuelAt = new Map(); // canal -> horario da ultima reacao a duelo
let chatterSpeciesCache = { at: 0, list: [] };

function chatterNeutralDelayMs() {
  return AT.CHATTER_NEUTRAL_MIN_MS + Math.random() * (AT.CHATTER_NEUTRAL_MAX_MS - AT.CHATTER_NEUTRAL_MIN_MS);
}

// Canal ativado + mensagens aleatorias ligadas (geral ou excecao do canal).
async function chatterEnabledFor(channel) {
  const general = await getGeneralSettings();
  const s = (await getAllChannelSettings())[channel];
  return !!(s && s.enabled && AT.effectiveRandomChat(s, general).enabled);
}

// Especies do jogo (publico; o bestiario e o mesmo em todos os barcos).
async function chatterSpecies(channel) {
  const c = chatterSpeciesCache;
  if (c.list.length && Date.now() - c.at < CHATTER_SPECIES_TTL_MS) return c.list;
  if (!c.list.length && c.failedAt && Date.now() - c.failedAt < CHATTER_SPECIES_RETRY_MS) return c.list;
  try {
    const r = await fetch(`https://twish.com.br/api/${encodeURIComponent(channel)}/bestiary`, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const raw = Array.isArray(j) ? j : j.fish || j.species || [];
    const list = AT.compileSpecies(raw.map((f) => ({ name: f && f.name, tier: f && f.tier })));
    if (list.length) chatterSpeciesCache = { at: Date.now(), list };
    else chatterSpeciesCache = { ...c, failedAt: Date.now() };
  } catch (e) {
    chatterSpeciesCache = { ...c, failedAt: Date.now() };
  }
  return chatterSpeciesCache.list;
}

// Envia uma mensagem da lista "group" no canal (pela fila, com o campo vazio).
// list: lista ja filtrada (opcional). why: motivo, para o log.
async function chatterSay(channel, group, why, { list, delayMs = 0 } = {}) {
  if (Date.now() - (chatterLastAt.get(channel) || 0) < CHATTER_MIN_GAP_MS) return { ok: false, reason: "intervalo" };
  const text = AT.pickChatterMessage(list || AT.CHATTER_MESSAGES[group], chatterLastText.get(channel));
  if (!text) return { ok: false, reason: "lista-vazia" };
  chatterLastAt.set(channel, Date.now()); // reserva (evita duas reacoes quase juntas)
  if (delayMs > 0) await sleep(delayMs);

  // Confere de novo depois da espera: canal desligado, verificacao, semi esperando.
  const s = (await getAllChannelSettings())[channel];
  if (!(await chatterEnabledFor(channel)) || safetyLocked || (s && s.awaitingUser)) return { ok: false, reason: "pausado" };

  const r = await enqueueCommand(channel, text, { reason: `mensagem aleatória: ${why}`, onlyIfEmpty: true });
  if (r.ok) {
    chatterLastAt.set(channel, Date.now());
    chatterLastText.set(channel, text);
    logActivity(channel, "mensagens", `Enviei "${text}" (${why}).`);
  }
  return r;
}

// ---------------------------------------------------------------------------
// Pesca: background.js chama noteCastForChatter quando um $pescar sai (da
// extensao ou do jogador); o content.js repassa as mensagens do bot que
// marcam o jogador (CHAT_BOT_MENTION).
// ---------------------------------------------------------------------------
function noteCastForChatter(channel) {
  if (!channel) return;
  chatterCastWindows.set(channel, Date.now() + CHATTER_CAST_WINDOW_MS);
  chatterSpecies(channel).catch(() => {}); // ja deixa o bestiario em cache
}

async function onBotMentionForChatter(channel, text) {
  const until = chatterCastWindows.get(channel);
  if (!until || Date.now() > until) return;
  const general = await getGeneralSettings();
  if (!AT.mentionsLogin(text, general.twishLogin)) return;
  if (chatterCastWindows.get(channel) !== until) return; // outra aba ja tratou esta resposta
  chatterCastWindows.delete(channel); // so a primeira resposta do bot depois do $pescar conta

  const res = AT.classifyCastReply(text, await chatterSpecies(channel));
  if (!res) {
    console.log(`${AT.LOG_PREFIX} [mensagens] "${channel}": resposta da pesca nao reconhecida: ${text}`);
    if (await chatterEnabledFor(channel)) logActivity(channel, "mensagens", `Resposta da pesca não reconhecida (sem reação): ${text}`);
    return;
  }
  if (res.kind === "other") return;
  const group = res.kind === "fail" ? "fail" : AT.CHATTER_TIER_GROUP[res.tier];
  if (!group) return;
  if (!(await chatterEnabledFor(channel))) return;

  const what = res.kind === "fail" ? AT.CHATTER_GROUP_LABELS.fail : `${res.species ? res.species + ", " : ""}${AT.TIER_LABELS[res.tier] || res.tier}`;
  const chance = AT.CHATTER_CHANCES[group];
  if (Math.random() >= chance) {
    console.log(`${AT.LOG_PREFIX} [mensagens] "${channel}": pesca (${what}) — sem reacao desta vez (${Math.round(chance * 100)}%).`);
    return;
  }
  await chatterSay(channel, group, `pesca: ${what}`, { delayMs: CHATTER_REACT_MIN_MS + Math.random() * CHATTER_REACT_JITTER_MS });
}

// ---------------------------------------------------------------------------
// Duelo: background.js (onDuelEnd) chama isto quando um duelo seu termina.
// ---------------------------------------------------------------------------
async function onDuelEndForChatter(channel, text) {
  if (!text || Date.now() - (chatterDuelAt.get(channel) || 0) < CHATTER_DUEL_DEDUP_MS) return;
  chatterDuelAt.set(channel, Date.now());
  const general = await getGeneralSettings();
  const outcome = AT.duelOutcome(text, general.twishLogin);
  if (!outcome || !(await chatterEnabledFor(channel))) return;
  const group = outcome === "win" ? "duelWin" : "duelLoss";
  if (Math.random() >= AT.CHATTER_CHANCES[group]) return;
  await chatterSay(channel, group, AT.CHATTER_GROUP_LABELS[group], { delayMs: CHATTER_REACT_MIN_MS + Math.random() * CHATTER_REACT_JITTER_MS });
}

// ---------------------------------------------------------------------------
// Neutras: um alarme por canal.
// ---------------------------------------------------------------------------

// Da para chamar alguem para duelo agora neste canal?
async function chatterCanDuel(channel) {
  const { gameState } = await browser.storage.local.get("gameState");
  const st = (gameState || {})[channel] || {};
  const now = Date.now();
  if (st.duelCooldownUntil && st.duelCooldownUntil > now) return false;
  if (st.duelInvite && st.duelInvite.expiresAt > now) return false;
  if (st.duelSettings && st.duelSettings.enabled === false) return false;
  const exp = typeof readExpeditionState === "function" ? await readExpeditionState() : null;
  if (exp && exp.atSea && (!exp.endsAt || exp.endsAt > now)) return false;
  return true;
}

async function runNeutralChatter(channel) {
  if (!(await chatterEnabledFor(channel))) return; // sem novo alarme; o heartbeat recria se voltar a valer
  await browser.alarms.create(`${CHATTER_ALARM_PREFIX}${channel}`, { when: Date.now() + chatterNeutralDelayMs() });
  if (safetyLocked) return;
  if (!(await twitchTabsForChannel(channel)).length) return; // sem aba do canal: fica para a proxima
  const canDuel = await chatterCanDuel(channel);
  const list = AT.CHATTER_MESSAGES.neutral.filter((m) => canDuel || !AT.CHATTER_DUEL_MSG_RE.test(m));
  await chatterSay(channel, "neutral", canDuel ? AT.CHATTER_GROUP_LABELS.neutral : `${AT.CHATTER_GROUP_LABELS.neutral}, sem chamar para duelo`, { list });
}

// Chamado pelo heartbeat (1x por minuto, enquanto houver canal ativado):
// cria o alarme dos canais que passaram a valer e apaga o dos outros.
async function ensureChatterAlarms() {
  const general = await getGeneralSettings();
  const channels = await getAllChannelSettings();
  const alarms = await browser.alarms.getAll();
  const have = new Set(alarms.filter((a) => a.name.startsWith(CHATTER_ALARM_PREFIX)).map((a) => a.name.slice(CHATTER_ALARM_PREFIX.length)));
  for (const [channel, s] of Object.entries(channels)) {
    const on = !!(s && s.enabled && AT.effectiveRandomChat(s, general).enabled);
    if (on && !have.has(channel)) {
      const when = Date.now() + chatterNeutralDelayMs();
      await browser.alarms.create(`${CHATTER_ALARM_PREFIX}${channel}`, { when });
      console.log(`${AT.LOG_PREFIX} [mensagens] "${channel}": proxima mensagem neutra as ${new Date(when).toLocaleTimeString()}.`);
    } else if (!on && have.has(channel)) {
      await browser.alarms.clear(`${CHATTER_ALARM_PREFIX}${channel}`);
    }
    have.delete(channel);
  }
  for (const gone of have) await browser.alarms.clear(`${CHATTER_ALARM_PREFIX}${gone}`); // canal removido
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (!alarm.name.startsWith(CHATTER_ALARM_PREFIX)) return;
  runNeutralChatter(alarm.name.slice(CHATTER_ALARM_PREFIX.length)).catch((e) => console.warn(`${AT.LOG_PREFIX} Falha na mensagem neutra:`, e));
});

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type !== "CHAT_BOT_MENTION" || typeof msg.text !== "string") return;
  const channel = extractChannelFromUrl(sender?.tab?.url || "");
  if (channel) onBotMentionForChatter(channel, msg.text.slice(0, 500)).catch((e) => console.warn(`${AT.LOG_PREFIX} Falha na reacao a pesca:`, e));
  return false;
});
