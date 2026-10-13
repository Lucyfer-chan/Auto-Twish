// kit.js — Isca e reforcos por evento, Torneio e isca do duelo (Road Map item 3).
//
// Eventos (XP em Dobro, Mare Turbo, Sorte Rara): enquanto o evento durar,
// equipa a isca escolhida ($isca) e mantem ativos o Turbo de Pesca e/ou a
// Afiacao de Anzol (renova quando acabam). Se o item nao estiver no
// inventario e a compra automatica estiver ligada, compra ($comprar) e ativa.
// No fim, volta a isca que estava antes (ou desequipa).
// Isca: sem ela no inventario e com "comprar se nao tiver", compra a
// quantidade escolhida ($comprar <isca> <qtd>) e equipa. Confere a cada 30 s se
// a isca acabou; a mesma isca nao e comprada de novo antes de 30 s.
//
// Toda compra daqui (eventos e torneio) confere o preco na loja e o saldo
// antes de enviar o $comprar, e nunca deixa o saldo abaixo da Reserva de
// Moedas (a mesma da Lista de Compras e do Aprimoramento).
//
// Torneio: le /api/{canal}/tournament (logado). Com inscricoes abertas,
// entra ($entrar) se a regra do CD da pesca deixar; dentro do torneio,
// equipa a isca e ativa o Turbo Torneio.
//
// Duelo: ao aceitar, equipa 1 isca ($isca <id> 1); no fim do duelo, volta.
//
// Ativar itens ("usar") NAO tem comando de chat: e a unica acao feita pela
// API do site (POST /api/{canal}/me/use/{item}), liberada pelo jogador.
// Comprar, equipar e entrar continuam pelo chat.
//
// Estado por canal em gameState[canal].kit:
//   { ctx: { event: {key, kind, baitId, endsAt}, tournament: {baitId}, duel: {baitId, until} },
//     prevBait: {id} (isca de antes; ausente = a extensao nao mexeu),
//     tourneyKey, tourneyBoostTried, lastMsg, lastAt }

const KIT_ALARM_PREFIX = "auto-twish-kit:";
const TOURNEY_ALARM_NAME = "auto-twish-tourney";
const TOURNEY_CHECK_PREFIX = "auto-twish-tourney-check:"; // conferencia pontual (ex: depois de pescar)
const TOURNEY_LAST_CHANCE_MS = 15 * 1000; // faltando isso para fecharem as inscricoes, entra de qualquer jeito
const KIT_MIN_EVENT_LEFT_MS = 30 * 1000; // nao ativa reforco com o evento acabando
const DUEL_BAIT_MAX_MS = 15 * 60 * 1000; // se o fim do duelo nao for visto, solta a isca depois disso
const BAIT_PRIORITY = ["tournament", "duel", "event"];
const kitBusy = new Set();
const BAIT_REBUY_GAP_MS = 30 * 1000; // nao compra a mesma isca de novo antes disso
const baitBoughtAt = new Map(); // "canal:isca" -> quando comprou

async function kitConfigs(channel) {
  const general = await getGeneralSettings();
  const s = (await getAllChannelSettings())[channel] || null;
  return {
    s,
    kit: AT.effectiveEventKit(s, general),
    tourney: AT.effectiveTournament(s, general),
    duelBait: AT.effectiveDuelBait(s, general)
  };
}

async function readKitState(channel) {
  const { gameState } = await browser.storage.local.get("gameState");
  const k = ((gameState || {})[channel] || {}).kit || {};
  return { ctx: { ...(k.ctx || {}) }, ...k };
}
async function saveKitState(channel, fn) {
  await mutateGameState(channel, (st) => {
    st.kit = st.kit || {};
    st.kit.ctx = st.kit.ctx || {};
    fn(st.kit);
  });
}
async function kitLog(channel, msg) {
  console.log(`${AT.LOG_PREFIX} [eventos] "${channel}": ${msg}`);
  await saveKitState(channel, (k) => {
    k.lastMsg = msg;
    k.lastAt = Date.now();
  });
}

