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
  const b = await readBoarding();
  if (!b || b.channel !== channel || b.phase !== "waiting" || b.fishedAt) return;
  await saveBoarding((x) => {
    x.fishedAt = Date.now();
  });
  await scheduleBoarding(BOARD_AFTER_FISH_MS);
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

    // Pescar antes?
    const timeLeft = b.deadlineAt - Date.now();
    if (!b.fishedAt && free > 1 && timeLeft > BOARD_MARGIN_MS) {
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
    if (seaInfo && Number(seaInfo.entry_owned) < Number(seaInfo.entry_quantity || 1)) {
      const cfg = AT.effectiveAutoBoard((await getAllChannelSettings())[ch] || null, await getGeneralSettings());
      const canBuy = cfg.seas[b.sea] && cfg.seas[b.sea].buy && b.sea !== "fenda" && AT.cleanItemId(seaInfo.entry_item_id);
      if (!canBuy) {
        await boardLog(`${BOARD_ERRORS.no_ticket} (${seaInfo.entry_item_name || seaInfo.entry_item_id}).`, { phase: "failed" });
        return;
      }
      const buy = await enqueueCommand(ch, `${AT.BUY_COMMAND} ${seaInfo.entry_item_id}`, { reason: "ticket da expedição" });
      if (!buy.ok) {
        await boardLog(`falha ao comprar o ticket (${buy.reason}).`, { phase: "failed" });
        return;
      }
      await sleep(3000);
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

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === BOARD_ALARM_NAME) runBoarding("alarme");
});

browser.runtime.onMessage.addListener((msg, sender) => {
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
