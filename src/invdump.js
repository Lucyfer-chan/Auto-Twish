// invdump.js — Inv Dump: mantem sempre 1 vaga livre no inventario e 1 em cada
// especie, vendendo os peixes mais baratos pelo chat ($vender <especie> <qtd>).
//
// Depois de cada $pescar (da extensao ou do jogador), le o inventario do barco
// pela conta (/api/{canal}/me/inventory: peixes, precos e capacidade, que ja
// inclui a mochila) e a whitelist (/me). A decisao fica em AT.planInvDump
// (shared.js): primeiro o mais barato entre as especies cheias; sem especie
// cheia e com o inventario cheio, o mais barato no geral. Nunca vende especie
// da whitelist nem raridade a partir do limite escolhido.
// Pelo chat o jogo escolhe QUAL peixe da especie sai (decisao do jogador:
// acoes pelo chat); a extensao escolhe a especie e a quantidade.

const INV_DUMP_ALARM_PREFIX = "auto-twish-invdump:";
const INV_DUMP_DELAY_MS = 8 * 1000; // espera o bot registrar o peixe pescado
const INV_DUMP_ROUNDS = 2; // vende e confere de novo (no maximo)
const invDumpBusy = new Set();

async function invDumpConfig(channel) {
  const general = await getGeneralSettings();
  const s = (await getAllChannelSettings())[channel] || null;
  return AT.effectiveInvDump(s, general);
}

// Agenda uma conferencia do inventario do canal (so se o Inv Dump valer nele).
async function scheduleInvDump(channel, delayMs = INV_DUMP_DELAY_MS) {
  if (!channel || !(await invDumpConfig(channel)).enabled) return;
  await browser.alarms.create(`${INV_DUMP_ALARM_PREFIX}${channel}`, { when: Date.now() + Math.max(1000, delayMs) });
}

async function invDumpLog(channel, msg, { force = false } = {}) {
  const { gameState } = await browser.storage.local.get("gameState");
  const prev = ((gameState || {})[channel] || {}).invDump;
  if (!force && prev && prev.lastMsg === msg) return; // nao repete a mesma mensagem
  console.log(`${AT.LOG_PREFIX} [Inv Dump] "${channel}": ${msg}`);
  await mutateGameState(channel, (st) => {
    st.invDump = { lastMsg: msg, lastAt: Date.now() };
  });
}

async function runInvDump(channel, source) {
  if (invDumpBusy.has(channel)) return;
  invDumpBusy.add(channel);
  try {
    const cfg = await invDumpConfig(channel);
    if (!cfg.enabled || safetyLocked) return;
    if ((await twitchTabsForChannel(channel)).length === 0) return; // sem aba do chat, sem como vender

    for (let round = 0; round < INV_DUMP_ROUNDS; round++) {
      const r = await twishApi(`/api/${encodeURIComponent(channel)}/me/inventory`);
      if (!r.ok || !r.data || !Array.isArray(r.data.fish)) {
        await invDumpLog(channel, "sem leitura do inventário (logado no twish.com.br?); nada vendido.");
        return;
      }
      const me = await fetchTwishMe(channel); // whitelist do barco: sem ela, nao vende nada
      if (!me) {
        await invDumpLog(channel, "sem leitura da whitelist; nada vendido.");
        return;
      }
      const whitelist = new Set((me.data.whitelisted_fish_ids || []).map((x) => String(x).toLowerCase()));
      // A raridade protegida pela Protecao tambem nunca e vendida.
      const prot = AT.effectiveProtection((await getAllChannelSettings())[channel] || null, await getGeneralSettings());
      const keep = AT.minTier(cfg.keepFromTier, prot.enabled ? prot.fromTier : null);
      const plan = AT.planInvDump(r.data, { whitelist, keepFromTier: keep });
      const blocked = plan.blocked.length ? ` Cheia(s) sem o que vender (protegida ou acima do limite): ${plan.blocked.join(", ")}.` : "";

      if (!plan.sells.length) {
        if (round === 0 && blocked) await invDumpLog(channel, `nada a vender.${blocked}`);
        return;
      }
      const done = [];
      for (const x of plan.sells) {
        const c = await enqueueCommand(channel, `${AT.SELL_COMMAND} ${x.id} ${x.qty}`, {
          reason: `Inv Dump (inventário ${plan.total}/${plan.capTotal}, até ${plan.capSpecies} por espécie)`
        });
        if (!c.ok) {
          await invDumpLog(channel, `falha ao enviar ${AT.SELL_COMMAND} ${x.id} ${x.qty} (${c.reason}).`, { force: true });
          return;
        }
        done.push(`${x.qty}x ${x.id}`);
      }
      const msg = `vendi ${done.join(", ")} (inventário estava ${plan.total}/${plan.capTotal}; até ${plan.capSpecies} por espécie).${blocked}`;
      await invDumpLog(channel, msg, { force: true });
      await notifyAutomation(`invdump-auto:${channel}`, `🎒 Inv Dump em ${channel}`, `Vendi ${done.join(", ")}.`);
      await sleep(5000); // o bot registra a venda; confere de novo
    }
  } catch (e) {
    console.warn(`${AT.LOG_PREFIX} [Inv Dump] Falha em "${channel}":`, e);
  } finally {
    invDumpBusy.delete(channel);
  }
}

// Mudou a configuracao: confere logo os canais afetados.
function onInvDumpSettingsChanged(channel) {
  (async () => {
    const names = channel ? [channel] : Object.keys(await getAllChannelSettings());
    for (const ch of names) await scheduleInvDump(ch, 2000);
  })().catch((e) => console.warn(`${AT.LOG_PREFIX} [Inv Dump] Falha ao aplicar a configuração:`, e));
}

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name.startsWith(INV_DUMP_ALARM_PREFIX)) runInvDump(alarm.name.slice(INV_DUMP_ALARM_PREFIX.length), "depois de pescar");
});
