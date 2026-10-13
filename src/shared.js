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
  // Verificacao anti-bot pedida: abrir twish.com.br/verificacao numa janela
  // nova em foco e tocar um alerta sonoro. So avisa; nunca responde.
  verifyAlert: null, // preenchido por AT.sanitizeVerifyAlert
  // Automacoes por evento (Road Map item 3). Valor geral; cada canal pode ter uma excecao.
  duelAccept: {
    enabled: false, // aceitar duelos sozinho ($aceitar)
    rule: "minTime", // "always" | "minTime" — ver AT.duelAcceptDecision
    minSeconds: 180 // so aceita se faltar pelo menos isso (s) pro CD da pesca
  },
  turboSell: {
    enabled: false, // Venda Turbinada: $vender todos perto do fim do evento
    secondsBeforeEnd: 30
  },
  // Inv Dump: vende os peixes mais baratos ($vender <especie> <qtd>) para
  // manter sempre 1 vaga livre no inventario e 1 em cada especie.
  invDump: {
    enabled: false,
    keepFromTier: "mythic" // nunca vende desta raridade em diante (null = sem limite)
  },
  // Embarque automatico nas expedicoes (sala anunciada no chat de um canal
  // ativado): entra e confirma pela API do site; pesca antes, se der.
  autoBoard: null, // preenchido por AT.sanitizeAutoBoard
  // $destaque automatico: 1x por dia do jogo (vira as 00:30) em canal ativado.
  autoFeatured: { enabled: false },
  // Remedios: cura Canto da Sereia (Alga medicinal) e Maldicao (Agua benta).
  autoRemedy: null, // preenchido por AT.sanitizeAutoRemedy
  // Mensagens aleatorias no chat (neutras de tempos em tempos; reacoes depois
  // de duelo e de pesca). Ver chatter.js.
  randomChat: { enabled: false },
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
  // Aprimoramento automatico: varas, mochilas e anzois ($comprar), com a
  // reserva da Lista de Compras.
  autoUpgrade: null, // preenchido por AT.sanitizeAutoUpgrade
  // Isca e reforcos por evento (Road Map item 3): XP em Dobro, Mare Turbo, Sorte Rara.
  eventKit: null, // preenchido por AT.sanitizeEventKit
  // Torneio: entrada automatica ($entrar), isca durante o torneio, Turbo Torneio.
  tournament: null, // preenchido por AT.sanitizeTournament
  // Duelo: equipar 1 isca para o duelo.
  duelBait: null, // preenchido por AT.sanitizeDuelBait
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
AT.DUEL_RULES = ["always", "minTime"];
AT.DUEL_RULE_LABELS = {
  always: "Sempre",
  minTime: "Só se faltar pelo menos um tempo para pescar"
};
// Torneio: "fishFirst" = se o CD da pesca acaba antes de fecharem as
// inscricoes, pesca antes e entra logo depois; senao, entra na hora.
AT.TOURNEY_RULES = ["fishFirst", "always", "minTime"];
AT.TOURNEY_RULE_LABELS = {
  fishFirst: "Pescar antes, se o CD acabar antes de fecharem as inscrições",
  always: "Sempre, na hora",
  minTime: "Só se faltar pelo menos um tempo para pescar"
};
AT.MAX_MIN_SECONDS = 3600;

// "m:ss"
AT.formatMinSec = function (sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
};
// Converte configuracoes antigas (% ou minutos) para segundos.
function legacyMinSeconds(o, fallback) {
  if (o.minSeconds !== undefined && o.minSeconds !== null && o.minSeconds !== "") return AT.clampInt(o.minSeconds, 0, AT.MAX_MIN_SECONDS, fallback);
  if (o.rule === "minutes" && o.minutes !== undefined) return AT.clampInt(Number(o.minutes) * 60, 0, AT.MAX_MIN_SECONDS, fallback);
  return fallback;
}
AT.DUEL_ACCEPT_COMMAND = "$aceitar";
AT.SELL_ALL_COMMAND = "$vender todos";

AT.clampInt = function (v, min, max, fallback) {
  const t = String(v ?? "").trim().replace(",", ".");
  const n = t === "" ? NaN : Number(t);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
};

