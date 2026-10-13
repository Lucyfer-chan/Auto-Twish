// board.js — Embarque automatico nas expedicoes.
//
// Quando o bot anuncia uma sala num chat ativo ("⛵ @x abriu uma expedição à
// <mar>! Embarque pelo site em twish.com.br/c/<canal>/expedicoes/<id> — até 4
// tripulantes, e a sala zarpa em 10 min."), a extensao entra na sala pelo
// barco desse canal e confirma a prontidao.
// Entrar e confirmar nao tem comando de chat: e feito pela API do site
// (POST /api/{canal}/expeditions/{id}/join e .../ready), liberado pelo jogador.
// Comprar o ticket (opcional, por mar) continua pelo chat ($comprar).
//
// Pescar antes (regra do jogador): enquanto houver mais de 1 vaga e o CD da
// pesca acabar com folga antes da sala zarpar, espera o proximo $pescar neste
// canal e entra logo depois. Restando 1 vaga (ou sem folga), entra na hora.
// Com "embarque imediato" ligado, entra na hora sempre.
//
// Ticket: so compra se nem o porto (seas[].entry_owned) nem o inventario do
// barco (/me owned.items) mostrarem a entrada do mar.
//
// Estado: storage "boarding" = { roomId, channel, sea, opener, deadlineAt,
//   createdAt, fishedAt, phase: "waiting"|"joined"|"ready"|"done"|"failed", lastMsg, lastAt }

const BOARD_ALARM_NAME = "auto-twish-board";
const BOARD_MARGIN_MS = 60 * 1000; // folga antes de a sala zarpar
const BOARD_POLL_MS = 20 * 1000; // esperando a pesca: confere as vagas a cada 20 s
const BOARD_AFTER_FISH_MS = 4000; // depois do $pescar, entra em ~4 s
const BOARD_ERRORS = {
  expeditions_disabled: "o streamer deixou as expedições de fora neste barco",
  already_in_expedition: "você já está numa expedição",
  expedition_not_found: "a sala não existe mais",
  expedition_not_open: "a sala já zarpou ou fechou",
  expedition_full: "a tripulação já está completa",
  no_ticket: "falta a entrada deste mar no inventário deste barco",
  rod_too_weak: "a vara equipada não aguenta esse mar",
  in_tournament: "você está num torneio",
  in_duel: "você está num duelo",
  not_a_member: "você não está nessa tripulação",
  rate_limited: "muitos pedidos seguidos"
};
let boardBusy = false;

async function readBoarding() {
  const { boarding } = await browser.storage.local.get("boarding");
  return boarding || null;
}
async function saveBoarding(fn) {
  const cur = (await readBoarding()) || {};
  const next = fn(cur);
  await browser.storage.local.set({ boarding: next === undefined ? cur : next });
  return next === undefined ? cur : next;
}
async function boardLog(msg, { phase, notify } = {}) {
  const b = await saveBoarding((x) => {
    x.lastMsg = msg;
    x.lastAt = Date.now();
    if (phase) x.phase = phase;
  });
  console.log(`${AT.LOG_PREFIX} [Embarque] "${b.channel || "?"}": ${msg}`);
  if (phase === "failed" && typeof logActivity === "function") logActivity(b.channel, "expedição", `Embarque: ${msg}`);
  if (b.channel) {
    await mutateGameState(b.channel, (st) => {
      st.board = { lastMsg: msg, lastAt: Date.now() };
    });
  }
  if (notify && b.channel) await notifyAutomation(`board-auto:${b.channel}`, `⛵ Expedição em ${b.channel}`, msg);
}
async function scheduleBoarding(delayMs) {
  await browser.alarms.create(BOARD_ALARM_NAME, { when: Date.now() + Math.max(1000, delayMs) });
}
function boardErr(r) {
  const code = r && r.data && r.data.error;
  return BOARD_ERRORS[code] || code || `HTTP ${r ? r.status : "?"}`;
}

