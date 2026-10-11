// shop.js — Lista de Compras no Desconto na Loja (Road Map item 3).
//
// Quando o evento "Desconto na Loja" (kind store_discount) aparece num canal,
// compra pelo chat ($comprar <id> [qtd]) os itens da lista, na ordem da
// lista (prioridade). Se as moedas nao dao para um item, passa para o
// proximo. Nunca deixa o saldo abaixo da reserva. Uma vez por evento.
//
// O saldo e por barco: lido de /api/{canal}/me (twishcoins). Sem leitura da
// conta, nao compra (nao da pra saber o saldo nem confirmar a compra).
//
// Modos de cada item:
//   once      — compra unica: compra ate somar a quantidade (no total) e para
//   recurring — compra a quantidade em cada Desconto na Loja
//   unlimited — compra o maximo possivel em cada Desconto na Loja
//
// Estado por canal em gameState[canal].shop:
//   { bought: { <key>: n }   (total dos itens "once")
//     eventEndsAt, eventBought: { <key>: n }   (do desconto atual)
//     doneEndsAt, lastRunAt, lastMsg, purchases: [...] }

const SHOP_ALARM_PREFIX = "auto-twish-shop:";
const SHOP_CATALOG_TTL_MS = 60 * 60 * 1000;
const SHOP_CONFIRM_DELAY_MS = 3000; // espera o bot registrar a compra antes de reler o saldo
const SHOP_SAME_EVENT_MS = 3 * 60 * 1000;
const shoppingNow = new Set();
let shopCatalogCache = { channel: null, at: 0, data: null };

function shopDiscountEvent(ev) {
  const e = ev && ev.event;
  if (!e || e.kind !== "store_discount") return null;
  const rate = Number(e.store_discount ?? e.value);
  return rate > 0 && rate < 1 ? { ...e, rate } : null;
}

// Loja publica do canal: { discount_rate, rods: [...], baits: [...], ... }
async function fetchShop(channel, fresh) {
  if (!fresh && shopCatalogCache.channel === channel && Date.now() - shopCatalogCache.at < SHOP_CATALOG_TTL_MS) {
    return shopCatalogCache.data;
  }
  try {
    const r = await fetch(`https://twish.com.br/api/${encodeURIComponent(channel)}/shop`, { cache: "no-store" });
    if (!r.ok) return null;
    const data = await r.json();
    shopCatalogCache = { channel, at: Date.now(), data };
    return data;
  } catch (e) {
    return null;
  }
}

// Lista plana: [{ id, name, category, cost, single, requires, pricesByRod }]
function shopCatalogList(shop) {
  const out = [];
  if (!shop) return out;
  for (const cat of AT.SHOP_CATEGORIES) {
    for (const i of shop[cat] || []) {
      if (!i || !i.id || i.tournament_only) continue; // Turbo Torneio: so dentro do torneio
      if (!(Number(i.cost) > 0) && !i.prices_by_rod) continue; // gratis (vara inicial)
      out.push({
        id: i.id,
        name: i.name || i.id,
        category: cat,
        cost: Number(i.cost) || 0,
        single: AT.SHOP_SINGLE_CATEGORIES.includes(cat),
        requires: i.requires_rod_id || i.requires_hook_id || i.requires_backpack_id || null,
        pricesByRod: i.prices_by_rod || null
      });
    }
  }
  return out;
}

async function shopListConfigFor(channel) {
  const general = await getGeneralSettings();
  const s = (await getAllChannelSettings())[channel] || null;
  return AT.effectiveShopList(s, general);
}

// Agenda a compra quando o desconto aparece (5 a 20 s depois, uma vez por evento).
async function scheduleShopping(channel, ev) {
  const alarmName = `${SHOP_ALARM_PREFIX}${channel}`;
  const cfg = await shopListConfigFor(channel);
  const disc = shopDiscountEvent(ev);
  if (!cfg.enabled || !cfg.items.some((i) => i.enabled) || !disc) {
    await browser.alarms.clear(alarmName);
    return null;
  }
  const endsAt = (ev.fetchedAt || Date.now()) + Number(disc.seconds_remaining) * 1000;
  if (endsAt - Date.now() < 15000) return null; // acabando: nao da tempo
  const { gameState } = await browser.storage.local.get("gameState");
  const st = ((gameState || {})[channel] || {}).shop || {};
  if (st.doneEndsAt && Math.abs(st.doneEndsAt - endsAt) < SHOP_SAME_EVENT_MS) return null; // ja comprou neste desconto
  if (await browser.alarms.get(alarmName)) return null; // ja agendado
  const when = Date.now() + 5000 + Math.random() * 15000;
  await browser.alarms.create(alarmName, { when });
  console.log(`${AT.LOG_PREFIX} Desconto na Loja (${Math.round(disc.rate * 100)}%) em "${channel}": Lista de Compras as ${new Date(when).toLocaleTimeString()}.`);
  return when;
}

