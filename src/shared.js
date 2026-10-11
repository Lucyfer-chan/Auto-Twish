// shared.js
// Constantes e utilitarios usados tanto pelo background quanto pelo popup
// (e, no futuro, pela pagina de configuracoes). Antes ficavam duplicados em
// cada arquivo, com comentarios de "precisa bater com".

const AT = {
  LOG_PREFIX: "[Auto Twish]",

  // Armazenamento
  SCHEMA_VERSION: 2, // v1 = so { channels }; v2 = { schemaVersion, general, channels }

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

// Configuracoes gerais (valem pra extensao toda). Vazio por enquanto; a
// pagina de configuracoes (Fase 2) vai preencher.
AT.DEFAULT_GENERAL_SETTINGS = {};

// Configuracoes de cada canal. Toda automacao nova entra aqui DESATIVADA.
AT.DEFAULT_CHANNEL_SETTINGS = {
  enabled: false,
  rod: AT.DEFAULT_ROD,
  maxJitterSeconds: AT.DEFAULT_MAX_JITTER_SECONDS, // atraso aleatorio extra vai de 0 ate esse valor
  mode: "manual", // "manual" | "auto"
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

// "mm:ss" (sem milissegundos).
AT.formatRemaining = function (ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return String(Math.floor(total / 60)).padStart(2, "0") + ":" + String(total % 60).padStart(2, "0");
};
