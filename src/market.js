// market.js — Mercado: Aquisicao automatica (Road Map item 6).
// Carregado depois do background.js (usa twishApi, getGeneralSettings,
// mutateGeneral, getAllChannelSettings, readSafetyLock, checkChallenge).
//
// Em vez de abrir a pagina do mercado e clicar (como a extensao antiga),
// consulta a lista publica de anuncios pela API, filtra pela Lista de
// Aquisicao e compra pela mesma rota que o site usa, com o login do jogador.
// Um ciclo a cada "intervalo" escolhido (+-25% aleatorio); no maximo uma
// compra por ciclo. Desativada por padrao.

const MARKET_PAGE_SIZE = 50;
const BESTIARY_TTL_MS = 60 * 60 * 1000;
const MAX_RECENT_PURCHASES = 20;

let bestiaryCache = { boat: null, at: 0, byId: {}, list: [] };
let marketRunning = false;

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

async function getAcquisitionList() {
  const { acquisitionList } = await browser.storage.local.get("acquisitionList");
  return Array.isArray(acquisitionList) ? acquisitionList : [];
}

async function getMarketState() {
  const { marketState } = await browser.storage.local.get("marketState");
  return marketState || { cycles: 0, lastRunAt: null, lastMsg: "", purchases: [] };
}

async function updateMarketState(fn) {
  const st = await getMarketState();
  fn(st);
  await browser.storage.local.set({ marketState: st });
  return st;
}

// Barco (canal) usado nas compras: o escolhido, ou o primeiro configurado.
async function marketBoat() {
  const { market } = await getGeneralSettings();
  if (market.boat) return market.boat;
  const names = Object.keys(await getAllChannelSettings()).sort();
  return names[0] || null;
}

// Especies (peso minimo/maximo) — publico, cache de 1 h.
async function getBestiary(boat) {
  if (bestiaryCache.boat === boat && Date.now() - bestiaryCache.at < BESTIARY_TTL_MS && bestiaryCache.list.length) {
    return bestiaryCache;
  }
  try {
    const r = await fetch(`https://twish.com.br/api/${encodeURIComponent(boat)}/bestiary`, { cache: "no-store" });
    if (!r.ok) return bestiaryCache;
    const j = await r.json();
    const list = (Array.isArray(j) ? j : j.fish || j.species || []).map((f) => ({
      id: f.id,
      name: f.name,
      tier: f.tier,
      min_kg: f.min_kg,
      max_kg: f.max_kg,
      emoji: f.emoji
    }));
    bestiaryCache = { boat, at: Date.now(), byId: Object.fromEntries(list.map((f) => [f.id, f])), list };
  } catch (e) {
    // fica o cache anterior
  }
  return bestiaryCache;
}

// Anuncios de uma especie, ja filtrados pelo preco maximo (publico).
async function fetchListings(boat, species, maxPrice) {
  const qs = new URLSearchParams({ q: species.name, max_price: String(maxPrice), page_size: String(MARKET_PAGE_SIZE) });
  try {
    const r = await fetch(`https://twish.com.br/api/${encodeURIComponent(boat)}/market/listings?${qs}`, { cache: "no-store" });
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j.listings) ? j.listings : [];
  } catch (e) {
    return null;
  }
}

// Agenda (ou desliga) o proximo ciclo.
async function scheduleMarket({ soon = false } = {}) {
  const { market } = await getGeneralSettings();
  const list = await getAcquisitionList();
  const active = market.enabled && list.some((e) => e.enabled && AT.isValidAcquisition(e));
  if (!active) {
    await browser.alarms.clear(AT.MARKET_ALARM_NAME);
    return;
  }
  const base = AT.clampMarketInterval(market.intervalSeconds) * 1000;
  const delay = soon ? 2000 : base * (0.75 + Math.random() * 0.5);
  await browser.alarms.create(AT.MARKET_ALARM_NAME, { when: Date.now() + delay });
}