// Conta do jogador no canal: isca equipada, inventario e efeitos ativos.
async function readKitAccount(channel) {
  const me = await fetchTwishMe(channel);
  if (!me) return null;
  const d = me.data;
  const eq = d.equipment || {};
  const owned = d.owned || {};
  const active = d.active || {};
  return {
    baitId: eq.bait_id || null,
    baitQty: Number(eq.bait_quantity) || 0,
    baits: owned.baits || {},
    items: owned.items || {},
    boostRemaining: Number(active.boost_remaining) || 0, // s (Turbo de Pesca)
    sharpenRemaining: Number(active.sharpen_remaining) || 0, // s (Afiacao de Anzol)
    greaseCastsLeft: Number(active.grease_casts_left) || 0, // lancadas (Graxa de Molinete)
    remainingMs: Math.max(0, Number(d.cooldown_remaining) || 0) * 1000,
    coins: Number.isFinite(Number(d.twishcoins)) ? Number(d.twishcoins) : null,
    rodId: eq.rod_id || null
  };
}

function itemCount(acc, id) {
  return Number((acc.items || {})[id]) || 0;
}

// Ativa um item do inventario pela API (unica acao liberada por API alem do Mercado).
async function useItem(channel, itemId) {
  const r = await twishApi(`/api/${encodeURIComponent(channel)}/me/use/${encodeURIComponent(itemId)}`, { method: "POST" });
  return { ok: !!r.ok, error: (r.data && r.data.error) || (r.ok ? null : `HTTP ${r.status}`) };
}

// Preco atual de um item na loja do canal (com o Desconto na Loja, se houver).
function kitItemPrice(shop, itemId) {
  if (!shop) return null;
  const rate = Number(shop.discount_rate) > 0 && Number(shop.discount_rate) < 1 ? Number(shop.discount_rate) : 0;
  for (const list of Object.values(shop)) {
    if (!Array.isArray(list)) continue;
    const it = list.find((x) => x && x.id === itemId);
    if (!it) continue;
    const base = Number(it.cost);
    if (!(base > 0)) return null;
    if (!rate) return base;
    const disc = Number(it.discounted_cost);
    return Number.isFinite(disc) && disc > 0 ? disc : AT.discountedPrice(base, rate);
  }
  return null;
}

// Compra pelo chat conferindo preco, saldo e reserva. qty = quantidade desejada
// (minQty = o minimo que vale a pena comprar). Devolve { ok, qty, note }.
async function kitBuy(channel, itemId, name, qty, acc, minQty = qty) {
  const general = await getGeneralSettings();
  const s = (await getAllChannelSettings())[channel] || null;
  const reserve = AT.effectiveShopList(s, general).reserve;
  const price = kitItemPrice(await fetchShop(channel, true), itemId);
  if (!(price > 0)) return { ok: false, note: `${name}: sem o preço na loja; não comprei` };
  if (!Number.isFinite(acc.coins)) return { ok: false, note: `${name}: sem leitura do saldo; não comprei` };
  const n = Math.min(qty, Math.floor((acc.coins - reserve) / price));
  if (n < Math.max(1, minQty)) {
    return { ok: false, note: `${name}: moedas insuficientes (${price}${qty > 1 ? " cada" : ""}${reserve ? ` + reserva ${reserve}` : ""}; saldo ${acc.coins})` };
  }
  const r = await enqueueCommand(channel, n > 1 ? `${AT.BUY_COMMAND} ${itemId} ${n}` : `${AT.BUY_COMMAND} ${itemId}`, { reason: `${name} para o evento` });
  if (!r.ok) return { ok: false, note: `${name}: falha ao enviar a compra (${r.reason})` };
  acc.coins -= n * price;
  return { ok: true, qty: n, note: `${name}: comprei ${n > 1 ? `${n} × ` : ""}${price}` };
}

