// upgrade.js — Aprimoramento Automatico: varas, mochilas e anzois.
//
// Compra pelo chat ($comprar <id>) o proximo item de cada cadeia da loja
// (requires_rod_id / requires_backpack_id / requires_hook_id), na ordem de
// categorias escolhida pelo jogador. Nunca deixa o saldo abaixo da reserva —
// a mesma da Lista de Compras (shopList.reserve). Quando:
//   anytime  — assim que tiver dinheiro (confere depois de cada pesca, a cada
//              10 min e no inicio de um Desconto na Loja);
//   discount — so durante o Desconto na Loja (preco com desconto).
// O saldo e os itens sao por barco: lidos de /api/{canal}/me.
// Estado por canal em gameState[canal].upgrade: { lastMsg, lastAt }.

const UPGRADE_ALARM_PREFIX = "auto-twish-upgrade:";
const UPGRADE_PERIOD_ALARM = "auto-twish-upgrade-period";
const UPGRADE_PERIOD_MIN = 10;
const UPGRADE_AFTER_CATCH_MS = 12000; // depois do Inv Dump (8 s)
const upgradeBusy = new Set();

async function upgradeConfigs(channel) {
  const general = await getGeneralSettings();
  const s = (await getAllChannelSettings())[channel] || null;
  return { cfg: AT.effectiveAutoUpgrade(s, general), reserve: AT.effectiveShopList(s, general).reserve };
}

async function scheduleUpgrade(channel, delayMs = UPGRADE_AFTER_CATCH_MS) {
  if (!channel || !(await upgradeConfigs(channel)).cfg.enabled) return;
  const name = `${UPGRADE_ALARM_PREFIX}${channel}`;
  const when = Date.now() + Math.max(1000, delayMs);
  const existing = await browser.alarms.get(name);
  if (existing && existing.scheduledTime > Date.now() && existing.scheduledTime <= when) return;
  await browser.alarms.create(name, { when });
}

async function upgradeLog(channel, msg, { force = false } = {}) {
  const { gameState } = await browser.storage.local.get("gameState");
  const prev = ((gameState || {})[channel] || {}).upgrade;
  if (!force && prev && prev.lastMsg === msg) return;
  console.log(`${AT.LOG_PREFIX} [Aprimoramento] "${channel}": ${msg}`);
  await mutateGameState(channel, (st) => {
    st.upgrade = { lastMsg: msg, lastAt: Date.now() };
  });
}

// Proximo item da cadeia de uma categoria, dado o que o jogador tem.
// list = itens da loja; ownedIds = ids que tem (os anteriores da cadeia contam como tidos).
function nextUpgrade(list, ownedIds, reqKey) {
  const items = (list || []).filter((i) => i && AT.cleanItemId(i.id));
  const byId = new Map(items.map((i) => [i.id, i]));
  const byReq = new Map(items.map((i) => [i[reqKey] || null, i]));
  const owned = new Set();
  for (const id of ownedIds) {
    let cur = byId.get(id);
    for (let g = 0; cur && g < 50; g++) {
      owned.add(cur.id);
      cur = byId.get(cur[reqKey]);
    }
  }
  let next = byReq.get(null);
  for (let g = 0; next && owned.has(next.id) && g < 50; g++) next = byReq.get(next.id);
  return next || null;
}

function upgradeTarget(shop, acc, cat) {
  const eq = acc.equipment || {};
  const owned = acc.owned || {};
  if (cat === "rods") return nextUpgrade(shop.rods, [...(owned.rod_ids || []), eq.rod_id].filter(Boolean), "requires_rod_id");
  if (cat === "hooks") return nextUpgrade(shop.hooks, [...(owned.hook_ids || []), eq.hook_id].filter(Boolean), "requires_hook_id");
  if (cat === "backpacks") return nextUpgrade(shop.backpacks, [eq.backpack_id].filter(Boolean), "requires_backpack_id");
  return null;
}

async function readUpgradeAccount(channel) {
  const me = await fetchTwishMe(channel);
  if (!me) return null;
  const d = me.data;
  const coins = Number(d.twishcoins);
  if (!Number.isFinite(coins)) return null;
  return { coins, equipment: d.equipment || {}, owned: d.owned || {} };
}

