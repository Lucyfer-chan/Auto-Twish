// protection.js — Protecao automatica (Road Map item 7).
//
// Mantem as especies escolhidas na whitelist do jogo, em cada barco (a
// whitelist do Twish e por canal). Le a whitelist atual pela conta
// (GET /api/{canal}/me/whitelist) e manda "$whitelist <id>" no chat so para
// o que estiver faltando. So ADICIONA: tirar uma especie da lista da extensao
// nao a remove do jogo.
//
// Por raridade (fromTier): protege tambem as especies do inventario do barco
// (/api/{canal}/me/inventory) daquela raridade em diante — as que o jogador ja
// tem e as que forem chegando (confere ~6 s depois de cada $pescar).
//
// Quando confere: ao mudar as configuracoes, a cada 30 min, logo antes da
// Venda Turbinada vender tudo e (com raridade) depois de cada pesca.
// Estado por canal em gameState[canal].whitelist:
//   { checkedAt, via: "api"|"local", ids, missing, failed: {id: n}, localIds, lastMsg }

const PROTECT_ALARM_NAME = "auto-twish-protect";
const PROTECT_INTERVAL_MINUTES = 30;
const PROTECT_VERIFY_DELAY_MS = 3000; // espera o bot registrar antes de reler (nao atrasa os envios)
const PROTECT_MAX_FAILS = 2; // id que o jogo nao aceitou 2x seguidas para de ser enviado
const protectingNow = new Set();
const protectRerun = new Set(); // mudou a lista durante uma conferencia: confere de novo logo em seguida
const PROTECT_CATCH_PREFIX = "auto-twish-protect-catch:";
const PROTECT_AFTER_CATCH_MS = 6000; // antes do Inv Dump (8 s)

// Especies do inventario do barco desta raridade em diante: [{ id, name }] ou null (sem leitura).
async function inventorySpeciesFromTier(channel, fromTier) {
  const r = await twishApi(`/api/${encodeURIComponent(channel)}/me/inventory`);
  if (!r.ok || !r.data || !Array.isArray(r.data.fish)) return null;
  const min = AT.tierRank(fromTier);
  const out = new Map();
  for (const st of r.data.fish) {
    const id = String((st && (st.fish_id || st.id)) || "").toLowerCase();
    if (!AT.FISH_ID_RE.test(id) || st.tier === "ancient_god") continue;
    const rank = AT.tierRank(st.tier);
    if (rank < 0 || rank < min) continue;
    if (!out.has(id)) out.set(id, { id, name: typeof st.name === "string" && st.name ? st.name : id, tier: st.tier });
  }
  return [...out.values()];
}

// Depois de uma pesca: com protecao por raridade, confere logo (peixe novo).
async function scheduleProtectAfterCatch(channel) {
  if (!channel) return;
  const cfg = await protectionConfigFor(channel);
  if (!AT.protectionActive(cfg) || !cfg.fromTier) return;
  await browser.alarms.create(`${PROTECT_CATCH_PREFIX}${channel}`, { when: Date.now() + PROTECT_AFTER_CATCH_MS });
}

// Le a whitelist do barco pela conta. null = sem login/sem resposta.
async function readGameWhitelist(channel) {
  const r = await twishApi(`/api/${encodeURIComponent(channel)}/me/whitelist`);
  if (!r.ok || !r.data) return null;
  const arr = Array.isArray(r.data) ? r.data : r.data.whitelist;
  if (!Array.isArray(arr)) return null;
  return arr.map((x) => (typeof x === "string" ? x : x && (x.id || x.fish_id))).filter((x) => typeof x === "string");
}

async function protectionConfigFor(channel) {
  const general = await getGeneralSettings();
  const s = (await getAllChannelSettings())[channel] || null;
  return AT.effectiveProtection(s, general);
}

async function saveProtectionStatus(channel, patch) {
  await mutateGameState(channel, (st) => {
    st.whitelist = { ...(st.whitelist || {}), ...patch };
  });
}