// content.js: o bot anunciou uma sala neste canal.
async function onExpeditionOpenedChat(channel, info) {
  const general = await getGeneralSettings();
  const s = (await getAllChannelSettings())[channel] || null;
  const cfg = AT.effectiveAutoBoard(s, general);
  if (!cfg.enabled) return;
  const login = general.twishLogin || null;
  const sea = AT.expeditionSeaId(info.sea);
  const tag = `sala de @${info.opener || "?"} (${info.sea || "?"})`;
  if (login && String(info.opener || "").toLowerCase() === login) return; // sala aberta pelo proprio jogador
  if (!s || !s.enabled) {
    console.log(`${AT.LOG_PREFIX} [Embarque] "${channel}": ${tag} ignorada — o canal não está ativado na extensão.`);
    return;
  }
  if (!sea || !cfg.seas[sea] || !cfg.seas[sea].enabled) {
    console.log(`${AT.LOG_PREFIX} [Embarque] "${channel}": ${tag} ignorada — mar fora da lista.`);
    return;
  }
  const cur = await readBoarding();
  if (cur && cur.roomId && cur.roomId !== info.roomId && ["waiting", "joined", "ready"].includes(cur.phase) && Date.now() < (cur.deadlineAt || 0)) {
    console.log(`${AT.LOG_PREFIX} [Embarque] "${channel}": ${tag} ignorada — já cuidando de outra sala (${cur.channel}).`);
    return;
  }
  if (cur && cur.roomId === info.roomId) return; // mesma sala (mensagem repetida)
  const minutes = Math.min(Math.max(Number(info.minutes) || 10, 1), 60);
  await browser.storage.local.set({
    boarding: {
      roomId: info.roomId,
      channel,
      sea,
      opener: info.opener || null,
      maxCrew: Number(info.maxCrew) || null,
      deadlineAt: Date.now() + minutes * 60000,
      createdAt: Date.now(),
      fishedAt: null,
      phase: "waiting"
    }
  });
  await boardLog(`${tag} aberta; vou embarcar.`);
  await scheduleBoarding(1500 + Math.random() * 2500);
}

// A extensao (ou o jogador) pescou neste canal: se ha sala esperando a pesca, entra logo.
async function noteFishForBoarding(channel) {
  noteFishForFleet(channel).catch(() => {});
  const b = await readBoarding();
  if (!b || b.channel !== channel || b.phase !== "waiting" || b.fishedAt) return;
  await saveBoarding((x) => {
    x.fishedAt = Date.now();
  });
  await scheduleBoarding(BOARD_AFTER_FISH_MS);
}

// Quantos de um item o jogador tem no inventario deste barco (null = sem leitura).
async function ownedItemCount(channel, itemId) {
  const me = await fetchTwishMe(channel);
  if (!me || !me.data) return null;
  const owned = me.data.owned || {};
  let n = 0;
  for (const v of Object.values(owned)) {
    if (v && typeof v === "object" && !Array.isArray(v) && Number.isFinite(Number(v[itemId]))) n += Number(v[itemId]);
    else if (Array.isArray(v) && v.includes(itemId)) n += 1;
  }
  return n;
}

// Seguro do mar (opcional): gasto sozinho ao zarpar, se estiver no inventario do barco.
async function ensureInsurance(channel, sea) {
  const item = AT.EXPEDITION_INSURANCE[sea];
  if (!item) return;
  const cfg = AT.effectiveAutoBoard((await getAllChannelSettings())[channel] || null, await getGeneralSettings());
  if (!cfg.seas[sea] || !cfg.seas[sea].insure) return;
  const me = await fetchTwishMe(channel);
  const have = me ? Number(((me.data.owned || {}).items || {})[item]) || 0 : 0;
  if (have > 0) {
    await boardLog(`seguro do mar já no inventário (${item}).`);
    return;
  }
  const r = await enqueueCommand(channel, `${AT.BUY_COMMAND} ${item}`, { reason: "seguro da expedição" });
  await boardLog(r.ok ? `comprei o seguro do mar (${item}).` : `falha ao comprar o seguro (${r.reason}).`);
  if (r.ok) await sleep(2500);
}

