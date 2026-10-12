// remedy.js — Remedios automaticos para os efeitos ruins da expedicao.
//
// Canto da Sereia (active.siren_remaining) e Maldicao (active.curse_remaining)
// sao efeitos por barco, lidos de /api/{canal}/me. Com um deles ativo, usa o
// remedio do inventario do barco — Alga medicinal (sereia) ou Agua benta
// (maldicao) — pela API do site (POST /me/use/{item}, o mesmo "usar" ja
// liberado para ativar itens). Sem o remedio, compra pelo chat ($comprar) se
// a opcao estiver ligada.
// Confere: depois de cada pesca, a cada 10 min e logo depois que uma expedicao termina.

const REMEDY_ALARM_PREFIX = "auto-twish-remedy:";
const REMEDY_PERIOD_ALARM = "auto-twish-remedy-period";
const REMEDY_AFTER_CATCH_MS = 15000;
const REMEDY_AFTER_EXPEDITION_MS = 75 * 1000; // o acerto da viagem sai ~60 s depois do fim
const remedyBusy = new Set();

async function remedyConfig(channel) {
  const general = await getGeneralSettings();
  const s = (await getAllChannelSettings())[channel] || null;
  return AT.effectiveAutoRemedy(s, general);
}

async function scheduleRemedy(channel, delayMs = REMEDY_AFTER_CATCH_MS) {
  if (!channel || !(await remedyConfig(channel)).enabled) return;
  const name = `${REMEDY_ALARM_PREFIX}${channel}`;
  const when = Date.now() + Math.max(1000, delayMs);
  const existing = await browser.alarms.get(name);
  if (existing && existing.scheduledTime > Date.now() && existing.scheduledTime <= when) return;
  await browser.alarms.create(name, { when });
}

async function runRemedy(channel, source) {
  if (remedyBusy.has(channel)) return;
  remedyBusy.add(channel);
  try {
    const cfg = await remedyConfig(channel);
    if (!cfg.enabled || safetyLocked) return;
    const me = await fetchTwishMe(channel);
    if (!me) return;
    const active = me.data.active || {};
    const items = (me.data.owned && me.data.owned.items) || {};
    for (const key of ["siren", "curse"]) {
      if (!cfg[key]) continue;
      const r = AT.REMEDIES[key];
      const left = Number(active[r.field]) || 0;
      if (left <= 0) continue;
      let have = Number(items[r.item]) || 0;
      if (have <= 0) {
        if (!cfg.buy) {
          await remedyLog(channel, `${r.effect} ativo (${AT.formatRemaining(left * 1000)}), mas sem ${r.name} no inventário (compra desligada).`);
          continue;
        }
        if ((await twitchTabsForChannel(channel)).length === 0) continue; // compra e pelo chat
        const b = await enqueueCommand(channel, `${AT.BUY_COMMAND} ${r.item}`, { reason: `remédio (${r.effect})` });
        if (!b.ok) {
          await remedyLog(channel, `falha ao comprar ${r.name} (${b.reason}).`);
          continue;
        }
        await sleep(3000);
        have = 1;
      }
      const u = await useItem(channel, r.item);
      if (u.ok) {
        const msg = `${r.effect} curado com ${r.name}.`;
        await remedyLog(channel, msg);
        await notifyAutomation(`remedy-auto:${channel}`, `🧪 Remédio em ${channel}`, msg);
      } else {
        await remedyLog(channel, `o site não usou ${r.name} (${u.error}).`);
      }
    }
  } catch (e) {
    console.warn(`${AT.LOG_PREFIX} [Remédios] Falha em "${channel}":`, e);
  } finally {
    remedyBusy.delete(channel);
  }
}

async function remedyLog(channel, msg) {
  const { gameState } = await browser.storage.local.get("gameState");
  const prev = ((gameState || {})[channel] || {}).remedy;
  if (prev && prev.lastMsg === msg && Date.now() - prev.lastAt < 30 * 60 * 1000) return;
  console.log(`${AT.LOG_PREFIX} [Remédios] "${channel}": ${msg}`);
  await mutateGameState(channel, (st) => {
    st.remedy = { lastMsg: msg, lastAt: Date.now() };
  });
}

// Uma expedicao terminou: os efeitos ruins chegam no acerto — confere os canais.
async function onExpeditionEnded(boat) {
  const names = Object.keys(await getAllChannelSettings());
  for (const ch of names) await scheduleRemedy(ch, REMEDY_AFTER_EXPEDITION_MS);
}

async function updateRemedyAlarm() {
  const general = await getGeneralSettings();
  const any = Object.values(await getAllChannelSettings()).some((s) => AT.effectiveAutoRemedy(s, general).enabled);
  const existing = await browser.alarms.get(REMEDY_PERIOD_ALARM);
  if (any && !existing) await browser.alarms.create(REMEDY_PERIOD_ALARM, { periodInMinutes: 10 });
  else if (!any && existing) await browser.alarms.clear(REMEDY_PERIOD_ALARM);
}

function onRemedySettingsChanged(channel) {
  (async () => {
    await updateRemedyAlarm();
    const names = channel ? [channel] : Object.keys(await getAllChannelSettings());
    for (const ch of names) await scheduleRemedy(ch, 2000);
  })().catch((e) => console.warn(`${AT.LOG_PREFIX} [Remédios] Falha ao aplicar a configuração:`, e));
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith(REMEDY_ALARM_PREFIX)) runRemedy(alarm.name.slice(REMEDY_ALARM_PREFIX.length), "alarme");
  else if (alarm.name === REMEDY_PERIOD_ALARM) {
    (async () => {
      for (const ch of Object.keys(await getAllChannelSettings())) await runRemedy(ch, "a cada 10 min");
    })();
  }
});

updateRemedyAlarm().catch(() => {});