async function disableMarket(reason) {
  await mutateGeneral((g) => {
    g.market = { ...g.market, enabled: false };
  });
  await browser.alarms.clear(AT.MARKET_ALARM_NAME);
  await updateMarketState((st) => {
    st.lastMsg = reason;
  });
  try {
    await browser.notifications.create("market-off", { type: "basic", title: "Auto Twish — Mercado", message: reason });
  } catch (e) {}
  console.warn(`${AT.LOG_PREFIX} Mercado: ${reason}`);
}

async function marketCycle(source = "alarme") {
  if (marketRunning) return;
  marketRunning = true;
  let msg = "";
  try {
    const general = await getGeneralSettings();
    if (!general.market.enabled && source !== "manual") return;
    // "Verificar agora" com a aquisicao desligada: so simula (nao compra).
    const dryRun = !general.market.enabled;

    await readSafetyLock();
    if (safetyLocked) {
      msg = "Pausado: verificação pendente no Twish.";
      return;
    }

    const boat = await marketBoat();
    if (!boat) {
      msg = "Escolha um barco para as compras (nenhum canal configurado).";
      return;
    }

    const list = (await getAcquisitionList()).filter((e) => e.enabled && AT.isValidAcquisition(e));
    if (!list.length) {
      msg = "Lista de aquisição vazia ou sem itens ativos.";
      return;
    }

    const best = await getBestiary(boat);
    const me = (general.twishLogin || "").toLowerCase();
    const candidates = [];
    for (const entry of list) {
      const species = best.byId[entry.fishId];
      if (!species) continue;
      const listings = await fetchListings(boat, species, entry.maxPrice);
      if (listings) {
        for (const l of listings) {
          if (l.fish_id !== entry.fishId || l.item_id) continue;
          if (me && String(l.seller || "").toLowerCase() === me) continue; // anuncio do proprio jogador
          const pct = AT.marketPct(l.weight, species.max_kg);
          if (AT.shouldBuy(entry, { weight: l.weight, pct, price: l.asking_price })) candidates.push({ entry, l, pct, species });
        }
      }
      await sleepMs(300 + Math.random() * 500); // espaca as consultas
    }

    if (!candidates.length) {
      msg = `${dryRun ? "Simulação: n" : "N"}ada dentro dos critérios (${list.length} ${list.length === 1 ? "peixe" : "peixes"} na lista).`;
      return;
    }

    // Mais barato primeiro; empate -> maior %.
    candidates.sort((a, b) => a.l.asking_price - b.l.asking_price || b.pct - a.pct);
    const { l, pct, species } = candidates[0];
    if (dryRun) {
      msg = `Simulação (aquisição desligada): compraria ${species.name} ${l.weight} kg (${pct}%) por ${l.asking_price}` +
        (candidates.length > 1 ? ` — ${candidates.length} anúncios dentro dos critérios.` : ".");
      return;
    }
    const res = await twishApi(`/api/${encodeURIComponent(boat)}/market/listings/${encodeURIComponent(l.id)}/buy`, {
      method: "POST",
      body: {}
    });

    if (res.ok) {
      const purchase = { at: Date.now(), fish: species.name, weight: l.weight, pct, price: l.asking_price, seller: l.seller };
      await updateMarketState((st) => {
        st.purchases = [purchase, ...(st.purchases || [])].slice(0, MAX_RECENT_PURCHASES);
      });
      msg = `Comprou ${species.name} ${l.weight} kg (${pct}%) por ${l.asking_price}.`;
      console.log(`${AT.LOG_PREFIX} Mercado: ${msg}`);
      if (general.market.notifyPurchases) {
        try {
          await browser.notifications.create(`market-buy:${l.id}`, { type: "basic", title: "Auto Twish — compra no Mercado", message: msg });
        } catch (e) {}
      }
      return;
    }

    const err = String((res.data && (res.data.error || res.data.message)) || `erro ${res.status || "de rede"}`);
    if (/saldo|insuficiente|insufficient|not_enough|coins/i.test(err)) {
      await disableMarket(`Aquisição desativada: saldo insuficiente (${err}).`);
      msg = "";
      return;
    }
    if (/blocked|automa|challenge|verifica/i.test(err)) {
      await checkChallenge("mercado");
    }
    if (res.status === 401) {
      msg = "Não consegui comprar: você está logado no twish.com.br neste Firefox?";
      return;
    }
    msg = `Não comprou ${species.name} (${err}).`;
  } catch (e) {
    msg = `Erro no ciclo: ${e && e.message ? e.message : e}`;
    console.warn(`${AT.LOG_PREFIX} Mercado:`, e);
  } finally {
    if (msg) {
      await updateMarketState((st) => {
        st.cycles = (st.cycles || 0) + 1;
        st.lastRunAt = Date.now();
        st.lastMsg = msg;
      });
    }
    marketRunning = false;
    await scheduleMarket();
  }
}