async function runBoarding(source) {
  if (boardBusy) return;
  boardBusy = true;
  try {
    let b = await readBoarding();
    if (!b || !b.roomId || !["waiting", "joined"].includes(b.phase)) return;
    if (safetyLocked) {
      await scheduleBoarding(30000);
      return;
    }
    const ch = b.channel;
    const base = `/api/${encodeURIComponent(ch)}/expeditions`;
    if (Date.now() > (b.deadlineAt || 0) + 60000) {
      await boardLog("a sala já devia ter zarpado; desisti.", { phase: "failed" });
      return;
    }

    // Sala e porto (vagas, prazo, ticket, vara).
    const rr = await twishApi(`${base}/${encodeURIComponent(b.roomId)}`);
    if (!rr.ok || !rr.data) {
      if (rr.status === 404) await boardLog("a sala não existe mais.", { phase: "failed" });
      else {
        await boardLog(`sem leitura da sala (${boardErr(rr)}); tento de novo.`);
        await scheduleBoarding(BOARD_POLL_MS);
      }
      return;
    }
    const room = rr.data;
    if (room.state !== "open") {
      await boardLog(room.state === "at_sea" ? "a sala zarpou antes de eu entrar." : "a sala fechou.", { phase: "failed" });
      return;
    }
    const secs = Number(room.seconds_to_deadline);
    if (Number.isFinite(secs) && secs > 0) {
      b = await saveBoarding((x) => {
        x.deadlineAt = Date.now() + secs * 1000;
      });
    }
    const login = (await getGeneralSettings()).twishLogin || null;
    const crew = Array.isArray(room.crew) ? room.crew : [];
    const mine = login ? crew.find((c) => c && String(c.handle || "").toLowerCase() === login) : null;

    // Ja esta na sala: confirma a prontidao.
    if (mine) {
      if (mine.confirmed) {
        await boardLog("na sala e pronto; esperando zarpar.", { phase: "ready" });
        return;
      }
      const rd = await twishApi(`${base}/${encodeURIComponent(b.roomId)}/ready`, { method: "POST", body: {} });
      if (rd.ok) await boardLog(`embarquei na sala de @${b.opener || "?"} (${AT.EXPEDITION_SEAS[b.sea] || b.sea}) e confirmei a prontidão.`, { phase: "ready", notify: true });
      else {
        await boardLog(`entrei, mas o site não confirmou a prontidão (${boardErr(rd)}); tento de novo.`, { phase: "joined" });
        await scheduleBoarding(10000);
      }
      return;
    }

    const harbour = await twishApi(base);
    const hd = harbour.ok && harbour.data ? harbour.data : null;
    if (hd && hd.mine && hd.mine !== b.roomId) {
      await boardLog("você já está em outra expedição.", { phase: "failed" });
      return;
    }
    if (hd && hd.boat_enabled === false) {
      await boardLog(BOARD_ERRORS.expeditions_disabled + ".", { phase: "failed" });
      return;
    }
    const maxCrew = Number(hd && hd.max_crew) || Number(b.maxCrew) || 4;
    const free = maxCrew - crew.length;
    if (free <= 0) {
      await boardLog(BOARD_ERRORS.expedition_full + ".", { phase: "failed" });
      return;
    }

    // Pescar antes? (nao, com embarque imediato)
    const cfgNow = AT.effectiveAutoBoard((await getAllChannelSettings())[ch] || null, await getGeneralSettings());
    const timeLeft = b.deadlineAt - Date.now();
    if (!cfgNow.immediate && !b.fishedAt && free > 1 && timeLeft > BOARD_MARGIN_MS) {
      const me = await fetchTwishMe(ch);
      const cdMs = me ? parseTwishMe(me).availableAt - Date.now() : null;
      if (cdMs !== null && cdMs + 5000 < timeLeft - BOARD_MARGIN_MS) {
        const wait = Math.min(BOARD_POLL_MS, Math.max(5000, timeLeft - BOARD_MARGIN_MS));
        await boardLog(`esperando pescar antes de entrar (${free} vagas; pesca em ${AT.formatRemaining(Math.max(0, cdMs))}).`);
        await scheduleBoarding(wait);
        return;
      }
    }

    // Entrada do mar e vara.
    const seaInfo = hd && Array.isArray(hd.seas) ? hd.seas.find((x) => x && x.sea === b.sea) : null;
    if (seaInfo && seaInfo.rod_ok === false) {
      await boardLog(`${BOARD_ERRORS.rod_too_weak} (mínimo: ${seaInfo.min_rod_name || "?"}).`, { phase: "failed" });
      return;
    }
    const need = Number(seaInfo && seaInfo.entry_quantity) || 1;
    const portSaysMissing = seaInfo && seaInfo.entry_owned !== undefined && seaInfo.entry_owned !== null && Number(seaInfo.entry_owned) < need;
    if (portSaysMissing) {
      const ticketId = AT.cleanItemId(seaInfo.entry_item_id);
      const ticketName = seaInfo.entry_item_name || seaInfo.entry_item_id;
      // Confere tambem o inventario do barco antes de comprar.
      const have = ticketId ? await ownedItemCount(ch, ticketId) : null;
      if (have !== null && have >= need) {
        await boardLog(`ticket já no inventário (${ticketName}: ${have}); não comprei.`);
      } else {
        const canBuy = cfgNow.seas[b.sea] && cfgNow.seas[b.sea].buy && b.sea !== "fenda" && ticketId;
        if (!canBuy) {
          await boardLog(`${BOARD_ERRORS.no_ticket} (${ticketName}).`, { phase: "failed" });
          return;
        }
        const buy = await enqueueCommand(ch, `${AT.BUY_COMMAND} ${ticketId}`, { reason: "ticket da expedição" });
        if (!buy.ok) {
          await boardLog(`falha ao comprar o ticket (${buy.reason}).`, { phase: "failed" });
          return;
        }
        await boardLog(`comprei o ticket (${ticketName}).`);
        await sleep(3000);
      }
    }

    // Entra e confirma.
    const j = await twishApi(`${base}/${encodeURIComponent(b.roomId)}/join`, { method: "POST", body: {} });
    if (!j.ok) {
      const code = j.data && j.data.error;
      const retry = code === "rate_limited" || j.status === 0 || j.status >= 500;
      await boardLog(`o site não me deixou entrar: ${boardErr(j)}.`, { phase: retry ? "waiting" : "failed" });
      if (retry) await scheduleBoarding(5000);
      return;
    }
    await saveBoarding((x) => {
      x.phase = "joined";
    });
    await sleep(1500);
    await ensureInsurance(ch, b.sea);
    const rd = await twishApi(`${base}/${encodeURIComponent(b.roomId)}/ready`, { method: "POST", body: {} });
    if (rd.ok) await boardLog(`embarquei na sala de @${b.opener || "?"} (${AT.EXPEDITION_SEAS[b.sea] || b.sea}) e confirmei a prontidão.`, { phase: "ready", notify: true });
    else {
      await boardLog(`entrei, mas o site não confirmou a prontidão (${boardErr(rd)}); tento de novo.`, { phase: "joined" });
      await scheduleBoarding(10000);
    }
  } catch (e) {
    console.warn(`${AT.LOG_PREFIX} [Embarque] Falha:`, e);
    await scheduleBoarding(BOARD_POLL_MS);
  } finally {
    boardBusy = false;
  }
}