// Garante um item ativo: usa do inventario; sem ele, compra pelo chat (se permitido) e usa.
async function activateItem(channel, itemId, name, allowBuy, acc) {
  if (itemCount(acc, itemId) <= 0) {
    if (!allowBuy) return `${name}: não tem no inventário (compra automática desligada)`;
    const b = await kitBuy(channel, itemId, name, 1, acc);
    if (!b.ok) return b.note;
    await sleep(3000);
  }
  const u = await useItem(channel, itemId);
  if (!u.ok) return `${name}: o site não ativou (${u.error})`;
  if (itemId === AT.TURBO_ITEM || itemId === AT.TOURNAMENT_TURBO_ITEM) {
    const torneio = itemId === AT.TOURNAMENT_TURBO_ITEM;
    boostUntil.set(channel, { until: Date.now() + (torneio ? 180 : 300) * 1000, cdMs: (torneio ? 10 : 20) * 1000 });
    dropDelayNow(channel).catch(() => {}); // Turbo ativo: $pescar sem atraso
    const s = (await getAllChannelSettings())[channel];
    if (s && s.enabled) schedulePostSendCheck(channel, 3000); // CD muda: confere a conta
  }
  return `${name}: ativado`;
}

// Decide qual isca deveria estar equipada e troca, se preciso.
// buyCfg = { baitBuy, baitBuyQty } da regra do evento (so vale para a isca do evento).
async function applyBait(channel, acc, notes, buyCfg) {
  const st = await readKitState(channel);
  const now = Date.now();
  let owner = null;
  for (const k of BAIT_PRIORITY) {
    const c = st.ctx[k];
    if (c && c.baitId && (!c.until || c.until > now)) {
      owner = k;
      break;
    }
  }
  const cur = acc.baitId || null;
  if (owner) {
    const want = st.ctx[owner].baitId;
    const one = owner === "duel";
    if (cur === want) return;
    if (!(Number(acc.baits[want]) > 0)) {
      if (owner !== "event" || !buyCfg || !buyCfg.baitBuy) {
        notes.push(`sem a isca ${want} no inventário`);
        return;
      }
      // Comprou ha pouco e o inventario ainda nao mostra: nao compra de novo.
      const last = baitBoughtAt.get(`${channel}:${want}`) || 0;
      if (Date.now() - last < BAIT_REBUY_GAP_MS) {
        notes.push(`isca ${want} comprada há pouco; esperando aparecer no inventário`);
        return;
      }
      const b = await kitBuy(channel, want, `isca ${want}`, buyCfg.baitBuyQty, acc, 1);
      notes.push(b.note);
      if (!b.ok) return;
      baitBoughtAt.set(`${channel}:${want}`, Date.now());
      await sleep(3000);
    }
    if (!st.prevBait) {
      await saveKitState(channel, (k) => {
        k.prevBait = { id: cur };
      });
    }
    const r = await enqueueCommand(channel, `${AT.BAIT_COMMAND} ${want}${one ? " 1" : ""}`, { reason: `isca (${owner})` });
    notes.push(r.ok ? `isca ${want} equipada` : `falha ao equipar ${want} (${r.reason})`);
    return;
  }
  if (!st.prevBait) return; // a extensao nao mexeu na isca
  const prev = st.prevBait.id;
  let r = { ok: true };
  if (prev && prev !== cur && Number(acc.baits[prev]) > 0) {
    r = await enqueueCommand(channel, `${AT.BAIT_COMMAND} ${prev}`, { reason: "volta a isca de antes" });
    notes.push(r.ok ? `isca ${prev} de volta` : `falha ao voltar a isca ${prev}`);
  } else if (!prev && cur) {
    r = await enqueueCommand(channel, AT.UNEQUIP_BAIT_COMMAND, { reason: "fim do evento" });
    notes.push(r.ok ? "isca desequipada" : "falha ao desequipar a isca");
  }
  if (r.ok) {
    await saveKitState(channel, (k) => {
      delete k.prevBait;
    });
  }
}