async function saveShopStatus(channel, fn) {
  await mutateGameState(channel, (st) => {
    st.shop = st.shop || {};
    fn(st.shop);
  });
}

async function readBalance(channel) {
  const me = await fetchTwishMe(channel);
  if (!me) return null;
  const d = me.data;
  const coins = Number(d.twishcoins);
  if (!Number.isFinite(coins)) return null;
  return { coins, rodId: d.equipment && d.equipment.rod_id, backpackId: d.equipment && d.equipment.backpack_id, owned: d.owned || {} };
}

function ownsItem(entry, acc) {
  if (entry.category === "rods") return (acc.owned.rod_ids || []).includes(entry.id) || acc.rodId === entry.id;
  if (entry.category === "hooks") return (acc.owned.hook_ids || []).includes(entry.id);
  if (entry.category === "backpacks") return acc.backpackId === entry.id;
  return false;
}
function ownsRequirement(entry, acc) {
  if (!entry.requires) return true;
  return (
    (acc.owned.rod_ids || []).includes(entry.requires) ||
    (acc.owned.hook_ids || []).includes(entry.requires) ||
    acc.rodId === entry.requires ||
    acc.backpackId === entry.requires
  );
}

async function runShopping(channel, source = "desconto") {
  if (shoppingNow.has(channel)) return null;
  shoppingNow.add(channel);
  const log = [];
  const purchases = [];
  try {
    const cfg = await shopListConfigFor(channel);
    if (!cfg.enabled) return null;
    const ev = await fetchActiveEvents(channel);
    const disc = shopDiscountEvent(ev);
    if (!disc) {
      await saveShopStatus(channel, (sh) => {
        sh.lastRunAt = Date.now();
        sh.lastMsg = "Sem Desconto na Loja ativo agora; nada comprado.";
      });
      return null;
    }
    const endsAt = ev.fetchedAt + Number(disc.seconds_remaining) * 1000;
    if (await checkChallenge("lista de compras")) return null;
    if ((await twitchTabsForChannel(channel)).length === 0) {
      await saveShopStatus(channel, (sh) => {
        sh.lastRunAt = Date.now();
        sh.lastMsg = "Desconto na Loja ativo, mas a aba do canal na Twitch está fechada.";
      });
      return null;
    }

    const shop = await fetchShop(channel, true);
    const catalog = new Map(shopCatalogList(shop).map((e) => [e.id, e]));
    let acc = await readBalance(channel);
    if (!acc) {
      await saveShopStatus(channel, (sh) => {
        sh.lastRunAt = Date.now();
        sh.lastMsg = "Sem leitura da conta (logado no twish.com.br?): sem saldo, nada comprado.";
      });
      return null;
    }

    const { gameState } = await browser.storage.local.get("gameState");
    const prev = ((gameState || {})[channel] || {}).shop || {};
    const bought = { ...(prev.bought || {}) };
    const sameEvent = prev.eventEndsAt && Math.abs(prev.eventEndsAt - endsAt) < SHOP_SAME_EVENT_MS;
    const eventBought = sameEvent ? { ...(prev.eventBought || {}) } : {};

    for (const it of cfg.items) {
      if (!it.enabled) continue;
      const entry = catalog.get(it.itemId);
      if (!entry) {
        log.push(`${it.name}: não está na loja`);
        continue;
      }
      let remaining;
      if (it.mode === "once") remaining = it.quantity - (bought[it.key] || 0);
      else if (it.mode === "recurring") remaining = it.quantity - (eventBought[it.key] || 0);
      else remaining = AT.SHOP_MAX_QTY;
      if (entry.single) {
        if (ownsItem(entry, acc)) {
          if (it.mode === "once") bought[it.key] = it.quantity;
          log.push(`${it.name}: já tem`);
          continue;
        }
        if (!ownsRequirement(entry, acc)) {
          log.push(`${it.name}: precisa antes de ${entry.requires}`);
          continue;
        }
        remaining = Math.min(remaining, 1);
      }
      if (remaining <= 0) continue;

      const base = entry.pricesByRod ? Number(entry.pricesByRod[acc.rodId] ?? entry.cost) : entry.cost;
      const price = AT.discountedPrice(base, disc.rate);
      if (!(price > 0)) continue;
      const spendable = acc.coins - cfg.reserve;
      const qty = Math.min(remaining, Math.floor(spendable / price));
      if (qty < 1) {
        log.push(`${it.name}: moedas insuficientes (${price} cada)`);
        continue; // passa para o proximo da lista
      }

      const text = qty > 1 ? `${AT.BUY_COMMAND} ${it.itemId} ${qty}` : `${AT.BUY_COMMAND} ${it.itemId}`;
      const r = await enqueueCommand(channel, text, { reason: `Lista de Compras (${Math.round(disc.rate * 100)}% off)` });
      if (!r.ok) {
        log.push(`${it.name}: falha ao enviar (${r.reason})`);
        break; // aba/chat com problema: para por aqui
      }
      await sleep(SHOP_CONFIRM_DELAY_MS);
      const after = await readBalance(channel);
      const spent = after ? acc.coins - after.coins : null;
      let got = 0;
      if (spent === null) got = qty; // sem releitura: considera enviado
      else if (spent > 0) got = Math.min(qty, Math.max(1, Math.round(spent / price)));
      if (got > 0) {
        if (it.mode === "once") bought[it.key] = (bought[it.key] || 0) + got;
        if (it.mode === "recurring") eventBought[it.key] = (eventBought[it.key] || 0) + got;
        purchases.push({ at: Date.now(), name: it.name, qty: got, price });
        log.push(`${it.name}: comprou ${got} × ${price}`);
      } else {
        log.push(`${it.name}: o jogo não confirmou a compra`);
      }
      if (after) acc = after;
      else acc = { ...acc, coins: acc.coins - got * price };
    }

    const msg = log.length ? log.join(" · ") : "Nada a comprar neste desconto.";
    await saveShopStatus(channel, (sh) => {
      sh.bought = bought;
      sh.eventEndsAt = endsAt;
      sh.eventBought = eventBought;
      sh.doneEndsAt = endsAt;
      sh.lastRunAt = Date.now();
      sh.lastMsg = `${Math.round(disc.rate * 100)}% off — ${msg} · saldo ${acc.coins}`;
      sh.purchases = [...purchases, ...(sh.purchases || [])].slice(0, 20);
    });
    console.log(`${AT.LOG_PREFIX} (${source}) Lista de Compras em "${channel}": ${msg}`);
    if (purchases.length) {
      await notifyAutomation(
        `shop-auto:${channel}`,
        `🏷️ Lista de Compras em ${channel}`,
        purchases.map((p) => `${p.qty}× ${p.name}`).join(", ") + ` — saldo ${acc.coins}.`
      );
    }
    return { purchases, msg };
  } finally {
    shoppingNow.delete(channel);
  }
}

// Ligar/mudar a lista: agenda na hora se ja houver desconto rolando.
async function reevaluateShopping(only) {
  await updateEventsPoller();
  const channels = await getAllChannelSettings();
  for (const channel of Object.keys(channels)) {
    if (only && channel !== only) continue;
    const ev = await refreshEvents(channel, false); // chama scheduleShopping
    if (!ev) {
      const { gameState } = await browser.storage.local.get("gameState");
      await scheduleShopping(channel, ((gameState || {})[channel] || {}).events || null);
    }
  }
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith(SHOP_ALARM_PREFIX)) runShopping(alarm.name.slice(SHOP_ALARM_PREFIX.length));
});

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Configuracoes: catalogo da loja (itens que entram no desconto).
  if (msg?.type === "GET_SHOP_CATALOG") {
    (async () => {
      const channel = msg.channel || Object.keys(await getAllChannelSettings()).sort()[0];
      if (!channel) return sendResponse({ list: [] });
      sendResponse({ list: shopCatalogList(await fetchShop(channel, false)) });
    })();
    return true;
  }
  return false;
});
