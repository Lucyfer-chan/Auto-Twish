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
  const active = market.enabled && list.some((e) => e.enabled && AT.isValidAcquisition(e) && remainingOf(e) > 0);
  if (!active) {
    await browser.alarms.clear(AT.MARKET_ALARM_NAME);
    return;
  }
  const base = AT.clampMarketInterval(market.intervalSeconds) * 1000;
  const delay = soon ? 2000 : base * (0.75 + Math.random() * 0.5);
  await browser.alarms.create(AT.MARKET_ALARM_NAME, { when: Date.now() + delay });
}


// Quantos ainda faltam comprar deste item (Infinity = sem limite).
function remainingOf(e) {
  if (e.quantity === null || e.quantity === undefined) return Infinity;
  return Math.max(0, e.quantity - (e.bought || 0));
}

// Soma uma compra no contador do item (gravado na propria lista). Compras
// retidas pra analise tambem contam (as moedas ja ficam reservadas), e sao
// contadas a parte em "held".
async function addBought(entryId, held = false) {
  const list = await getAcquisitionList();
  const e = list.find((x) => x.id === entryId);
  if (!e) return;
  e.bought = (e.bought || 0) + 1;
  if (held) e.held = (e.held || 0) + 1;
  await browser.storage.local.set({ acquisitionList: list });
}

// Desliga a aquisicao (usado quando uma compra e retida pra analise).
async function pauseMarket() {
  await mutateGeneral((g) => {
    g.market = { ...g.market, enabled: false };
  });
  await browser.alarms.clear(AT.MARKET_ALARM_NAME);
}

// Saldo de twishcoins no barco das compras (pela conta). null = desconhecido.
async function marketBalance(boat) {
  const me = await fetchTwishMe(boat);
  const coins = me && me.data && me.data.twishcoins;
  return typeof coins === "number" ? coins : null;
}