AT.sanitizeDuelAccept = function (x) {
  const o = x && typeof x === "object" ? x : {};
  return {
    enabled: !!o.enabled,
    rule: o.rule === "always" ? "always" : "minTime", // "pct"/"minutes" antigos viram tempo minimo
    minSeconds: legacyMinSeconds(o, 180)
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
// ---------------------------------------------------------------------------
// Raridades do jogo (da mais comum para a mais rara)
// ---------------------------------------------------------------------------
AT.TIERS = ["common", "uncommon", "rare", "legendary", "mythic", "secret", "divine", "ancient_god"];
AT.TIER_LABELS = {
  common: "Comum",
  uncommon: "Incomum",
  rare: "Raro",
  legendary: "Lendário",
  mythic: "Mítico",
  secret: "Secreto",
  divine: "Divino",
  ancient_god: "Deuses Anciões"
};
AT.tierRank = (t) => AT.TIERS.indexOf(t);

// ---------------------------------------------------------------------------
// Inv Dump
// ---------------------------------------------------------------------------
AT.SELL_COMMAND = "$vender";
AT.INV_DUMP_KEEP_TIERS = ["uncommon", "rare", "legendary", "mythic", "secret", "divine"];
AT.sanitizeInvDump = function (x) {
  const o = x && typeof x === "object" ? x : {};
  let keep = "mythic";
  if (o.keepFromTier === null || o.keepFromTier === "") keep = null;
  else if (AT.INV_DUMP_KEEP_TIERS.includes(o.keepFromTier)) keep = o.keepFromTier;
  return { enabled: !!o.enabled, keepFromTier: keep };
};
AT.effectiveInvDump = function (channelSettings, general) {
  const own = channelSettings && channelSettings.invDump;
  return AT.sanitizeInvDump(own || (general || AT.DEFAULT_GENERAL_SETTINGS).invDump);
};
AT.describeInvDump = function (cfg) {
  if (!cfg.enabled) return "desligado";
  return cfg.keepFromTier ? `ligado, nunca vende de ${AT.TIER_LABELS[cfg.keepFromTier]} em diante` : "ligado, sem limite de raridade";
};

// Decide o que vender. inv = resposta de /api/{canal}/me/inventory;
// opts = { whitelist: Set de especies protegidas, keepFromTier }.
// Regra: uma especie esta cheia quando tem o maximo por especie (as ascensoes
// somam na mesma especie); o inventario, quando tem o maximo total. Enquanto
// houver especie cheia, vende entre as especies cheias; com o inventario cheio
// e nenhuma especie cheia, vende no geral. Em cada caso, primeiro o de menor
// ascensao (nao ascendidos primeiro) e, entre esses, o mais barato. Nunca vende: especie da whitelist,
// raridade a partir de keepFromTier, Deuses Ancioes, raridade desconhecida e
// peixe anunciado no Mercado (escrowed).
// Devolve { sells: [{ id, qty, coins }], total, capTotal, capSpecies, blocked: [ids cheios sem o que vender] }.
AT.planInvDump = function (inv, opts) {
  const o = opts || {};
  const wl = o.whitelist instanceof Set ? o.whitelist : new Set(o.whitelist || []);
  const cap = (inv && inv.capacity) || {};
  const capTotal = Number(cap.max_fish_total) || 0;
  const capSpecies = Number(cap.max_fish_per_species) || 0;
  const out = { sells: [], total: 0, capTotal, capSpecies, blocked: [] };
  if (!capTotal || !capSpecies || !inv || !Array.isArray(inv.fish)) return out;
  const keepRank = o.keepFromTier ? AT.tierRank(o.keepFromTier) : Infinity;

  const counts = new Map();
  const pool = [];
  let sum = 0;
  for (const st of inv.fish) {
    if (!st) continue;
    const id = String(st.fish_id || st.id || "");
    if (!AT.FISH_ID_RE.test(id)) continue;
    const n = Number(st.count) || 0;
    counts.set(id, (counts.get(id) || 0) + n);
    sum += n;
    const rank = AT.tierRank(st.tier);
    const sellable = !wl.has(id) && rank >= 0 && st.tier !== "ancient_god" && rank < keepRank;
    if (!sellable) continue;
    for (const i of Array.isArray(st.instances) ? st.instances : []) {
      const price = Number(i && i.price);
      if (i && !i.escrowed && Number.isFinite(price)) pool.push({ id, price, asc: Number(st.ascension_level) || 0 });
    }
  }
  let total = Number.isFinite(Number(inv.total)) ? Number(inv.total) : sum;
  out.total = total;
  pool.sort((a, b) => a.asc - b.asc || a.price - b.price); // menor ascensao, depois mais barato

  const sold = new Map();
  for (let guard = 0; guard < 1000; guard++) {
    const full = new Set([...counts].filter(([, n]) => n >= capSpecies).map(([id]) => id));
    let idx = pool.findIndex((p) => full.has(p.id)); // primeiro entre as especies cheias
    if (idx < 0 && total >= capTotal) idx = pool.length ? 0 : -1; // senao, no geral
    if (idx < 0) break;
    const pick = pool.splice(idx, 1)[0];
    counts.set(pick.id, counts.get(pick.id) - 1);
    total--;
    const r = sold.get(pick.id) || { id: pick.id, qty: 0, coins: 0 };
    r.qty++;
    r.coins += pick.price;
    sold.set(pick.id, r);
  }
  out.sells = [...sold.values()];
  out.blocked = [...counts].filter(([, n]) => n >= capSpecies).map(([id]) => id);
  return out;
};

AT.effectiveTurboSell = function (channelSettings, general) {
  const own = channelSettings && channelSettings.turboSell;
  return AT.sanitizeTurboSell(own || (general || AT.DEFAULT_GENERAL_SETTINGS).turboSell);
};

// Aceitar duelo zera o CD da pesca, entao so compensa quando ainda falta
// bastante. remainingMs = quanto falta pra pescar; fullMs = CD inteiro da vara
// (com Mare Turbo, se houver). Sem essas informacoes, so a regra "Sempre" aceita.
AT.duelAcceptDecision = function (cfg, { remainingMs }) {
  if (!cfg || !cfg.enabled) return { accept: false, why: "aceite automático desligado" };
  if (cfg.rule === "always") return { accept: true, why: "regra: sempre" };
  if (remainingMs === null || remainingMs === undefined) return { accept: false, why: "não deu pra ler o CD da pesca" };
  const ok = remainingMs >= cfg.minSeconds * 1000;
  return { accept: ok, why: `faltam ${AT.formatRemaining(remainingMs)} para pescar (mínimo ${AT.formatMinSec(cfg.minSeconds)})` };
};

// Id de especie do jogo: minusculas, numeros e "_" (ex: aruana_asiatica).
AT.FISH_ID_RE = /^[a-z0-9_]{1,60}$/;
AT.PROTECT_MAX_FISH = 100;
AT.PROTECT_TIERS = ["uncommon", "rare", "legendary", "mythic", "secret", "divine"];
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
  // fromTier: protege tambem as especies que o jogador tem desta raridade em diante (null = so a lista).
  const fromTier = AT.PROTECT_TIERS.includes(o.fromTier) ? o.fromTier : null;
  return { enabled: !!o.enabled, fish, fromTier };
};
// A Protecao tem algo a fazer? (lista de especies ou raridade)
AT.protectionActive = function (cfg) {
  return !!(cfg && cfg.enabled && (cfg.fish.length || cfg.fromTier));
};
AT.effectiveProtection = function (channelSettings, general) {
  const own = channelSettings && channelSettings.protection;
  return AT.sanitizeProtection(own || (general || AT.DEFAULT_GENERAL_SETTINGS).protection);
};
AT.describeProtection = function (cfg) {
  const n = cfg.fish.length;
  const tier = cfg.fromTier ? `${AT.TIER_LABELS[cfg.fromTier]} em diante` : "";
  const list = n ? `${n} espécie${n === 1 ? "" : "s"}` : "";
  const what = [list, tier].filter(Boolean).join(" + ");
  if (!cfg.enabled) return what ? `desligado, ${what}` : "desligado";
  return what ? `ligado, ${what}` : "ligado, nada escolhido";
};
// Menor (mais comum) entre duas raridades-limite; null = sem limite.
AT.minTier = function (a, b) {
  if (!a) return b || null;
  if (!b) return a;
  return AT.tierRank(a) <= AT.tierRank(b) ? a : b;
};

// ---------------------------------------------------------------------------
// Lista de Compras
// ---------------------------------------------------------------------------
AT.BUY_COMMAND = "$comprar";
// Categorias da Lista de Compras. Varas, anzois e mochilas ficam com o
// Aprimoramento automatico (desde a 1.0.3).
AT.SHOP_CATEGORIES = ["baits", "boosters", "incubators", "fertilizers", "upkeep"];
AT.UPGRADE_ITEM_RE = /^(vara|anzol|mochila)_/;
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
  if (AT.UPGRADE_ITEM_RE.test(itemId)) return null; // vara/anzol/mochila: agora no Aprimoramento
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

// ---------------------------------------------------------------------------
// Aprimoramento automatico
// ---------------------------------------------------------------------------
AT.UPGRADE_CATEGORIES = ["rods", "backpacks", "hooks"];
AT.UPGRADE_LABELS = { rods: "Vara", backpacks: "Mochila", hooks: "Anzol" };
AT.UPGRADE_WHEN = ["anytime", "discount"];
AT.UPGRADE_WHEN_LABELS = { anytime: "Assim que tiver dinheiro", discount: "Só durante o Desconto na Loja" };
AT.sanitizeAutoUpgrade = function (x) {
  const o = x && typeof x === "object" ? x : {};
  const order = [];
  for (const c of Array.isArray(o.order) ? o.order : []) if (AT.UPGRADE_CATEGORIES.includes(c) && !order.includes(c)) order.push(c);
  for (const c of AT.UPGRADE_CATEGORIES) if (!order.includes(c)) order.push(c);
  const categories = {};
  for (const c of AT.UPGRADE_CATEGORIES) categories[c] = !(o.categories && o.categories[c] === false);
  return { enabled: !!o.enabled, when: AT.UPGRADE_WHEN.includes(o.when) ? o.when : "anytime", order, categories };
};
AT.effectiveAutoUpgrade = function (s, g) {
  return AT.sanitizeAutoUpgrade((s && s.autoUpgrade) || (g || AT.DEFAULT_GENERAL_SETTINGS).autoUpgrade);
};
AT.describeAutoUpgrade = function (c) {
  if (!c.enabled) return "desligado";
  const cats = c.order.filter((x) => c.categories[x]).map((x) => AT.UPGRADE_LABELS[x]);
  return cats.length ? `ligado: ${cats.join(" → ")}, ${c.when === "discount" ? "só no desconto" : "assim que der"}` : "ligado, nenhuma categoria";
};

// ---------------------------------------------------------------------------
// Dia do jogo: o peixe em destaque troca a meia-noite; a extensao considera o
// dia novo as 00:30 (folga para o jogo atualizar).
// ---------------------------------------------------------------------------
AT.GAME_DAY_OFFSET_MS = 30 * 60 * 1000;
AT.gameDay = function (ts = Date.now()) {
  const d = new Date(ts - AT.GAME_DAY_OFFSET_MS);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
AT.gameDayStart = function (ts = Date.now()) {
  const d = new Date(ts - AT.GAME_DAY_OFFSET_MS);
  d.setHours(0, 0, 0, 0);
  return d.getTime() + AT.GAME_DAY_OFFSET_MS;
};

// $destaque automatico
AT.FEATURED_COMMAND = "$destaque";
AT.sanitizeAutoFeatured = function (x) {
  const o = x && typeof x === "object" ? x : {};
  return { enabled: !!o.enabled };
};
AT.effectiveAutoFeatured = function (s, g) {
  return AT.sanitizeAutoFeatured((s && s.autoFeatured) || (g || AT.DEFAULT_GENERAL_SETTINGS).autoFeatured);
};
AT.describeAutoFeatured = function (c) {
  return c.enabled ? "ligado, 1x por dia" : "desligado";
};

// ---------------------------------------------------------------------------
// Mensagens aleatorias no chat (chatter.js)
// ---------------------------------------------------------------------------
AT.sanitizeRandomChat = function (x) {
  const o = x && typeof x === "object" ? x : {};
  return { enabled: !!o.enabled };
};
AT.effectiveRandomChat = function (s, g) {
  return AT.sanitizeRandomChat((s && s.randomChat) || (g || AT.DEFAULT_GENERAL_SETTINGS).randomChat);
};
AT.describeRandomChat = function (c) {
  return c.enabled ? "ligado" : "desligado";
};

// Neutras: uma a cada 15–90 min (sorteado de novo a cada vez), por canal.
AT.CHATTER_NEUTRAL_MIN_MS = 15 * 60 * 1000;
AT.CHATTER_NEUTRAL_MAX_MS = 90 * 60 * 1000;

// Listas de mensagens. Para mudar o que a extensao fala, edite aqui.
AT.CHATTER_MESSAGES = {
  neutral: ["Kappa", "duelo?", "duelo alguem?", "bora duelo?"],
  duelLoss: ["droga...", "GRRR", "na próxima eu ganho", "gg", "bom duelo"],
  duelWin: ["gg", "bom duelo", "get gud", "mais sorte na próxima", "FeelsOkayMan", "PogChamp", "FeelsGoodMan"],
  fail: ["FeelsBadMan", "puts", "nunca pesco nada", "droga...", "a nem viu..."],
  low: ["melhor que nada", "pelo menos veio algo", "meh", "já é alguma coisa", "PogChamp"], // Comum e Incomum
  rare: ["Pog", "FeelsOkayMan", "PogChamp", "nice"], // Raro
  legendary: ["Poggers", "FeelsGoodMan", "PogChamp", "very nice", "gg"], // Lendario e Mitico
  epic: ["POGGERS", "FeelsAmazingMan", "PogChamp", "WOW", "UAU", "caralhoooo", "EZ Fishh"] // Secreto em diante
};
// Chance de reagir (0 a 1).
AT.CHATTER_CHANCES = { duelLoss: 0.5, duelWin: 0.5, fail: 0.2, low: 0.25, rare: 0.5, legendary: 0.75, epic: 1 };
// Raridade do peixe -> lista.
AT.CHATTER_TIER_GROUP = {
  common: "low",
  uncommon: "low",
  rare: "rare",
  legendary: "legendary",
  mythic: "legendary",
  secret: "epic",
  divine: "epic",
  ancient_god: "epic"
};
AT.CHATTER_GROUP_LABELS = {
  neutral: "neutra",
  duelLoss: "derrota no duelo",
  duelWin: "vitória no duelo",
  fail: "pesca sem peixe",
  low: "peixe Comum/Incomum",
  rare: "peixe Raro",
  legendary: "peixe Lendário/Mítico",
  epic: "peixe Secreto ou mais raro"
};
// Mensagens neutras que chamam para duelo (nao saem quando nao da para duelar).
AT.CHATTER_DUEL_MSG_RE = /duelo/i;

// Sem acentos e em minusculas (para comparar textos do bot).
AT.normalizeText = function (s) {
  return String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
};

// O texto marca o jogador (@login ou o login como palavra)?
AT.mentionsLogin = function (text, login) {
  if (!login) return false;
  const esc = String(login).toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9_])@?${esc}($|[^a-z0-9_])`, "i").test(String(text || ""));
};

// Resultado de um duelo para o jogador: "win", "loss" ou null (empate/desconhecido).
// "@a venceu o duelo contra @b" -> vence quem foi marcado logo antes de "venceu";
// "@a perdeu o duelo para @b" -> perde quem foi marcado logo antes de "perdeu".
AT.duelOutcome = function (text, login) {
  const t = AT.normalizeText(text);
  const me = String(login || "").toLowerCase();
  if (!me || /\bempat/.test(t)) return null;
  const lastMentionBefore = (re) => {
    const m = re.exec(t);
    if (!m) return null;
    const before = [...t.slice(0, m.index).matchAll(/@(\w+)/g)];
    return before.length ? before[before.length - 1][1] : null;
  };
  const winner = lastMentionBefore(/\bvenceu\b/);
  if (winner) return winner === me ? "win" : "loss";
  const loser = lastMentionBefore(/\bperdeu\b/);
  if (loser) return loser === me ? "loss" : "win";
  return null;
};

// Resposta do bot ao $pescar do jogador.
//   species = [{ name, tier }] (bestiario do Twish), opcional.
// Devolve { kind: "catch", tier, species? } | { kind: "fail" } |
//         { kind: "other" } (resposta que nao e de pesca, ex: cooldown) | null (nao reconhecida).
AT.CHATTER_TIER_WORDS = [
  ["ancient_god", /\b(deus(es)? ancia(o|os|oes)|ancia(o|os|oes))\b/],
  ["divine", /\bdivin[oa]s?\b/],
  ["secret", /\bsecret[oa]s?\b/],
  ["mythic", /\bmitic[oa]s?\b/],
  ["legendary", /\blendari[oa]s?\b/],
  ["rare", /\brar[oa]s?\b/],
  ["uncommon", /\bincomu(m|ns)\b/],
  ["common", /\bcomu(m|ns)\b/]
];
// Nunca e resposta de pesca (venda, whitelist, compra, item...), mesmo citando um peixe.
AT.CHATTER_NOT_CAST_RE = /\b(vend(eu|ido|idos|ida|idas)|whitelist|protegid\w*|compr(ou|ado|ada|ados|adas)|anunci\w*|equip(ou|ad[oa]s?)|ativ(ou|ad[oa]))\b/;
// Peixe escapou: falha, mesmo citando o peixe.
AT.CHATTER_ESCAPED_RE = /\b(escap\w*|fugiu|fugiram|soltou|arrebent\w*)\b/;
// Pesca sem peixe.
AT.CHATTER_FAIL_RE = /\b(nada|nenhum peixe|sem peixe|nao (pescou|fisgou|pegou|mordeu|veio)|ninguem mordeu|vazi[oa]s?|linha (partiu|quebrou))\b/;
// Respostas que nao sao de pesca (cooldown, mochila cheia...), quando nao cita peixe.
AT.CHATTER_OTHER_RE = /\b(aguard\w*|esper\w*|cooldown|recarreg\w*|faltam?|daqui a|ainda nao|so (pode|da)|cheia|cheio|mochila|inventario|verific\w*|torneio|expedic\w*|duelo)\b/;

AT.compileSpecies = function (species) {
  const out = [];
  for (const f of Array.isArray(species) ? species : []) {
    const n = AT.normalizeText(f && f.name).trim();
    if (n.length < 3 || !AT.TIERS.includes(f.tier)) continue;
    const esc = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
    out.push({ name: f.name, tier: f.tier, len: n.length, re: new RegExp(`(^|[^a-z0-9])${esc}($|[^a-z0-9])`) });
  }
  return out.sort((a, b) => b.len - a.len); // nome mais longo primeiro ("Tucunare Azul" antes de "Tucunare")
};

AT.classifyCastReply = function (text, compiledSpecies) {
  const t = AT.normalizeText(text).replace(/sorte\s+rara/g, " ");
  if (AT.CHATTER_NOT_CAST_RE.test(t)) return { kind: "other" };
  let tier = null;
  let species = null;
  for (const f of compiledSpecies || []) {
    if (f.re.test(t)) {
      tier = f.tier;
      species = f.name;
      break;
    }
  }
  if (!tier) {
    const w = AT.CHATTER_TIER_WORDS.find(([, re]) => re.test(t));
    if (w) tier = w[0];
  }
  if (tier) {
    if (AT.CHATTER_ESCAPED_RE.test(t)) return { kind: "fail" };
    return species ? { kind: "catch", tier, species } : { kind: "catch", tier };
  }
  if (AT.CHATTER_ESCAPED_RE.test(t)) return { kind: "fail" };
  if (AT.CHATTER_OTHER_RE.test(t)) return { kind: "other" };
  if (AT.CHATTER_FAIL_RE.test(t)) return { kind: "fail" };
  return null;
};

// Sorteia uma mensagem da lista, nunca repetindo a ultima (o chat da Twitch
// costuma bloquear mensagens identicas seguidas). null = nada a enviar.
AT.pickChatterMessage = function (list, last, rnd = Math.random) {
  const pool = (list || []).filter((m) => m && m !== last);
  return pool.length ? pool[Math.floor(rnd() * pool.length)] : null;
};

// Remedios (efeitos ruins da expedicao, por barco)
AT.REMEDIES = {
  siren: { item: "alga_medicinal", name: "Alga medicinal", effect: "Canto da Sereia", field: "siren_remaining" },
  curse: { item: "agua_benta", name: "Água benta", effect: "Maldição", field: "curse_remaining" }
};
AT.sanitizeAutoRemedy = function (x) {
  const o = x && typeof x === "object" ? x : {};
  return { enabled: !!o.enabled, siren: o.siren !== false, curse: o.curse !== false, buy: !!o.buy };
};
AT.effectiveAutoRemedy = function (s, g) {
  return AT.sanitizeAutoRemedy((s && s.autoRemedy) || (g || AT.DEFAULT_GENERAL_SETTINGS).autoRemedy);
};
AT.describeAutoRemedy = function (c) {
  if (!c.enabled) return "desligado";
  const w = [c.siren ? "Sereia" : null, c.curse ? "Maldição" : null].filter(Boolean);
  return w.length ? `ligado: ${w.join(" e ")}${c.buy ? ", compra se não tiver" : ""}` : "ligado, nenhum efeito marcado";
};

// ---------------------------------------------------------------------------
// Backup das configuracoes (exportar/importar)
// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Aviso de versao nova: le as tags do repositorio do projeto no GitHub.
// Vazio = aviso desligado (o repositorio ainda nao foi criado).
// ---------------------------------------------------------------------------
AT.UPDATE_REPO = "Lucyfer-chan/Auto-Twish"; // "dono/repositorio"
AT.UPDATE_CHECK_HOURS = 6;
// "v 1.0.4", "v1.0.4", "1.0.4" -> [1, 0, 4]; null se nao for uma versao.
AT.parseVersion = function (s) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(s || ""));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};
AT.compareVersions = function (a, b) {
  for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  return 0;
};

AT.BACKUP_APP = "auto-twish-backup";
AT.BACKUP_FORMAT = 1;
// Campos de execucao dos canais (nao vao no backup e nao sao sobrescritos).
AT.CHANNEL_RUNTIME_KEYS = ["awaitingUser", "twishAvailableAt", "twishLastSeen", "lastSentAt", "nextFireAt"];

// Preco com desconto, igual ao site: arredonda o meio para o par.
AT.discountedPrice = function (cost, rate) {
  if (!rate) return cost;
  const s = cost * (1 - rate);
  const r = Math.floor(s);
  const f = s - r;
  const c = f > 0.5 ? r + 1 : f < 0.5 || r % 2 === 0 ? r : r + 1;
  return Math.max(0, c);
};

// ---------------------------------------------------------------------------
// Isca e reforcos por evento / Torneio / Isca do duelo
// ---------------------------------------------------------------------------
AT.KIT_EVENTS = ["double_xp", "cooldown_multiplier", "tier_catch_boost"];
AT.KIT_EVENT_LABELS = { double_xp: "XP em Dobro", cooldown_multiplier: "Maré Turbo", tier_catch_boost: "Sorte Rara" };
AT.TURBO_ITEM = "turbo"; // Turbo de Pesca (Impulso): 5 min, CD de 20 s
AT.SHARPEN_ITEM = "afiacao_anzol"; // Afiacao de Anzol (Cuidado): +5% pontos/XP por 30 min
AT.TOURNAMENT_TURBO_ITEM = "turbo_torneio"; // Turbo Torneio (Impulso): CD de 10 s por 3 min, um por torneio
AT.GREASE_ITEM = "graxa_molinete"; // Graxa de Molinete (Cuidado): peixe 5% mais pesado por 20 lancadas
AT.BAIT_COMMAND = "$isca";
AT.UNEQUIP_BAIT_COMMAND = "$desequiparisca";
AT.JOIN_TOURNAMENT_COMMAND = "$entrar";
AT.FLEET_BOARD_COMMAND = "$embarcar"; // Frota do Capitao

AT.cleanItemId = function (v) {
  const t = typeof v === "string" ? v.trim().toLowerCase() : "";
  return AT.FISH_ID_RE.test(t) ? t : null;
};
AT.sanitizeKitEntry = function (x) {
  const o = x && typeof x === "object" ? x : {};
  return {
    enabled: !!o.enabled,
    baitId: AT.cleanItemId(o.baitId), // null = nao mexe na isca
    turbo: !!o.turbo,
    turboBuy: !!o.turboBuy,
    sharpen: !!o.sharpen,
    sharpenBuy: !!o.sharpenBuy,
    baitBuy: !!o.baitBuy, // comprar a isca ($comprar <isca> <qtd>) se nao tiver
    baitBuyQty: AT.clampInt(o.baitBuyQty, 1, 200, 10)
  };
};
// Alerta sonoro: tres bipes curtos num AudioContext (fundo do Firefox ou offscreen do Chrome).
AT.playBeeps = function (ctx) {
  if (ctx.state === "suspended") ctx.resume().catch(() => {});
  const t0 = ctx.currentTime + 0.05;
  for (let i = 0; i < 3; i++) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = i === 2 ? 1175 : 880;
    const t = t0 + i * 0.32;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.25);
    o.connect(g).connect(ctx.destination);
    o.start(t);
    o.stop(t + 0.27);
  }
  setTimeout(() => ctx.close().catch(() => {}), 1500);
};
AT.sanitizeVerifyAlert = function (x) {
  const o = x && typeof x === "object" ? x : {};
  return { openWindow: !!o.openWindow, sound: !!o.sound };
};
// Sorte Rara: uma regra (isca + reforcos) por raridade sorteada.
// { enabled, tiers: { uncommon: entrada, rare: entrada, ... } }
AT.LUCK_KIND = "tier_catch_boost";
AT.LUCK_TIERS = ["uncommon", "rare", "legendary", "mythic", "secret", "divine"];
AT.sanitizeLuckKit = function (x) {
  const o = x && typeof x === "object" ? x : {};
  const hasTiers = o.tiers && typeof o.tiers === "object";
  // Formato antigo (uma regra so para a Sorte Rara): vale para todas as raridades.
  const legacy = !hasTiers && (o.baitId || o.turbo || o.sharpen) ? { ...o, enabled: true } : null;
  const tiers = {};
  for (const t of AT.LUCK_TIERS) tiers[t] = AT.sanitizeKitEntry(hasTiers ? o.tiers[t] : legacy);
  return { enabled: !!o.enabled, tiers };
};
AT.sanitizeEventKit = function (x) {
  const o = x && typeof x === "object" ? x : {};
  const out = {};
  for (const k of AT.KIT_EVENTS) out[k] = k === AT.LUCK_KIND ? AT.sanitizeLuckKit(o[k]) : AT.sanitizeKitEntry(o[k]);
  return out;
};
// Raridades sorteadas num evento Sorte Rara (ids), da mais rara para a mais comum.
AT.eventTiers = function (e) {
  const ids = new Set();
  const byLabel = Object.fromEntries(Object.entries(AT.TIER_LABELS).map(([id, l]) => [l.toLowerCase(), id]));
  for (const t of Array.isArray(e && e.tiers) ? e.tiers : []) {
    const v = typeof t === "string" ? t : t && (t.id || t.tier);
    if (AT.tierRank(v) >= 0) ids.add(v);
    else if (typeof v === "string" && byLabel[v.toLowerCase()]) ids.add(byLabel[v.toLowerCase()]);
  }
  for (const l of Array.isArray(e && e.tier_labels) ? e.tier_labels : []) {
    const id = typeof l === "string" && byLabel[l.toLowerCase()];
    if (id) ids.add(id);
  }
  if (!ids.size && e && typeof e.message === "string") {
    const m = /peixe\s+([^\s]+)\s+em dobro/i.exec(e.message);
    const id = m && byLabel[m[1].toLowerCase()];
    if (id) ids.add(id);
  }
  return [...ids].sort((a, b) => AT.tierRank(b) - AT.tierRank(a));
};
// Regra que vale para um evento: { entry, tier } ou null.
AT.kitEntryForEvent = function (kit, e) {
  if (!e || !AT.KIT_EVENTS.includes(e.kind)) return null;
  const k = kit[e.kind];
  if (e.kind !== AT.LUCK_KIND) return AT.kitIsActive(k) ? { entry: k, tier: null } : null;
  if (!k || !k.enabled) return null;
  for (const t of AT.eventTiers(e)) if (AT.kitIsActive(k.tiers[t])) return { entry: k.tiers[t], tier: t };
  return null;
};
// Regra guardada no contexto do evento (kind + raridade).
AT.kitEntryOf = function (kit, kind, tier) {
  const k = kit[kind];
  if (kind !== AT.LUCK_KIND) return k;
  return k && k.enabled && tier ? k.tiers[tier] : null;
};
AT.sanitizeTournament = function (x) {
  const o = x && typeof x === "object" ? x : {};
  return {
    join: !!o.join, // entrar sozinho ($entrar)
    rule: AT.TOURNEY_RULES.includes(o.rule) ? o.rule : "fishFirst",
    minSeconds: legacyMinSeconds(o, 150),
    baitId: AT.cleanItemId(o.baitId),
    boost: !!o.boost, // ativar Turbo Torneio (Impulso; um por torneio)
    boostBuy: !!o.boostBuy,
    grease: !!o.grease, // ativar Graxa de Molinete (Cuidado; renova durante o torneio)
    greaseBuy: !!o.greaseBuy
  };
};
AT.sanitizeDuelBait = function (x) {
  const o = x && typeof x === "object" ? x : {};
  return { enabled: !!o.enabled, baitId: AT.cleanItemId(o.baitId) };
};
AT.effectiveEventKit = function (s, g) {
  return AT.sanitizeEventKit((s && s.eventKit) || (g || AT.DEFAULT_GENERAL_SETTINGS).eventKit);
};
AT.effectiveTournament = function (s, g) {
  return AT.sanitizeTournament((s && s.tournament) || (g || AT.DEFAULT_GENERAL_SETTINGS).tournament);
};
AT.effectiveDuelBait = function (s, g) {
  return AT.sanitizeDuelBait((s && s.duelBait) || (g || AT.DEFAULT_GENERAL_SETTINGS).duelBait);
};
AT.kitIsActive = function (e) {
  if (e && e.tiers) return !!(e.enabled && AT.LUCK_TIERS.some((t) => AT.kitIsActive(e.tiers[t])));
  return !!(e && e.enabled && (e.baitId || e.turbo || e.sharpen));
};
AT.tournamentIsActive = function (t) {
  return !!(t && (t.join || t.baitId || t.boost || t.grease));
};
AT.describeEventKit = function (kit) {
  const on = AT.KIT_EVENTS.filter((k) => AT.kitIsActive(kit[k])).map((k) => {
    if (k !== AT.LUCK_KIND) return AT.KIT_EVENT_LABELS[k];
    const ts = AT.LUCK_TIERS.filter((t) => AT.kitIsActive(kit[k].tiers[t])).map((t) => AT.TIER_LABELS[t]);
    return `${AT.KIT_EVENT_LABELS[k]} (${ts.join(", ")})`;
  });
  return on.length ? `ligado: ${on.join(", ")}` : "desligado";
};
AT.describeTournament = function (t) {
  const parts = [];
  if (t.join) parts.push(t.rule === "always" ? "entra sempre" : t.rule === "fishFirst" ? "entra (pesca antes se der)" : `entra se faltar ≥ ${AT.formatMinSec(t.minSeconds)}`);
  if (t.baitId) parts.push("isca");
  if (t.boost) parts.push("Turbo Torneio");
  if (t.grease) parts.push("Graxa");
  return parts.length ? `ligado: ${parts.join(", ")}` : "desligado";
};
AT.describeDuelBait = function (d) {
  return d.enabled && d.baitId ? "ligado" : "desligado";
};

AT.describeDuelAccept = function (cfg) {
  if (!cfg.enabled) return "desligado";
  if (cfg.rule === "always") return "ligado, sempre";
  return `ligado, se faltar ≥ ${AT.formatMinSec(cfg.minSeconds)}`;
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
    invDump: AT.sanitizeInvDump(g.invDump),
    autoBoard: AT.sanitizeAutoBoard(g.autoBoard),
    autoUpgrade: AT.sanitizeAutoUpgrade(g.autoUpgrade),
    autoFeatured: AT.sanitizeAutoFeatured(g.autoFeatured),
    autoRemedy: AT.sanitizeAutoRemedy(g.autoRemedy),
    randomChat: AT.sanitizeRandomChat(g.randomChat),
    protection: AT.sanitizeProtection(g.protection),
    shopList: AT.sanitizeShopList(g.shopList),
    eventKit: AT.sanitizeEventKit(g.eventKit),
    tournament: AT.sanitizeTournament(g.tournament),
    duelBait: AT.sanitizeDuelBait(g.duelBait),
    verifyAlert: AT.sanitizeVerifyAlert(g.verifyAlert),
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
  // notifyBigEvents: notificacao de Grande Evento (Invasao Pirata, Cthulhu...).
  // Fora dos padroes de proposito: sem valor salvo, segue notifyEvents (antes
  // da 1.0.4 os dois avisos eram uma opcao so). Ver AT.notifiesBigEvents.
  duelAccept: null, // null = usa o valor geral; objeto = excecao deste canal
  turboSell: null, // idem
  invDump: null, // idem
  autoBoard: null, // idem
  autoUpgrade: null, // idem
  autoFeatured: null, // idem
  autoRemedy: null, // idem
  randomChat: null, // idem
  protection: null, // idem
  shopList: null, // idem
  eventKit: null, // idem
  tournament: null, // idem
  duelBait: null, // idem
  twishAvailableAt: null, // ultimo horario real de disponibilidade lido do Twish
  twishLastSeen: null, // quando essa leitura foi feita (gravado no maximo 1x/min durante o mesmo cooldown)
  lastSentAt: null, // ultimo envio local bem-sucedido
  nextFireAt: null // timestamp (ms) da proxima tentativa; null = sem agendamento
};

AT.notifiesBigEvents = function (s) {
  if (!s) return false;
  return typeof s.notifyBigEvents === "boolean" ? s.notifyBigEvents : !!s.notifyEvents;
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

// Nome do navegador para os textos da interface. So o Firefox tem
// runtime.getBrowserInfo; no Chrome (e derivados) o `browser` e o `chrome`.
AT.browserName = function () {
  try {
    if (typeof browser !== "undefined" && browser.runtime && typeof browser.runtime.getBrowserInfo === "function") return "Firefox";
  } catch (e) {}
  return "Chrome";
};

// Mares da Expedicao (id da API -> nome no site).
AT.EXPEDITION_SEAS = {
  baia: "Baía das Lendas",
  sereias: "Mar das Sereias",
  abismo: "Abismo dos Deuses",
  fenda: "Fenda do Fim"
};
AT.EXPEDITION_SEA_IDS = Object.keys(AT.EXPEDITION_SEAS);
// Seguro de cada mar (gasto sozinho ao zarpar, se estiver no inventario do barco).
AT.EXPEDITION_INSURANCE = { sereias: "seguro_sereias", abismo: "seguro_abismo" };
// Nome do mar (como o bot escreve) -> id.
AT.expeditionSeaId = function (name) {
  const norm = (x) => String(x || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim();
  return AT.EXPEDITION_SEA_IDS.find((id) => norm(AT.EXPEDITION_SEAS[id]) === norm(name)) || null;
};

// Embarque automatico: { enabled, seas: { baia: { enabled, buy }, ... } }.
// buy = comprar o ticket pelo chat se nao tiver (a Fenda pede Fragmentos, que nao se compram).
AT.sanitizeAutoBoard = function (x) {
  const o = x && typeof x === "object" ? x : {};
  const seas = {};
  for (const id of AT.EXPEDITION_SEA_IDS) {
    const e = o.seas && typeof o.seas[id] === "object" && o.seas[id] ? o.seas[id] : {};
    seas[id] = { enabled: e.enabled !== false, buy: id !== "fenda" && !!e.buy, insure: !!AT.EXPEDITION_INSURANCE[id] && !!e.insure };
  }
  // immediate: entra na sala na hora, sem esperar pescar antes.
  // fleet: embarcar na Frota do Capitao ($embarcar no chat; viagem de graca).
  return { enabled: !!o.enabled, immediate: !!o.immediate, fleet: !!o.fleet, seas };
};
AT.effectiveAutoBoard = function (s, g) {
  return AT.sanitizeAutoBoard((s && s.autoBoard) || (g || AT.DEFAULT_GENERAL_SETTINGS).autoBoard);
};
AT.describeAutoBoard = function (c) {
  if (!c.enabled) return "desligado";
  const on = AT.EXPEDITION_SEA_IDS.filter((id) => c.seas[id].enabled).map((id) => AT.EXPEDITION_SEAS[id]);
  if (c.fleet) on.push("Frota do Capitão");
  return on.length ? `ligado${c.immediate ? " (imediato)" : ""}: ${on.join(", ")}` : "ligado, nenhum mar marcado";
};

// "mm:ss" (sem milissegundos).
AT.formatRemaining = function (ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return String(Math.floor(total / 60)).padStart(2, "0") + ":" + String(total % 60).padStart(2, "0");
};