// ---------------------------------------------------------------------------
// Mensagens da pagina de configuracoes
// ---------------------------------------------------------------------------
function sanitizeAcquisition(e) {
  const num = (v) => {
    const n = parseFloat(String(v ?? "").replace(",", "."));
    return Number.isFinite(n) && n >= 0 ? n : NaN;
  };
  return {
    id: String(e.id || `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`),
    fishId: String(e.fishId || ""),
    fishName: String(e.fishName || "").slice(0, 60),
    minKg: num(e.minKg),
    minPct: num(e.minPct),
    maxPrice: num(e.maxPrice),
    maxPriceBelow95: num(e.maxPriceBelow95),
    enabled: !!e.enabled
  };
}

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "GET_MARKET") {
    (async () => {
      const general = await getGeneralSettings();
      sendResponse({
        market: general.market,
        list: await getAcquisitionList(),
        state: await getMarketState(),
        boats: Object.keys(await getAllChannelSettings()).sort(),
        boat: await marketBoat()
      });
    })();
    return true;
  }

  if (msg?.type === "UPDATE_MARKET_SETTINGS") {
    (async () => {
      const p = msg.patch || {};
      await mutateGeneral((g) => {
        const m = { ...g.market };
        if ("enabled" in p) m.enabled = !!p.enabled;
        if ("intervalSeconds" in p) m.intervalSeconds = AT.clampMarketInterval(p.intervalSeconds);
        if ("boat" in p) m.boat = p.boat ? String(p.boat).toLowerCase() : null;
        if ("notifyPurchases" in p) m.notifyPurchases = !!p.notifyPurchases;
        g.market = m;
      });
      await scheduleMarket({ soon: p.enabled === true });
      sendResponse({ market: (await getGeneralSettings()).market });
    })();
    return true;
  }

  if (msg?.type === "SAVE_ACQUISITION_LIST") {
    (async () => {
      const list = (Array.isArray(msg.list) ? msg.list : []).slice(0, 50).map(sanitizeAcquisition);
      await browser.storage.local.set({ acquisitionList: list });
      await scheduleMarket();
      sendResponse({ list });
    })();
    return true;
  }

  if (msg?.type === "GET_BESTIARY") {
    (async () => {
      const boat = msg.boat || (await marketBoat());
      if (!boat) return sendResponse({ list: [] });
      const b = await getBestiary(boat);
      sendResponse({ list: b.list });
    })();
    return true;
  }

  if (msg?.type === "RUN_MARKET_NOW") {
    marketCycle("manual").then(async () => sendResponse({ state: await getMarketState() }));
    return true;
  }
});

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === AT.MARKET_ALARM_NAME) marketCycle("alarme");
});

// Ao carregar (instalacao, reinicio, background acordando): garante o agendamento.
browser.alarms.get(AT.MARKET_ALARM_NAME).then((a) => {
  if (!a) scheduleMarket();
});