// ---------------------------------------------------------------------------
// Frota do Capitao
//
// "@x lançou a Frota do Capitão! Digite $embarcar nos próximos 10m0s — sem
// ticket e sem vara mínima, até 16 tripulantes." Embarca pelo chat
// ($embarcar), no canal onde a frota foi lancada. Precisa de fleet.min_casts
// pescas neste barco (casts_here, lido em /expeditions). Mesma regra de pescar
// antes das salas (sem a regra de "1 vaga", que o anuncio nao informa); com
// "embarque imediato", embarca na hora.
//
// Estado: storage "fleet" = { channel, opener, deadlineAt, fishedAt, phase, lastMsg, lastAt }
// ---------------------------------------------------------------------------
const FLEET_ALARM_NAME = "auto-twish-fleet";
let fleetBusy = false;

async function readFleet() {
  const { fleet } = await browser.storage.local.get("fleet");
  return fleet || null;
}
async function fleetLog(msg, { phase, notify } = {}) {
  const cur = (await readFleet()) || {};
  const f = { ...cur, lastMsg: msg, lastAt: Date.now(), ...(phase ? { phase } : {}) };
  await browser.storage.local.set({ fleet: f });
  console.log(`${AT.LOG_PREFIX} [Frota] "${f.channel || "?"}": ${msg}`);
  if (f.channel) {
    await mutateGameState(f.channel, (st) => {
      st.board = { lastMsg: `Frota do Capitão: ${msg}`, lastAt: Date.now() };
    });
    if (phase === "failed" && typeof logActivity === "function") logActivity(f.channel, "expedição", `Frota do Capitão: ${msg}`);
    if (notify) await notifyAutomation(`board-auto:${f.channel}`, `⚓ Frota do Capitão em ${f.channel}`, msg);
  }
}

async function onFleetOpenedChat(channel, info) {
  const general = await getGeneralSettings();
  const s = (await getAllChannelSettings())[channel] || null;
  const cfg = AT.effectiveAutoBoard(s, general);
  if (!cfg.enabled || !cfg.fleet) return;
  if (!s || !s.enabled) {
    console.log(`${AT.LOG_PREFIX} [Frota] "${channel}": ignorada — o canal não está ativado na extensão.`);
    return;
  }
  const cur = await readFleet();
  if (cur && cur.channel === channel && cur.phase === "waiting" && Date.now() < (cur.deadlineAt || 0)) return; // mesma frota
  const seconds = Math.min(Math.max(Number(info.seconds) || 600, 30), 3600);
  await browser.storage.local.set({
    fleet: { channel, opener: info.opener || null, deadlineAt: Date.now() + seconds * 1000, createdAt: Date.now(), fishedAt: null, phase: "waiting" }
  });
  await fleetLog(`frota de @${info.opener || "?"} lançada; vou embarcar.`);
  await browser.alarms.create(FLEET_ALARM_NAME, { when: Date.now() + 1500 + Math.random() * 2500 });
}