async function notifyOutOfCoins(balance) {
  const st = await getMarketState();
  if (st.outOfCoins) return; // ja avisou nesta sequencia
  await updateMarketState((s) => {
    s.outOfCoins = true;
  });
  try {
    await browser.notifications.create("market-coins", {
      type: "basic",
      title: "Auto Twish — Mercado",
      message: `Moedas insuficientes para os anúncios encontrados${balance !== null ? ` (saldo: ${balance})` : ""}. As compras voltam quando houver saldo.`
    });
  } catch (e) {}
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

    const all = await getAcquisitionList();
    const list = all.filter((e) => e.enabled && AT.isValidAcquisition(e) && remainingOf(e) > 0);
    if (!list.length) {
      const done = all.some((e) => e.enabled && AT.isValidAcquisition(e) && remainingOf(e) <= 0);
      msg = done ? "Todos os peixes ativos já atingiram a quantidade pedida." : "Lista de aquisição vazia ou sem itens ativos.";
      return;
    }

    const best = await getBestiary(boat);
    const me = (general.twishLogin || "").toLowerCase();

    // Candidatos por item, ja limitados ao que falta comprar dele.
    const candidates = [];
    for (const entry of list) {
      const species = best.byId[entry.fishId];
      if (!species) continue;
      const listings = await fetchListings(boat, species, entry.maxPrice);
      const mine = [];
      for (const l of listings || []) {
        if (l.fish_id !== entry.fishId || l.item_id) continue;
        if (me && String(l.seller || "").toLowerCase() === me) continue; // anuncio do proprio jogador
        const pct = AT.marketPct(l.weight, species.max_kg);
        if (AT.shouldBuy(entry, { weight: l.weight, pct, price: l.asking_price })) mine.push({ entry, l, pct, species });
      }
      mine.sort((a, b) => a.l.asking_price - b.l.asking_price || b.pct - a.pct);
      candidates.push(...mine.slice(0, remainingOf(entry) === Infinity ? mine.length : remainingOf(entry)));
      await sleepMs(300 + Math.random() * 500); // espaca as consultas
    }

    if (!candidates.length) {
      msg = `${dryRun ? "Simulação: n" : "N"}ada dentro dos critérios (${list.length} ${list.length === 1 ? "peixe" : "peixes"} na lista).`;
      return;
    }

    // Do mais barato pro mais caro (empate -> maior %).
    candidates.sort((a, b) => a.l.asking_price - b.l.asking_price || b.pct - a.pct);
    let balance = await marketBalance(boat);

    if (dryRun) {
      let money = balance;
      const would = [];
      for (const c of candidates) {
        if (money !== null && c.l.asking_price > money) continue;
        would.push(c);
        if (money !== null) money -= c.l.asking_price;
      }
      const total = would.reduce((s, c) => s + c.l.asking_price, 0);
      msg =
        `Simulação (aquisição desligada): ${candidates.length} anúncio(s) dentro dos critérios; ` +
        (would.length
          ? `compraria ${would.length} por ${total} no total — ${would.slice(0, 5).map((c) => `${c.species.name} ${c.l.weight} kg (${c.pct}%) por ${c.l.asking_price}`).join("; ")}${would.length > 5 ? "; …" : ""}`
          : "nenhum cabe no saldo") +
        (balance !== null ? `. Saldo: ${balance}.` : ".");
      return;
    }

    // Compra um por um, ate completar as quantidades ou acabar o saldo.
    const left = new Map(list.map((e) => [e.id, remainingOf(e)]));
    const bought = [];
    let skippedForCoins = 0;
    let heldCount = 0;
    let stopReason = "";
    for (const c of candidates) {
      if ((left.get(c.entry.id) || 0) <= 0) continue;
      if (balance !== null && c.l.asking_price > balance) {
        skippedForCoins++;
        continue;
      }
      await readSafetyLock();
      if (safetyLocked) {
        stopReason = "verificação pendente";
        break;
      }

      const res = await twishApi(`/api/${encodeURIComponent(boat)}/market/listings/${encodeURIComponent(c.l.id)}/buy`, {
        method: "POST",
        body: {}
      });

      if (res.ok) {
        // O site pode reter a compra pra analise da administracao
        // (resposta { status: "held" }): moedas reservadas, peixe so chega
        // se for aprovada.
        const held = !!(res.data && res.data.status === "held");
        left.set(c.entry.id, left.get(c.entry.id) - 1);
        if (balance !== null) balance -= c.l.asking_price;
        await addBought(c.entry.id, held);
        const purchase = { at: Date.now(), fish: c.species.name, weight: c.l.weight, pct: c.pct, price: c.l.asking_price, seller: c.l.seller, held };
        await updateMarketState((st) => {
          st.purchases = [purchase, ...(st.purchases || [])].slice(0, MAX_RECENT_PURCHASES);
          st.outOfCoins = false;
        });
        if (held) {
          heldCount++;
          console.warn(`${AT.LOG_PREFIX} Mercado: compra de ${c.species.name} por ${c.l.asking_price} RETIDA para análise.`);
          logActivity(boat, "mercado", `Compra de ${c.species.name} por ${c.l.asking_price} RETIDA para análise; aquisição desligada.`);
          stopReason = "compra retida para análise da administração — aquisição desligada";
          await pauseMarket();
          try {
            await browser.notifications.create("market-held", {
              type: "basic",
              title: "Auto Twish — compra em análise",
              message: `O Twish reteve a compra de ${c.species.name} (${c.l.asking_price} moedas reservadas) para análise da administração. A aquisição automática foi desligada; religue nas configurações quando quiser.`
            });
          } catch (e) {}
          break;
        }
        bought.push(c);
        console.log(`${AT.LOG_PREFIX} Mercado: comprou ${c.species.name} ${c.l.weight} kg (${c.pct}%) por ${c.l.asking_price}.`);
        logActivity(boat, "mercado", `Comprei ${c.species.name} ${c.l.weight} kg (${c.pct}%) por ${c.l.asking_price}.`);
      } else {
        const err = String((res.data && (res.data.error || res.data.message)) || `erro ${res.status || "de rede"}`);
        if (/saldo|insuficiente|insufficient|not_enough|coins/i.test(err)) {
          stopReason = "moedas acabaram";
          await notifyOutOfCoins(balance);
          break;
        }
        if (/blocked|automa|challenge|verifica/i.test(err)) {
          await checkChallenge("mercado");
          stopReason = "verificação";
          break;
        }
        if (res.status === 401) {
          stopReason = "sem login no twish.com.br";
          break;
        }
        // Anuncio ja vendido/removido etc.: segue pro proximo.
        console.warn(`${AT.LOG_PREFIX} Mercado: não comprou ${c.species.name} (${err}).`);
      }
      await sleepMs(800 + Math.random() * 1200); // pausa curta entre compras
    }

    if (bought.length && general.market.notifyPurchases) {
      const total = bought.reduce((s, c) => s + c.l.asking_price, 0);
      try {
        await browser.notifications.create(`market-buy:${Date.now()}`, {
          type: "basic",
          title: "Auto Twish — compras no Mercado",
          message: `${bought.length} peixe(s) por ${total} no total: ${bought.slice(0, 4).map((c) => `${c.species.name} ${c.l.weight} kg`).join(", ")}${bought.length > 4 ? "…" : ""}`
        });
      } catch (e) {}
    }
    if (skippedForCoins && !stopReason) await notifyOutOfCoins(balance);

    const total = bought.reduce((s, c) => s + c.l.asking_price, 0);
    msg =
      (bought.length ? `Comprou ${bought.length} peixe(s) por ${total} no total.` : heldCount ? "" : "Nenhuma compra nesta verificação.") +
      (heldCount ? ` ${heldCount} compra(s) RETIDA(S) para análise (moedas reservadas).` : "") +
      (skippedForCoins ? ` ${skippedForCoins} anúncio(s) acima do saldo.` : "") +
      (stopReason ? ` Parou: ${stopReason}.` : "") +
      (balance !== null ? ` Saldo: ${balance}.` : "");
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
    // Quantidade a comprar: inteiro >= 1, ou null = sem limite (ate acabar o saldo).
    quantity: (() => {
      const q = parseInt(e.quantity, 10);
      return Number.isFinite(q) && q >= 1 ? q : null;
    })(),
    bought: Math.max(0, parseInt(e.bought, 10) || 0),
    held: Math.max(0, parseInt(e.held, 10) || 0),
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