// Confere um canal e manda o que falta. Devolve um resumo (ou null se pulou).
async function syncProtection(channel, source) {
  if (protectingNow.has(channel)) {
    protectRerun.add(channel);
    return null;
  }
  protectingNow.add(channel);
  try {
    const cfg = await protectionConfigFor(channel);
    if (!AT.protectionActive(cfg)) return null;
    if (safetyLocked) return null;

    // Alvos: a lista + (com raridade) as especies do inventario dessa raridade em diante.
    const targets = [...cfg.fish];
    let tierNote = "";
    if (cfg.fromTier) {
      const inv = await inventorySpeciesFromTier(channel, cfg.fromTier);
      if (!inv) tierNote = ` (sem leitura do inventário: raridade ${AT.TIER_LABELS[cfg.fromTier]}+ não conferida)`;
      else for (const f of inv) if (!targets.some((x) => x.id === f.id)) targets.push({ id: f.id, name: f.name });
    }
    if (!targets.length) {
      await saveProtectionStatus(channel, { checkedAt: Date.now(), missing: [], lastMsg: `Nada a proteger agora${cfg.fromTier ? ` (nenhum peixe ${AT.TIER_LABELS[cfg.fromTier]}+ no inventário)` : ""}.${tierNote}` });
      return { channel, sent: [], missing: [] };
    }

    const { gameState } = await browser.storage.local.get("gameState");
    const prev = ((gameState || {})[channel] || {}).whitelist || {};
    const failed = { ...(prev.failed || {}) };

    let current = await readGameWhitelist(channel);
    const via = current ? "api" : "local";
    if (!current) current = prev.localIds || []; // sem conta: confia no que ja foi enviado daqui

    const wanted = targets.filter((f) => (failed[f.id] || 0) < PROTECT_MAX_FAILS);
    const missing = wanted.filter((f) => !current.includes(f.id));

    if (missing.length && (await twitchTabsForChannel(channel)).length === 0) {
      const msg = `${missing.length === 1 ? "Falta 1 espécie" : `Faltam ${missing.length} espécies`} na whitelist, mas a aba do canal na Twitch está fechada.`;
      await saveProtectionStatus(channel, { checkedAt: Date.now(), via, ids: current, missing: missing.map((f) => f.id), failed, lastMsg: msg });
      console.log(`${AT.LOG_PREFIX} (${source}) Protecao em "${channel}": ${msg}`);
      return { channel, sent: [], missing: missing.map((f) => f.id) };
    }

    const sent = [];
    for (const f of missing) {
      const r = await enqueueCommand(channel, `${AT.WHITELIST_COMMAND} ${f.id}`, { reason: `Proteção (${source})`, gap: false });
      if (!r.ok) break;
      sent.push(f.id);
    }

    let after = current;
    let localIds = prev.localIds || [];
    // Espera o bot registrar antes de reler — mas, se a lista mudou nesse meio
    // tempo, para de esperar: a nova conferencia sai na hora e rele tudo.
    let interrupted = false;
    if (via === "api" && sent.length) {
      for (let t = 0; t < PROTECT_VERIFY_DELAY_MS; t += 100) {
        if (protectRerun.has(channel)) {
          interrupted = true;
          break;
        }
        await sleep(100);
      }
    }
    if (interrupted) {
      after = [...current, ...sent];
    } else if (via === "api" && sent.length) {
      after = (await readGameWhitelist(channel)) || [...current, ...sent];
      for (const id of sent) {
        if (after.includes(id)) delete failed[id];
        else failed[id] = (failed[id] || 0) + 1;
      }
    } else if (via === "local") {
      localIds = [...new Set([...localIds, ...sent])];
      after = localIds;
    }
    if (via === "api") localIds = after;

    const stillMissing = targets.filter((f) => !after.includes(f.id)).map((f) => f.id);
    const refused = targets.filter((f) => (failed[f.id] || 0) >= PROTECT_MAX_FAILS).map((f) => f.id);
    const nameOf = (id) => (targets.find((f) => f.id === id) || { name: id }).name;
    let msg;
    if (!stillMissing.length) msg = targets.length === 1 ? `${nameOf(targets[0].id)} está protegida.` : `Todas as ${targets.length} espécies protegidas.`;
    else if (refused.length && refused.length === stillMissing.length) msg = `O jogo não aceitou: ${refused.map(nameOf).join(", ")} (confira se o id existe no jogo).`;
    else msg = `Faltam: ${stillMissing.map(nameOf).join(", ")}.`;
    if (via === "local") msg += " (sem leitura da conta: baseado no que a extensão já enviou)";
    msg += tierNote;

    await saveProtectionStatus(channel, { checkedAt: Date.now(), via, ids: after, missing: stillMissing, failed, localIds, lastMsg: msg });
    console.log(`${AT.LOG_PREFIX} (${source}) Protecao em "${channel}": enviados [${sent.join(", ")}]. ${msg}`);
    if (sent.length) {
      await notifyAutomation(`protect-auto:${channel}`, `🔒 Proteção em ${channel}`, `Enviei ${AT.WHITELIST_COMMAND} para: ${sent.map(nameOf).join(", ")}.`);
    }
    return { channel, sent, missing: stillMissing };
  } finally {
    protectingNow.delete(channel);
    if (protectRerun.delete(channel)) {
      syncProtection(channel, source).catch((e) => console.warn(`${AT.LOG_PREFIX} Falha na protecao de "${channel}":`, e));
    }
  }
}

async function anyProtectionActive() {
  const general = await getGeneralSettings();
  const channels = await getAllChannelSettings();
  return Object.values(channels).some((s) => {
    const cfg = AT.effectiveProtection(s, general);
    return AT.protectionActive(cfg);
  });
}

async function updateProtectionAlarm() {
  const any = await anyProtectionActive();
  const existing = await browser.alarms.get(PROTECT_ALARM_NAME);
  if (any && !existing) await browser.alarms.create(PROTECT_ALARM_NAME, { periodInMinutes: PROTECT_INTERVAL_MINUTES });
  else if (!any && existing) await browser.alarms.clear(PROTECT_ALARM_NAME);
}

async function syncAllProtection(source) {
  const channels = Object.keys(await getAllChannelSettings());
  for (const channel of channels) {
    try {
      await syncProtection(channel, source);
    } catch (e) {
      console.warn(`${AT.LOG_PREFIX} Falha na protecao de "${channel}":`, e);
    }
  }
}

// Chamado pelo background.js quando a configuracao muda (channel null = geral).
function onProtectionSettingsChanged(channel) {
  (async () => {
    await updateProtectionAlarm();
    if (channel) await syncProtection(channel, "configuração");
    else await syncAllProtection("configuração");
  })().catch((e) => console.warn(`${AT.LOG_PREFIX} Falha ao aplicar a protecao:`, e));
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === PROTECT_ALARM_NAME) syncAllProtection("a cada 30 min");
  else if (alarm.name.startsWith(PROTECT_CATCH_PREFIX)) syncProtection(alarm.name.slice(PROTECT_CATCH_PREFIX.length), "depois de pescar");
});

browser.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  // Configuracoes: "Conferir agora" de um canal.
  if (msg?.type === "SYNC_PROTECTION_NOW") {
    (async () => {
      const r = await syncProtection(msg.channel, "manual");
      sendResponse({ ok: true, result: r });
    })();
    return true;
  }
  return false;
});

updateProtectionAlarm().catch(() => {});