async function runUpgrade(channel, source) {
  if (upgradeBusy.has(channel)) return;
  upgradeBusy.add(channel);
  try {
    const { cfg, reserve } = await upgradeConfigs(channel);
    if (!cfg.enabled || safetyLocked) return;
    const cats = cfg.order.filter((c) => cfg.categories[c]);
    if (!cats.length) return;
    if ((await twitchTabsForChannel(channel)).length === 0) return; // compra e pelo chat

    const shop = await fetchShop(channel, true);
    if (!shop) {
      await upgradeLog(channel, "sem leitura da loja; tento depois.");
      return;
    }
    const rate = Number(shop.discount_rate) > 0 && Number(shop.discount_rate) < 1 ? Number(shop.discount_rate) : 0;
    if (cfg.when === "discount" && !rate) return; // so no Desconto na Loja

    let acc = await readUpgradeAccount(channel);
    if (!acc) {
      await upgradeLog(channel, "sem leitura da conta (logado no twish.com.br?); nada comprado.");
      return;
    }
    const notes = [];
    const bought = [];
    for (const cat of cats) {
      const next = upgradeTarget(shop, acc, cat);
      if (!next) {
        notes.push(`${AT.UPGRADE_LABELS[cat]}: já no máximo`);
        continue;
      }
      const base = Number(next.cost) || 0;
      const price = rate ? (Number.isFinite(Number(next.discounted_cost)) ? Number(next.discounted_cost) : AT.discountedPrice(base, rate)) : base;
      if (!(price > 0)) continue;
      if (acc.coins - price < reserve) {
        notes.push(`${next.name || next.id}: faltam moedas (${price}${reserve ? ` + reserva ${reserve}` : ""}; saldo ${acc.coins})`);
        continue; // passa para a proxima categoria
      }
      const r = await enqueueCommand(channel, `${AT.BUY_COMMAND} ${next.id}`, { reason: `Aprimoramento (${AT.UPGRADE_LABELS[cat]}${rate ? `, ${Math.round(rate * 100)}% off` : ""})` });
      if (!r.ok) {
        notes.push(`${next.name || next.id}: falha ao enviar (${r.reason})`);
        break;
      }
      await sleep(3000);
      const after = await readUpgradeAccount(channel);
      if (after) {
        const nowNext = upgradeTarget(shop, after, cat);
        if (!nowNext || nowNext.id !== next.id) bought.push(`${next.name || next.id} (${price})`);
        else notes.push(`${next.name || next.id}: o jogo não confirmou a compra`);
        acc = after;
      } else {
        bought.push(`${next.name || next.id} (${price}, sem confirmação)`);
        acc = { ...acc, coins: acc.coins - price };
      }
    }
    if (bought.length) {
      const msg = `comprei ${bought.join(", ")}.${notes.length ? " " + notes.join(" · ") + "." : ""}`;
      await upgradeLog(channel, msg, { force: true });
      await notifyAutomation(`upgrade-auto:${channel}`, `⬆️ Aprimoramento em ${channel}`, `Comprei ${bought.join(", ")}.`);
    } else if (notes.length) {
      await upgradeLog(channel, notes.join(" · ") + ".");
    }
  } catch (e) {
    console.warn(`${AT.LOG_PREFIX} [Aprimoramento] Falha em "${channel}":`, e);
  } finally {
    upgradeBusy.delete(channel);
  }
}

// Evento do canal (background refreshEvents): no inicio de um Desconto, confere
// depois da Lista de Compras (que sai em 5–20 s).
async function onUpgradeEvents(channel, ev) {
  const e = ev && ev.event;
  if (!e || e.kind !== "store_discount") return;
  await scheduleUpgrade(channel, 25000 + Math.random() * 10000);
}

async function anyUpgradeActive() {
  const general = await getGeneralSettings();
  const channels = await getAllChannelSettings();
  return Object.values(channels).some((s) => AT.effectiveAutoUpgrade(s, general).enabled);
}
async function updateUpgradeAlarm() {
  const any = await anyUpgradeActive();
  const existing = await browser.alarms.get(UPGRADE_PERIOD_ALARM);
  if (any && !existing) await browser.alarms.create(UPGRADE_PERIOD_ALARM, { periodInMinutes: UPGRADE_PERIOD_MIN });
  else if (!any && existing) await browser.alarms.clear(UPGRADE_PERIOD_ALARM);
}

function onUpgradeSettingsChanged(channel) {
  (async () => {
    await updateUpgradeAlarm();
    await updateEventsPoller();
    const names = channel ? [channel] : Object.keys(await getAllChannelSettings());
    for (const ch of names) await scheduleUpgrade(ch, 2000);
  })().catch((e) => console.warn(`${AT.LOG_PREFIX} [Aprimoramento] Falha ao aplicar a configuração:`, e));
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith(UPGRADE_ALARM_PREFIX)) runUpgrade(alarm.name.slice(UPGRADE_ALARM_PREFIX.length), "alarme");
  else if (alarm.name === UPGRADE_PERIOD_ALARM) {
    (async () => {
      for (const ch of Object.keys(await getAllChannelSettings())) await runUpgrade(ch, `a cada ${UPGRADE_PERIOD_MIN} min`);
    })();
  }
});

updateUpgradeAlarm().catch(() => {});