// Agenda uma conferencia do canal (debounce: mantem a mais cedo).
async function scheduleKitCheck(channel, delayMs) {
  const name = `${KIT_ALARM_PREFIX}${channel}`;
  const when = Date.now() + Math.max(1000, delayMs);
  const existing = await browser.alarms.get(name);
  if (existing && existing.scheduledTime > Date.now() && existing.scheduledTime <= when) return; // ja ha uma mais cedo
  await browser.alarms.create(name, { when });
}

// Chamado a cada atualizacao de eventos (background.js refreshEvents).
async function onKitEvents(channel, ev) {
  const { kit } = await kitConfigs(channel);
  const e = ev && ev.event;
  const pick = AT.kitEntryForEvent(kit, e); // Sorte Rara: a regra da raridade sorteada
  const st = await readKitState(channel);
  if (pick) {
    const key = `${e.kind}:${e.name}:${pick.tier || ""}`;
    const endsAt = (ev.fetchedAt || Date.now()) + Number(e.seconds_remaining) * 1000;
    const isNew = !st.ctx.event || st.ctx.event.key !== key;
    await saveKitState(channel, (k) => {
      k.ctx.event = { key, kind: e.kind, tier: pick.tier, baitId: pick.entry.baitId, endsAt };
    });
    if (isNew) await scheduleKitCheck(channel, 2000 + Math.random() * 6000);
  } else if (st.ctx.event) {
    await saveKitState(channel, (k) => {
      k.ctx.event = null;
    });
    await scheduleKitCheck(channel, 1000);
  }
}

// Conferencia completa de um canal: isca + reforcos do evento + proxima conferencia.
async function runKitCheck(channel, source) {
  if (kitBusy.has(channel)) {
    await scheduleKitCheck(channel, 5000);
    return;
  }
  kitBusy.add(channel);
  const notes = [];
  try {
    if (safetyLocked) return;
    const { kit } = await kitConfigs(channel);
    let st = await readKitState(channel);
    const now = Date.now();

    // Evento: confirma na hora (pode ter acabado ou mudado).
    if (st.ctx.event) {
      const ev = await fetchActiveEvents(channel);
      if (ev) await onKitEvents(channel, ev);
      st = await readKitState(channel);
    }
    // Duelo sem fim visto: solta a isca depois do limite.
    if (st.ctx.duel && st.ctx.duel.until && st.ctx.duel.until <= now) {
      await saveKitState(channel, (k) => {
        k.ctx.duel = null;
      });
      st = await readKitState(channel);
    }
    const hasCtx = Object.values(st.ctx).some(Boolean);
    if (!hasCtx && !st.prevBait) return;

    if ((await twitchTabsForChannel(channel)).length === 0) {
      await kitLog(channel, "aba do canal na Twitch fechada; nada feito.");
      await scheduleKitCheck(channel, 60000);
      return;
    }
    let acc = await readKitAccount(channel);
    if (!acc) {
      await kitLog(channel, "sem leitura da conta (logado no twish.com.br?); nada feito.");
      await scheduleKitCheck(channel, 60000);
      return;
    }

    const evc = st.ctx.event;
    const evEntry = evc ? AT.kitEntryOf(kit, evc.kind, evc.tier) : null;
    await applyBait(channel, acc, notes, evEntry && evEntry.enabled ? evEntry : null);

    // Reforcos do evento (renova enquanto o evento durar).
    let next = Infinity;
    if (evc) {
      const entry = evEntry;
      const left = evc.endsAt - Date.now();
      if (entry && entry.enabled && left > KIT_MIN_EVENT_LEFT_MS) {
        if (entry.turbo && acc.boostRemaining <= 2) notes.push(await activateItem(channel, AT.TURBO_ITEM, "Turbo de Pesca", entry.turboBuy, acc));
        if (entry.sharpen && acc.sharpenRemaining <= 2) notes.push(await activateItem(channel, AT.SHARPEN_ITEM, "Afiação de Anzol", entry.sharpenBuy, acc));
        acc = (await readKitAccount(channel)) || acc;
        if (entry.turbo && acc.boostRemaining > 0) next = Math.min(next, acc.boostRemaining * 1000 + 2000);
        if (entry.sharpen && acc.sharpenRemaining > 0) next = Math.min(next, acc.sharpenRemaining * 1000 + 2000);
        if (acc.boostRemaining > 0) boostUntil.set(channel, { until: Date.now() + acc.boostRemaining * 1000, cdMs: 20 * 1000 });
      }
      // Com compra de isca: confere a cada 30 s se a isca acabou no meio do evento.
      if (entry && entry.enabled && entry.baitId && entry.baitBuy && left > BAIT_REBUY_GAP_MS) next = Math.min(next, BAIT_REBUY_GAP_MS);
      next = Math.min(next, left + 3000);
    }
    if (st.ctx.duel && st.ctx.duel.until) next = Math.min(next, st.ctx.duel.until - Date.now() + 1000);
    if (Number.isFinite(next)) await scheduleKitCheck(channel, Math.max(10000, next));

    if (notes.length) {
      const label = evc ? AT.KIT_EVENT_LABELS[evc.kind] + (evc.tier ? ` (${AT.TIER_LABELS[evc.tier]})` : "") + ": " : "";
      await kitLog(channel, `${label}${notes.join(" · ")}`);
      const acted = notes.filter((n) => /ativado|equipada|de volta|desequipada|comprei/.test(n));
      if (acted.length) await notifyAutomation(`kit-auto:${channel}`, `🎣 Eventos em ${channel}`, acted.join(" · "));
    }
  } finally {
    kitBusy.delete(channel);
  }
}

