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
  notifyAutomations: false, // notificacao quando uma automacao age (duelo aceito, venda feita)
  // Automacoes por evento (Road Map item 3). Valor geral; cada canal pode ter uma excecao.
  duelAccept: {
    enabled: false, // aceitar duelos sozinho ($aceitar)
    rule: "pct", // "always" | "pct" | "minutes" — ver AT.duelAcceptDecision
    pct: 50, // so aceita se faltar pelo menos isso (%) do CD da pesca
    minutes: 3 // so aceita se faltar pelo menos isso (min) pro CD da pesca
  },
  turboSell: {
    enabled: false, // Venda Turbinada: $vender todos perto do fim do evento
    secondsBeforeEnd: 30
  },
  // Protecao automatica (Road Map item 7): mantem estas especies na whitelist
  // do jogo ($whitelist) em cada barco. So adiciona; nunca remove.
  protection: {
    enabled: false,
    fish: [] // [{ id, name }]
  },
  // Lista de Compras (Road Map item 3, Desconto na Loja): compra pelo chat
  // ($comprar) durante o evento, por ordem de prioridade (ordem da lista).
  shopList: {
    enabled: false,
    reserve: 0, // a lista nunca deixa o saldo abaixo disso
    items: [] // [{ key, itemId, name, mode: "once"|"recurring"|"unlimited", quantity, enabled }]
  },
  semiAuto: {
    focusTab: true, // ao digitar, traz a aba (e a janela) da Twitch pra frente
    notify: true // mostra notificacao do sistema
  },
  // Mercado — Aquisicao automatica (Road Map item 6). Desativada por padrao.
  market: {
    enabled: false,
    intervalSeconds: 30, // escolhido pelo jogador; cada ciclo varia +-25%
    boat: null, // canal usado nas compras (null = primeiro canal configurado)
    notifyPurchases: false
  }
};

// ---------------------------------------------------------------------------
// Automacoes por evento
// ---------------------------------------------------------------------------
AT.DUEL_RULES = ["always", "pct", "minutes"];
AT.DUEL_RULE_LABELS = {
  always: "Sempre",
  pct: "Só se faltar pelo menos X% do CD da pesca",
  minutes: "Só se faltar pelo menos X minutos para pescar"
};
AT.DUEL_ACCEPT_COMMAND = "$aceitar";
AT.SELL_ALL_COMMAND = "$vender todos";

