// shared.js
// Constantes e utilitarios usados tanto pelo background quanto pelo popup
// (e, no futuro, pela pagina de configuracoes). Antes ficavam duplicados em
// cada arquivo, com comentarios de "precisa bater com".

const AT = {
  LOG_PREFIX: "[Auto Twish]",

  // Armazenamento
  SCHEMA_VERSION: 3, // v1 = so { channels }; v2 = { schemaVersion, general, channels }; v3 = atraso geral + semi-automatico

  // Alarmes
  HEARTBEAT_NAME: "auto-twish-heartbeat",
  DUE_ALARM_PREFIX: "auto-twish-due:",

  // Twish
  TWISH_URL_PATTERNS: ["*://twish.com.br/*", "*://*.twish.com.br/*"],
  TWISH_DATA_FRESH_MS: 5 * 60 * 1000, // dado do Twish mais velho que isso e considerado obsoleto

  // Pesca
  FISH_COMMAND: "$pescar",
  DEFAULT_MAX_JITTER_SECONDS: 10,
  MIN_JITTER_SECONDS: 1,
  MAX_JITTER_SECONDS: 100,

  // Varas do jogo, da mais lenta (Bambu) pra mais rapida (Njord).
  ROD_DEFS: [
    { id: "vara_bambu", name: "Vara de Bambu", minutes: 10 },
    { id: "vara_madeira", name: "Vara de Madeira Reforçada", minutes: 9 },
    { id: "vara_fibra", name: "Vara de Fibra de Vidro", minutes: 8 },
    { id: "vara_aco", name: "Vara de Aço", minutes: 7 },
    { id: "vara_carbono", name: "Vara de Carbono", minutes: 6 },
    { id: "vara_encantada", name: "Vara Encantada", minutes: 5 },
    { id: "vara_abissal", name: "Vara Abissal", minutes: 4 },
    { id: "vara_lendaria", name: "Vara Lendária", minutes: 3 },
    { id: "vara_njord", name: "Vara Njord", minutes: 2 }
  ]
};

AT.ROD_MINUTES = Object.fromEntries(AT.ROD_DEFS.map((r) => [r.id, r.minutes]));
AT.ROD_NAME_TO_ID = Object.fromEntries(AT.ROD_DEFS.map((r) => [r.name.toLowerCase(), r.id]));
AT.DEFAULT_ROD = AT.ROD_DEFS[0].id; // vara_bambu

// Modos de cada canal.
//   manual: so a estimativa da vara + atraso (o Twish so e lido em sincronizacao explicita)
//   auto:   segue o cooldown real do Twish e envia sozinho
//   semi:   segue o cooldown real do Twish, mas so DIGITA o comando; quem envia e o jogador
AT.MODES = ["manual", "auto", "semi"];
AT.MODE_LABELS = { manual: "Manual", auto: "Automático", semi: "Semi-automático" };
AT.followsTwish = (mode) => mode === "auto" || mode === "semi";

// Configuracoes gerais (valem pra extensao toda).
AT.DEFAULT_GENERAL_SETTINGS = {
  defaultMaxJitterSeconds: 10, // atraso aleatorio maximo padrao (canais sem excecao usam este)
  twishLogin: null, // login do jogador no Twish (lido da API; usado pra reconhecer convites de duelo)
  notifyDuelInvites: false, // notificacao quando alguem te desafia pra um duelo
  semiAuto: {
    focusTab: true, // ao digitar, traz a aba (e a janela) da Twitch pra frente
    notify: true // mostra notificacao do sistema
  }
};

// Mescla configuracoes gerais salvas com os padroes (inclusive os sub-objetos).
AT.mergeGeneral = function (saved) {
  const g = saved || {};
  return {
    ...AT.DEFAULT_GENERAL_SETTINGS,
    ...g,
    semiAuto: { ...AT.DEFAULT_GENERAL_SETTINGS.semiAuto, ...(g.semiAuto || {}) }
  };
};

// Configuracoes de cada canal. Toda automacao nova entra aqui DESATIVADA.
AT.DEFAULT_CHANNEL_SETTINGS = {
  enabled: false,
  rod: AT.DEFAULT_ROD,
  maxJitterSeconds: null, // null = usa o padrao geral; numero = excecao deste canal
  mode: "manual", // "manual" | "auto" | "semi"
  awaitingUser: false, // semi-automatico: comando digitado, esperando o jogador enviar
  notifyEvents: false, // notificacao quando comeca um evento neste canal
  twishAvailableAt: null, // ultimo horario real de disponibilidade lido do Twish
  twishLastSeen: null, // quando essa leitura foi feita (gravado no maximo 1x/min durante o mesmo cooldown)
  lastSentAt: null, // ultimo envio local bem-sucedido
  nextFireAt: null // timestamp (ms) da proxima tentativa; null = sem agendamento
};

// Garante um numero inteiro dentro dos limites do slider, com fallback pro padrao.
AT.clampJitterSeconds = function (value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return AT.DEFAULT_MAX_JITTER_SECONDS;
  return Math.min(AT.MAX_JITTER_SECONDS, Math.max(AT.MIN_JITTER_SECONDS, Math.round(n)));
};

// Atraso maximo efetivo de um canal: a excecao dele, ou o padrao geral.
AT.effectiveJitterSeconds = function (channelSettings, general) {
  const own = channelSettings && channelSettings.maxJitterSeconds;
  if (own !== null && own !== undefined) return AT.clampJitterSeconds(own);
  return AT.clampJitterSeconds((general || AT.DEFAULT_GENERAL_SETTINGS).defaultMaxJitterSeconds);
};

// Outras chaves do armazenamento (fora das configuracoes):
//   gameState: { <canal>: { events: {event, grande_evento, fetchedAt}, featured: {fish, seenAt}, duelInvite: {from, expiresAt} } }
AT.EVENTS_ALARM_NAME = "auto-twish-events";
AT.GAME_BOT = "twishgamebot";
AT.DUEL_COOLDOWN_MS = 30 * 60 * 1000; // cooldown de duelo depois que um duelo termina
// gameState[canal] tambem guarda duelCooldownUntil (fim do cooldown de duelo).

// "mm:ss" (sem milissegundos).
AT.formatRemaining = function (ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return String(Math.floor(total / 60)).padStart(2, "0") + ":" + String(total % 60).padStart(2, "0");
};