// ---------------------------------------------------------------------------
// Duelo
// ---------------------------------------------------------------------------
async function onDuelAccepted(channel) {
  const { duelBait } = await kitConfigs(channel);
  if (!duelBait.enabled || !duelBait.baitId) return;
  await saveKitState(channel, (k) => {
    k.ctx.duel = { baitId: duelBait.baitId, until: Date.now() + DUEL_BAIT_MAX_MS };
  });
  await scheduleKitCheck(channel, 1500);
}
async function onDuelFinished(channel) {
  const st = await readKitState(channel);
  if (!st.ctx.duel) return;
  await saveKitState(channel, (k) => {
    k.ctx.duel = null;
  });
  await scheduleKitCheck(channel, 1500);
}

// ---------------------------------------------------------------------------
// Torneio
// ---------------------------------------------------------------------------
const tourneyBusy = new Set();

async function checkTournament(channel, source) {
  if (tourneyBusy.has(channel)) return;
  tourneyBusy.add(channel);
  try {
    const { s, tourney } = await kitConfigs(channel);
    if (!AT.tournamentIsActive(tourney) || safetyLocked) return;
    const r = await twishApi(`/api/${encodeURIComponent(channel)}/tournament`);
    if (!r.ok || !r.data) return;
    let t = r.data;
    const live = !!t.active && !t.settling;
    const key = live ? `t${Math.round((Date.now() + (Number(t.seconds_remaining) || 0) * 1000) / 60000)}` : null;
    const st = await readKitState(channel);

    if (!live) {
      if (st.ctx.tournament) {
        await saveKitState(channel, (k) => {
          k.ctx.tournament = null;
        });
        await scheduleKitCheck(channel, 1000);
      }
      return;
    }
    if ((await twitchTabsForChannel(channel)).length === 0) return;

    // Entrar
    const joinLeft = (Number(t.join_window_seconds_remaining) || 0) * 1000;
    if (!t.is_participant && t.join_window_open && tourney.join && joinLeft > 4000 && (await currentExpedition(channel, "torneio"))) {
      // Em expedicao nao da para entrar em torneio (em nenhum canal).
      if (st.tourneyKey !== key) {
        await kitLog(channel, "Torneio aberto, mas não entrei: em expedição.");
        await saveKitState(channel, (k) => {
          k.tourneyKey = key;
        });
      }
    } else if (!t.is_participant && t.join_window_open && tourney.join && joinLeft > 4000) {
      const acc = await readKitAccount(channel);
      const d = tourneyJoinDecision(tourney, acc, joinLeft, !!(s && s.enabled));
      if (d.waitMs) {
        // Pesca antes: confere de novo logo depois do proximo $pescar (ou na ultima chance).
        await browser.alarms.create(`${TOURNEY_CHECK_PREFIX}${channel}`, { when: Date.now() + d.waitMs });
        if (st.tourneyWaitKey !== key) {
          await kitLog(channel, `Torneio aberto: ${d.why}.`);
          await saveKitState(channel, (k) => {
            k.tourneyWaitKey = key;
          });
        }
      } else if (!d.accept) {
        if (st.tourneyKey !== key) {
          await kitLog(channel, `Torneio aberto, mas não entrei: ${d.why}.`);
          await saveKitState(channel, (k) => {
            k.tourneyKey = key;
          });
        }
      } else {
        await sleep(Math.min(joinLeft - 3000, 2000 + Math.random() * 4000));
        const j = await enqueueCommand(channel, AT.JOIN_TOURNAMENT_COMMAND, { reason: `torneio; ${d.why}` });
        if (j.ok) {
          await kitLog(channel, `Entrei no torneio (${d.why}).`);
          await notifyAutomation(`kit-auto:${channel}`, `🏆 Torneio em ${channel}`, `Entrei no torneio (${d.why}).`);
          if (s && s.enabled) schedulePostSendCheck(channel, 5000); // entrar zera o CD da pesca
          await sleep(3000);
          const again = await twishApi(`/api/${encodeURIComponent(channel)}/tournament`);
          if (again.ok && again.data) t = again.data;
        }
      }
    }

    if (t.is_participant) {
      // Isca durante o torneio
      const want = tourney.baitId || null;
      if (!st.ctx.tournament || st.ctx.tournament.baitId !== want) {
        await saveKitState(channel, (k) => {
          k.ctx.tournament = { baitId: want };
        });
        if (want) await scheduleKitCheck(channel, 1500);
      }
      // Graxa de Molinete: renova quando acabam as lancadas (para de tentar se falhar).
      if (tourney.grease && st.tourneyGreaseFail !== key) {
        const acc = await readKitAccount(channel);
        if (acc && acc.greaseCastsLeft <= 0) {
          const msg = await activateItem(channel, AT.GREASE_ITEM, "Graxa de Molinete", tourney.greaseBuy, acc);
          await kitLog(channel, `Torneio: ${msg}`);
          if (!/ativado/.test(msg)) {
            await saveKitState(channel, (k) => {
              k.tourneyGreaseFail = key;
            });
          }
        }
      }
      // Turbo Torneio (uma tentativa por torneio)
      if (tourney.boost && !t.is_boosted && st.tourneyBoostTried !== key) {
        await saveKitState(channel, (k) => {
          k.tourneyBoostTried = key;
        });
        const acc = await readKitAccount(channel);
        if (acc) {
          const msg = await activateItem(channel, AT.TOURNAMENT_TURBO_ITEM, "Turbo Torneio", tourney.boostBuy, acc);
          await kitLog(channel, `Torneio: ${msg}`);
        }
      }
    }
  } finally {
    tourneyBusy.delete(channel);
  }
}