async function noteFishForFleet(channel) {
  const f = await readFleet();
  if (!f || f.channel !== channel || f.phase !== "waiting" || f.fishedAt) return;
  await browser.storage.local.set({ fleet: { ...f, fishedAt: Date.now() } });
  await browser.alarms.create(FLEET_ALARM_NAME, { when: Date.now() + BOARD_AFTER_FISH_MS });
}

async function runFleet(source) {
  if (fleetBusy) return;
  fleetBusy = true;
  try {
    const f = await readFleet();
    if (!f || f.phase !== "waiting") return;
    const ch = f.channel;
    const retry = (ms) => browser.alarms.create(FLEET_ALARM_NAME, { when: Date.now() + ms });
    if (safetyLocked) return retry(30000);
    const timeLeft = f.deadlineAt - Date.now();
    if (timeLeft <= 3000) return fleetLog("a frota já zarpou; não deu para embarcar.", { phase: "failed" });
    if ((await twitchTabsForChannel(ch)).length === 0) return fleetLog("a aba do canal na Twitch está fechada.", { phase: "failed" });

    const harbour = await twishApi(`/api/${encodeURIComponent(ch)}/expeditions`);
    const hd = harbour.ok && harbour.data ? harbour.data : null;
    if (hd && hd.mine) return fleetLog("você já está numa expedição.", { phase: "failed" });
    if (hd && hd.boat_enabled === false) return fleetLog(BOARD_ERRORS.expeditions_disabled + ".", { phase: "failed" });
    const minCasts = Number(hd && hd.fleet && hd.fleet.min_casts);
    const casts = Number(hd && hd.casts_here);
    if (Number.isFinite(minCasts) && Number.isFinite(casts) && casts < minCasts) {
      return fleetLog(`faltam pescas neste barco para a frota (${casts}/${minCasts}).`, { phase: "failed" });
    }

    const cfg = AT.effectiveAutoBoard((await getAllChannelSettings())[ch] || null, await getGeneralSettings());
    if (!cfg.immediate && !f.fishedAt && timeLeft > BOARD_MARGIN_MS) {
      const me = await fetchTwishMe(ch);
      const cdMs = me ? parseTwishMe(me).availableAt - Date.now() : null;
      if (cdMs !== null && cdMs + 5000 < timeLeft - BOARD_MARGIN_MS) {
        await fleetLog(`esperando pescar antes de embarcar (pesca em ${AT.formatRemaining(Math.max(0, cdMs))}).`);
        return retry(Math.min(BOARD_POLL_MS, Math.max(5000, timeLeft - BOARD_MARGIN_MS)));
      }
    }

    const r = await enqueueCommand(ch, AT.FLEET_BOARD_COMMAND, { reason: "Frota do Capitão" });
    if (!r.ok) {
      if (timeLeft > 20000) {
        await fleetLog(`falha ao enviar o $embarcar (${r.reason}); tento de novo.`);
        return retry(10000);
      }
      return fleetLog(`falha ao enviar o $embarcar (${r.reason}).`, { phase: "failed" });
    }
    await fleetLog(`embarquei na frota de @${f.opener || "?"} ($embarcar).`, { phase: "done", notify: true });
    if (typeof refreshExpedition === "function") setTimeout(() => refreshExpedition(ch, "frota").catch(() => {}), 8000);
  } catch (e) {
    console.warn(`${AT.LOG_PREFIX} [Frota] Falha:`, e);
    await browser.alarms.create(FLEET_ALARM_NAME, { when: Date.now() + BOARD_POLL_MS });
  } finally {
    fleetBusy = false;
  }
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BOARD_ALARM_NAME) runBoarding("alarme");
  else if (alarm.name === FLEET_ALARM_NAME) runFleet("alarme");
});

browser.runtime.onMessage.addListener((msg, sender) => {
  if (msg?.type === "CHAT_FLEET_OPENED") {
    const channel = extractChannelFromUrl(sender?.tab?.url || "");
    if (channel) onFleetOpenedChat(channel, { opener: String(msg.opener || "").slice(0, 40), seconds: msg.seconds }).catch(() => {});
    return;
  }
  if (msg?.type !== "CHAT_EXPEDITION_OPENED") return;
  const channel = extractChannelFromUrl(sender?.tab?.url || "");
  if (!channel || typeof msg.roomId !== "string" || !/^[0-9a-f-]{36}$/i.test(msg.roomId)) return;
  onExpeditionOpenedChat(channel, {
    roomId: msg.roomId.toLowerCase(),
    sea: String(msg.sea || "").slice(0, 40),
    opener: String(msg.opener || "").slice(0, 40),
    maxCrew: msg.maxCrew,
    minutes: msg.minutes
  });
});