AT.clampInt = function (v, min, max, fallback) {
  const t = String(v ?? "").trim().replace(",", ".");
  const n = t === "" ? NaN : Number(t);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

AT.sanitizeDuelAccept = function (x) {
  const d = { enabled: false, rule: "pct", pct: 50, minutes: 3 };
  const o = x && typeof x === "object" ? x : {};
  return {
    enabled: !!o.enabled,
    rule: AT.DUEL_RULES.includes(o.rule) ? o.rule : d.rule,
    pct: AT.clampInt(o.pct, 1, 100, d.pct),
    minutes: AT.clampInt(o.minutes, 1, 60, d.minutes)
  };
};

AT.sanitizeTurboSell = function (x) {
  const o = x && typeof x === "object" ? x : {};
  return { enabled: !!o.enabled, secondsBeforeEnd: AT.clampInt(o.secondsBeforeEnd, 5, 600, 30) };
};

// Valor efetivo de um canal: a excecao dele, ou o geral (igual ao atraso).
AT.effectiveDuelAccept = function (channelSettings, general) {
  const own = channelSettings && channelSettings.duelAccept;
  return AT.sanitizeDuelAccept(own || (general || AT.DEFAULT_GENERAL_SETTINGS).duelAccept);
};
AT.effectiveTurboSell = function (channelSettings, general) {
  const own = channelSettings && channelSettings.turboSell;
  return AT.sanitizeTurboSell(own || (general || AT.DEFAULT_GENERAL_SETTINGS).turboSell);
};

// Aceitar duelo zera o CD da pesca, entao so compensa quando ainda falta
// bastante. remainingMs = quanto falta pra pescar; fullMs = CD inteiro da vara
// (com Mare Turbo, se houver). Sem essas informacoes, so a regra "Sempre" aceita.
AT.duelAcceptDecision = function (cfg, { remainingMs, fullMs }) {
  if (!cfg || !cfg.enabled) return { accept: false, why: "aceite automático desligado" };
  if (cfg.rule === "always") return { accept: true, why: "regra: sempre" };
  if (remainingMs === null || remainingMs === undefined) return { accept: false, why: "não deu pra ler o CD da pesca" };
  if (cfg.rule === "minutes") {
    const ok = remainingMs >= cfg.minutes * 60000;
    return { accept: ok, why: `faltam ${AT.formatRemaining(remainingMs)} para pescar (mínimo ${cfg.minutes} min)` };
  }
  if (!(fullMs > 0)) return { accept: false, why: "CD da vara desconhecido" };
  const pct = Math.round((remainingMs / fullMs) * 100);
  return { accept: pct >= cfg.pct, why: `faltam ${pct}% do CD da pesca (mínimo ${cfg.pct}%)` };
};

// Id de especie do jogo: minusculas, numeros e "_" (ex: aruana_asiatica).
AT.FISH_ID_RE = /^[a-z0-9_]{1,60}$/;
AT.PROTECT_MAX_FISH = 100;
AT.WHITELIST_COMMAND = "$whitelist";

AT.sanitizeProtection = function (x) {
  const o = x && typeof x === "object" ? x : {};
  const seen = new Set();
  const fish = [];
  for (const f of Array.isArray(o.fish) ? o.fish : []) {
    const id = f && typeof f.id === "string" ? f.id.trim().toLowerCase() : "";
    if (!AT.FISH_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    fish.push({ id, name: typeof f.name === "string" && f.name.trim() ? f.name.trim().slice(0, 60) : id });
    if (fish.length >= AT.PROTECT_MAX_FISH) break;
  }
  return { enabled: !!o.enabled, fish };
};
AT.effectiveProtection = function (channelSettings, general) {
  const own = channelSettings && channelSettings.protection;
  return AT.sanitizeProtection(own || (general || AT.DEFAULT_GENERAL_SETTINGS).protection);
};
AT.describeProtection = function (cfg) {
  const n = cfg.fish.length;
  if (!cfg.enabled) return n ? `desligado, ${n} espécie${n === 1 ? "" : "s"} na lista` : "desligado";
  return `ligado, ${n} espécie${n === 1 ? "" : "s"}`;
};

// ---------------------------------------------------------------------------
// Lista de Compras
// ---------------------------------------------------------------------------
AT.BUY_COMMAND = "$comprar";
// Categorias da loja que entram no desconto (as mesmas que o site usa).
AT.SHOP_CATEGORIES = ["rods", "hooks", "backpacks", "baits", "boosters", "incubators", "fertilizers", "upkeep"];
AT.SHOP_CATEGORY_LABELS = {
  rods: "Varas",
  hooks: "Anzóis",
  backpacks: "Mochilas",
  baits: "Iscas",
  boosters: "Reforços",
  incubators: "Incubadora",
  fertilizers: "Fertilizantes",
  upkeep: "Manutenção"
};
AT.SHOP_SINGLE_CATEGORIES = ["rods", "hooks", "backpacks"]; // itens que se tem 1 so (compra unica, quantidade 1)
AT.SHOP_MODES = ["once", "recurring", "unlimited"];
AT.SHOP_MODE_LABELS = {
  once: "Compra única",
  recurring: "Recorrente (quantidade por desconto)",
  unlimited: "Recorrente sem limite (até acabar as moedas)"
};
AT.SHOP_MAX_QTY = 999;

AT.sanitizeShopItem = function (e) {
  if (!e || typeof e !== "object") return null;
  const itemId = typeof e.itemId === "string" ? e.itemId.trim().toLowerCase() : "";
  if (!AT.FISH_ID_RE.test(itemId)) return null;
  const mode = AT.SHOP_MODES.includes(e.mode) ? e.mode : "once";
  return {
    key: typeof e.key === "string" && e.key ? e.key.slice(0, 40) : `${itemId}-${Math.random().toString(36).slice(2, 8)}`,
    itemId,
    name: typeof e.name === "string" && e.name.trim() ? e.name.trim().slice(0, 60) : itemId,
    mode,
    quantity: mode === "unlimited" ? null : AT.clampInt(e.quantity, 1, AT.SHOP_MAX_QTY, 1),
    enabled: e.enabled !== false
  };
};

AT.sanitizeShopList = function (x) {
  const o = x && typeof x === "object" ? x : {};
  const items = [];
  const keys = new Set();
  for (const raw of Array.isArray(o.items) ? o.items : []) {
    const it = AT.sanitizeShopItem(raw);
    if (!it || keys.has(it.key)) continue;
    keys.add(it.key);
    items.push(it);
    if (items.length >= 50) break;
  }
  return { enabled: !!o.enabled, reserve: AT.clampInt(o.reserve, 0, 10000000, 0), items };
};
AT.effectiveShopList = function (channelSettings, general) {
  const own = channelSettings && channelSettings.shopList;
  return AT.sanitizeShopList(own || (general || AT.DEFAULT_GENERAL_SETTINGS).shopList);
};
AT.describeShopList = function (cfg) {
  const n = cfg.items.filter((i) => i.enabled).length;
  const txt = `${n} ite${n === 1 ? "m" : "ns"}${cfg.reserve ? `, reserva ${cfg.reserve}` : ""}`;
  return cfg.enabled ? `ligado, ${txt}` : n ? `desligado, ${txt}` : "desligado";
};

// Preco com desconto, igual ao site: arredonda o meio para o par.
AT.discountedPrice = function (cost, rate) {
  if (!rate) return cost;
  const s = cost * (1 - rate);
  const r = Math.floor(s);
  const f = s - r;
  const c = f > 0.5 ? r + 1 : f < 0.5 || r % 2 === 0 ? r : r + 1;
  return Math.max(0, c);
};

AT.describeDuelAccept = function (cfg) {
  if (!cfg.enabled) return "desligado";
  if (cfg.rule === "always") return "ligado, sempre";
  if (cfg.rule === "pct") return `ligado, se faltar ≥ ${cfg.pct}% do CD`;
  return `ligado, se faltar ≥ ${cfg.minutes} min`;
};
AT.describeTurboSell = function (cfg) {
  return cfg.enabled ? `ligado, ${cfg.secondsBeforeEnd}s antes do fim` : "desligado";
};

// Mescla configuracoes gerais salvas com os padroes (inclusive os sub-objetos).
AT.mergeGeneral = function (saved) {
  const g = saved || {};
  return {
    ...AT.DEFAULT_GENERAL_SETTINGS,
    ...g,
    semiAuto: { ...AT.DEFAULT_GENERAL_SETTINGS.semiAuto, ...(g.semiAuto || {}) },
    duelAccept: AT.sanitizeDuelAccept(g.duelAccept),
    turboSell: AT.sanitizeTurboSell(g.turboSell),
    protection: AT.sanitizeProtection(g.protection),
    shopList: AT.sanitizeShopList(g.shopList),
    market: { ...AT.DEFAULT_GENERAL_SETTINGS.market, ...(g.market || {}) }
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
  duelAccept: null, // null = usa o valor geral; objeto = excecao deste canal
  turboSell: null, // idem
  protection: null, // idem
  shopList: null, // idem
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

// ---------------------------------------------------------------------------
// Mercado
// Outras chaves do armazenamento: acquisitionList (lista de aquisicao) e
// marketState (status: ciclos, ultima mensagem, compras recentes).
// ---------------------------------------------------------------------------
AT.MARKET_ALARM_NAME = "auto-twish-market";
AT.MARKET_MIN_INTERVAL = 5;
AT.MARKET_MAX_INTERVAL = 600;
AT.MARKET_FULL_PCT = 95; // a partir daqui vale o "valor maximo"

AT.clampMarketInterval = function (v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return AT.DEFAULT_GENERAL_SETTINGS.market.intervalSeconds;
  return Math.min(AT.MARKET_MAX_INTERVAL, Math.max(AT.MARKET_MIN_INTERVAL, Math.round(n)));
};

// "% em relacao ao peso maximo", do mesmo jeito que o site calcula.
AT.marketPct = function (weight, maxKg) {
  return maxKg > 0 ? Math.floor((weight / maxKg) * 1000) / 10 : 0;
};

// Item da lista de aquisicao:
//   { id, fishId, fishName, minKg, minPct, maxPrice, maxPriceBelow95, enabled }
AT.isValidAcquisition = function (e) {
  return (
    e &&
    typeof e.fishId === "string" &&
    e.fishId &&
    [e.minKg, e.minPct, e.maxPrice, e.maxPriceBelow95].every((n) => typeof n === "number" && Number.isFinite(n) && n >= 0)
  );
};

// Regra da extensao antiga (Mercado de Peixes):
//   1) peso >= peso minimo E preco <= valor maximo, senao nao compra;
//   2) com % >= 95, compra;
//   3) abaixo de 95%, so compra com preco <= "valor maximo abaixo de 95%" E % >= % minima.
AT.shouldBuy = function (e, { weight, pct, price }) {
  if (!(weight >= e.minKg && price <= e.maxPrice)) return false;
  if (pct >= AT.MARKET_FULL_PCT) return true;
  return price <= e.maxPriceBelow95 && pct >= e.minPct;
};

// "mm:ss" (sem milissegundos).
AT.formatRemaining = function (ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return String(Math.floor(total / 60)).padStart(2, "0") + ":" + String(total % 60).padStart(2, "0");
};