// Entrar agora, esperar pescar antes, ou nao entrar.
//   fishFirst: se o CD acaba antes de fecharem as inscricoes e a extensao pesca
//              neste canal, espera pescar e entra logo depois; senao entra na hora.
//   always:    entra na hora.
//   minTime:   entra so se faltar pelo menos X para pescar.
function tourneyJoinDecision(cfg, acc, joinLeftMs, fishesHere) {
  if (cfg.rule === "always") return { accept: true, why: "regra: sempre" };
  const rem = acc ? acc.remainingMs : null;
  if (cfg.rule === "minTime") {
    return AT.duelAcceptDecision({ enabled: true, rule: "minTime", minSeconds: cfg.minSeconds }, { remainingMs: rem });
  }
  // fishFirst
  if (rem === null) return { accept: true, why: "sem leitura do CD; entrei na hora" };
  const cd = AT.formatRemaining(rem);
  if (!fishesHere) return { accept: true, why: `a extensão não pesca neste canal (CD ${cd})` };
  if (rem + 10000 >= joinLeftMs) return { accept: true, why: `CD de ${cd} não acaba antes de fecharem as inscrições` };
  if (joinLeftMs <= TOURNEY_LAST_CHANCE_MS + 5000) return { accept: true, why: "inscrições fechando; entrei sem esperar" };
  return {
    accept: false,
    waitMs: Math.max(5000, Math.min(rem + 12000, joinLeftMs - TOURNEY_LAST_CHANCE_MS)),
    why: `CD de ${cd} acaba antes de fecharem as inscrições (${AT.formatRemaining(joinLeftMs)}); vou pescar antes e entrar depois`
  };
}

async function updateTourneyAlarm() {
  const general = await getGeneralSettings();
  const channels = await getAllChannelSettings();
  const any = Object.values(channels).some((s) => AT.tournamentIsActive(AT.effectiveTournament(s, general)));
  const existing = await browser.alarms.get(TOURNEY_ALARM_NAME);
  if (any && !existing) await browser.alarms.create(TOURNEY_ALARM_NAME, { periodInMinutes: 0.5 });
  else if (!any && existing) await browser.alarms.clear(TOURNEY_ALARM_NAME);
}

async function checkAllTournaments(source) {
  for (const channel of Object.keys(await getAllChannelSettings())) {
    try {
      await checkTournament(channel, source);
    } catch (e) {
      console.warn(`${AT.LOG_PREFIX} Falha no torneio de "${channel}":`, e);
    }
  }
}

// Mudou alguma configuracao destas automacoes.
function onKitSettingsChanged(channel) {
  (async () => {
    await updateTourneyAlarm();
    await updateEventsPoller();
    const names = channel ? [channel] : Object.keys(await getAllChannelSettings());
    for (const ch of names) {
      const ev = await refreshEvents(ch, false); // chama onKitEvents
      if (!ev) await scheduleKitCheck(ch, 2000);
      await checkTournament(ch, "configuração");
    }
  })().catch((e) => console.warn(`${AT.LOG_PREFIX} Falha ao aplicar eventos/torneio:`, e));
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith(KIT_ALARM_PREFIX)) runKitCheck(alarm.name.slice(KIT_ALARM_PREFIX.length), "alarme");
  else if (alarm.name === TOURNEY_ALARM_NAME) checkAllTournaments("a cada 30 s");
  else if (alarm.name.startsWith(TOURNEY_CHECK_PREFIX)) checkTournament(alarm.name.slice(TOURNEY_CHECK_PREFIX.length), "depois de pescar");
});

browser.runtime.onMessage.addListener((msg, sender) => {
  // content.js: o bot falou de torneio com $entrar — confere na hora.
  if (msg?.type === "CHAT_TOURNAMENT_HINT") {
    const channel = extractChannelFromUrl(sender?.tab?.url || "");
    if (channel) checkTournament(channel, "chat").catch(() => {});
  }
  return false;
});

updateTourneyAlarm().catch(() => {});
