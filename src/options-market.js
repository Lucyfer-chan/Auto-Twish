// options-market.js — secao "Mercado" da pagina de configuracoes e aviso da
// trava de seguranca. Tudo e aplicado na hora.

(() => {
  const el = (id) => document.getElementById(id);
  const enabledEl = el("marketEnabled");
  const boatEl = el("marketBoat");
  const intervalEl = el("marketInterval");
  const notifyEl = el("marketNotify");
  const listEl = el("acqList");
  const fishOptionsEl = el("fishOptions");
  const statusEl = el("marketStatus");
  const runStatusEl = el("marketRunStatus");

  let list = [];
  let species = []; // [{id, name, tier, min_kg, max_kg}]

  const send = (msg) => browser.runtime.sendMessage(msg);
  const fmtTime = (t) => (t ? new Date(t).toLocaleTimeString() : "—");

  // ---------------------------------------------------------------- trava
  async function renderSafety() {
    try {
      const { safety } = await send({ type: "GET_SAFETY" });
      el("safetyBanner").hidden = !(safety && safety.locked);
    } catch (e) {}
  }

  // ---------------------------------------------------------------- especies
  function fishIdFromInput(text) {
    const t = String(text || "").trim().toLowerCase();
    if (!t) return null;
    const exact = species.find((f) => f.name.toLowerCase() === t || f.id === t);
    return exact ? exact : null;
  }

  async function loadSpecies(boat) {
    try {
      const { list: l } = await send({ type: "GET_BESTIARY", boat });
      species = (l || []).slice().sort((a, b) => a.name.localeCompare(b.name));
    } catch (e) {
      species = [];
    }
    fishOptionsEl.innerHTML = "";
    for (const f of species) {
      const o = document.createElement("option");
      o.value = f.name;
      o.label = `${({ common: "comum", uncommon: "incomum", rare: "raro", legendary: "lendário", mythic: "mítico", secret: "secreto", divine: "divino" })[f.tier] || f.tier || ""} · ${f.min_kg}–${f.max_kg} kg`;
      fishOptionsEl.appendChild(o);
    }
  }

  // ---------------------------------------------------------------- lista
  // Raridades como o site mostra em portugues.
  const TIER_PT = { common: "comum", uncommon: "incomum", rare: "raro", legendary: "lendário", mythic: "mítico", secret: "secreto", divine: "divino" };

  function speciesInfo(f) {
    return f ? `${TIER_PT[f.tier] || f.tier || ""} · ${f.min_kg}–${f.max_kg} kg` : "";
  }

  // Aceita virgula ou ponto; vazio/invalido -> NaN.
  function parseNum(s) {
    const t = String(s ?? "").trim().replace(",", ".");
    if (!t) return NaN;
    const n = Number(t);
    return Number.isFinite(n) && n >= 0 ? n : NaN;
  }

  const fmt = (n) => (Number.isFinite(n) ? String(n).replace(".", ",") : "?");

  async function save() {
    const res = await send({ type: "SAVE_ACQUISITION_LIST", list });
    list = res.list || list;
  }

  // ---------------------------------------------------------------- lista (resumo)
  function renderList() {
    listEl.innerHTML = "";
    if (!list.length) {
      const p = document.createElement("div");
      p.className = "acq-empty";
      p.textContent = "Nenhum peixe na lista ainda. Clique em \"Adicionar peixe\".";
      listEl.appendChild(p);
      return;
    }
    list.forEach((entry, idx) => {
      const f = species.find((x) => x.id === entry.fishId);
      const card = document.createElement("div");
      card.className = "acq-card" + (entry.enabled ? "" : " off");
      const row = document.createElement("div");
      row.className = "acq-summary";

      const text = document.createElement("div");
      text.className = "acq-text";
      const name = document.createElement("strong");
      name.textContent = entry.fishName || entry.fishId || "(sem peixe)";
      text.append(name, f ? `  ${speciesInfo(f)}` : "");
      const qty = Number.isFinite(entry.quantity) && entry.quantity >= 1 ? entry.quantity : null;
      const got = entry.bought || 0;
      const done = qty !== null && got >= qty;
      const progress = document.createElement("div");
      progress.textContent = qty !== null ? `Comprados ${got} de ${qty}${done ? " — concluído ✓" : ""}` : `Comprados ${got} (sem limite — até acabar as moedas)`;
      if (done) progress.style.color = "var(--ok)";
      const crit = document.createElement("div");
      crit.textContent =
        `Peso ≥ ${fmt(entry.minKg)} kg · até ${fmt(entry.maxPrice)} · ` +
        `abaixo de 95%: até ${fmt(entry.maxPriceBelow95)} com % ≥ ${fmt(entry.minPct)}`;
      text.appendChild(crit);
      text.appendChild(progress);
      if (done) card.classList.add("off");
      if (!AT.isValidAcquisition(entry)) {
        const warn = document.createElement("div");
        warn.style.color = "var(--warn)";
        warn.textContent = "Incompleto — clique em Editar para corrigir (fica fora das compras).";
        text.appendChild(warn);
      }

      const activeLabel = document.createElement("label");
      activeLabel.className = "acq-active";
      const active = document.createElement("input");
      active.type = "checkbox";
      active.className = "switch";
      active.checked = !!entry.enabled;
      active.addEventListener("change", async () => {
        list[idx] = { ...list[idx], enabled: active.checked };
        await save();
        renderList();
      });
      activeLabel.append(active, "Ativo");

      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "btn secondary acq-remove";
      edit.textContent = "Editar";
      edit.addEventListener("click", () => openForm(idx));

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "btn danger acq-remove";
      remove.textContent = "Remover";
      remove.addEventListener("click", async () => {
        list.splice(idx, 1);
        if (editingIndex === idx) closeForm();
        await save();
        renderList();
      });

      const extra = [];
      if (got > 0) {
        const reset = document.createElement("button");
        reset.type = "button";
        reset.className = "btn secondary acq-remove";
        reset.textContent = "Recomeçar";
        reset.title = "Zera a contagem de comprados";
        reset.addEventListener("click", async () => {
          list[idx] = { ...list[idx], bought: 0 };
          await save();
          renderList();
        });
        extra.push(reset);
      }

      row.append(text, activeLabel, edit, ...extra, remove);
      card.appendChild(row);
      listEl.appendChild(card);
    });
  }

  // ---------------------------------------------------------------- formulario
  const form = el("acqForm");
  const fFish = el("f-fish");
  const fFishHint = el("f-fish-hint");
  const fMinKg = el("f-minKg");
  const fMinPct = el("f-minPct");
  const fMaxPrice = el("f-maxPrice");
  const fMaxBelow = el("f-maxBelow");
  const fEnabled = el("f-enabled");
  const fQuantity = el("f-quantity");
  const fError = el("acqFormError");
  let editingIndex = null; // null = adicionando

  function updateFishHint() {
    const f = fishIdFromInput(fFish.value);
    fFishHint.textContent = f ? speciesInfo(f) : fFish.value.trim() ? "peixe não encontrado — escolha um da lista de sugestões" : "escolha um peixe da lista de sugestões";
    fFish.classList.toggle("invalid", !!fFish.value.trim() && !f);
  }
  fFish.addEventListener("input", updateFishHint);

  function openForm(idx = null) {
    editingIndex = idx;
    const e = idx === null ? null : list[idx];
    el("acqFormTitle").textContent = idx === null ? "Adicionar peixe" : `Editar ${e.fishName || "peixe"}`;
    el("acqConfirm").textContent = idx === null ? "Confirmar e adicionar" : "Salvar alterações";
    fFish.value = e ? e.fishName || "" : "";
    fMinKg.value = e && Number.isFinite(e.minKg) ? fmt(e.minKg) : "";
    fMinPct.value = e && Number.isFinite(e.minPct) ? fmt(e.minPct) : "";
    fMaxPrice.value = e && Number.isFinite(e.maxPrice) ? fmt(e.maxPrice) : "";
    fMaxBelow.value = e && Number.isFinite(e.maxPriceBelow95) ? fmt(e.maxPriceBelow95) : "";
    fEnabled.checked = e ? !!e.enabled : true;
    fQuantity.value = e && Number.isFinite(e.quantity) && e.quantity >= 1 ? String(e.quantity) : "";
    for (const i of [fFish, fMinKg, fMinPct, fMaxPrice, fMaxBelow, fQuantity]) i.classList.remove("invalid");
    fError.textContent = "";
    updateFishHint();
    form.hidden = false;
    el("acqAdd").hidden = true;
    fFish.focus();
  }

  function closeForm() {
    form.hidden = true;
    editingIndex = null;
    el("acqAdd").hidden = false;
  }

  // Le e valida tudo SO no clique de confirmar.
  async function confirmForm() {
    const f = fishIdFromInput(fFish.value);
    const values = {
      minKg: parseNum(fMinKg.value),
      minPct: parseNum(fMinPct.value),
      maxPrice: parseNum(fMaxPrice.value),
      maxPriceBelow95: parseNum(fMaxBelow.value)
    };
    const problems = [];
    fFish.classList.toggle("invalid", !f);
    if (!f) problems.push("escolha um peixe da lista de sugestões");
    const labels = { minKg: [fMinKg, "peso mínimo"], minPct: [fMinPct, "% mínima"], maxPrice: [fMaxPrice, "valor máximo"], maxPriceBelow95: [fMaxBelow, "valor máx. abaixo de 95%"] };
    for (const [k, [input, label]] of Object.entries(labels)) {
      const bad = !Number.isFinite(values[k]);
      input.classList.toggle("invalid", bad);
      if (bad) problems.push(label);
    }
    if (Number.isFinite(values.minPct) && values.minPct > 100) {
      fMinPct.classList.add("invalid");
      problems.push("% mínima acima de 100");
    }
    const qText = fQuantity.value.trim();
    const quantity = qText === "" ? null : Number(qText);
    const badQty = quantity !== null && !(Number.isInteger(quantity) && quantity >= 1);
    fQuantity.classList.toggle("invalid", badQty);
    if (badQty) problems.push("quantidade (número inteiro, 1 ou mais, ou vazio)");
    if (problems.length) {
      fError.textContent = `Confira: ${problems.join(", ")}. Use números (vírgula ou ponto).`;
      return;
    }

    const entry = {
      ...(editingIndex !== null ? list[editingIndex] : {}),
      fishId: f.id,
      fishName: f.name,
      ...values,
      quantity,
      enabled: fEnabled.checked
    };
    if (editingIndex === null) list.push(entry);
    else list[editingIndex] = entry;
    await save();
    closeForm();
    renderList();
  }

  el("acqConfirm").addEventListener("click", confirmForm);
  el("acqCancel").addEventListener("click", closeForm);
  form.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") confirmForm();
    if (ev.key === "Escape") closeForm();
  });

  // ---------------------------------------------------------------- status
  function renderStatus(state) {
    const st = state || {};
    statusEl.innerHTML = "";
    const line = document.createElement("div");
    line.append("Última verificação: ");
    const b = document.createElement("strong");
    b.textContent = fmtTime(st.lastRunAt);
    line.append(b, ` · verificações: ${st.cycles || 0}`);
    statusEl.appendChild(line);
    if (st.lastMsg) {
      const m = document.createElement("div");
      m.textContent = st.lastMsg;
      statusEl.appendChild(m);
    }
    if (st.purchases && st.purchases.length) {
      const title = document.createElement("div");
      title.textContent = "Compras recentes:";
      statusEl.appendChild(title);
      const ul = document.createElement("ul");
      ul.className = "purchases";
      for (const p of st.purchases.slice(0, 8)) {
        const li = document.createElement("li");
        li.textContent = `${new Date(p.at).toLocaleString()} — ${p.fish} ${p.weight} kg (${p.pct}%) por ${p.price} (de ${p.seller})`;
        ul.appendChild(li);
      }
      statusEl.appendChild(ul);
    }
  }

  function renderSettings(market, boats, boat) {
    enabledEl.checked = !!market.enabled;
    if (document.activeElement !== intervalEl) intervalEl.value = market.intervalSeconds;
    notifyEl.checked = !!market.notifyPurchases;
    boatEl.innerHTML = "";
    if (!boats.length) {
      const o = document.createElement("option");
      o.textContent = "(configure um canal primeiro)";
      o.value = "";
      boatEl.appendChild(o);
    }
    for (const name of boats) {
      const o = document.createElement("option");
      o.value = name;
      o.textContent = name;
      boatEl.appendChild(o);
    }
    boatEl.value = boat || "";
  }

  async function load() {
    const r = await send({ type: "GET_MARKET" });
    renderSettings(r.market, r.boats || [], r.boat);
    list = r.list || [];
    await loadSpecies(r.boat);
    renderList();
    renderStatus(r.state);
    renderSafety();
  }

  // ---------------------------------------------------------------- eventos
  const updateMarket = async (patch) => {
    const r = await send({ type: "UPDATE_MARKET_SETTINGS", patch });
    enabledEl.checked = !!r.market.enabled;
  };
  enabledEl.addEventListener("change", () => updateMarket({ enabled: enabledEl.checked }));
  notifyEl.addEventListener("change", () => updateMarket({ notifyPurchases: notifyEl.checked }));
  intervalEl.addEventListener("change", async () => {
    const v = AT.clampMarketInterval(intervalEl.value);
    intervalEl.value = v;
    await updateMarket({ intervalSeconds: v });
  });
  boatEl.addEventListener("change", async () => {
    await updateMarket({ boat: boatEl.value || null });
    await loadSpecies(boatEl.value);
    renderList();
  });

  el("acqAdd").addEventListener("click", () => openForm(null));

  el("marketRun").addEventListener("click", async () => {
    const btn = el("marketRun");
    btn.disabled = true;
    runStatusEl.textContent = enabledEl.checked ? "Verificando…" : "Simulando (aquisição desligada)…";
    const r = await send({ type: "RUN_MARKET_NOW" });
    renderStatus(r.state);
    runStatusEl.textContent = "";
    btn.disabled = false;
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.marketState) renderStatus(changes.marketState.newValue);
    if (changes.acquisitionList) {
      list = changes.acquisitionList.newValue || [];
      renderList();
    }
    if (changes.safety) renderSafety();
    if (changes.general) {
      const g = AT.mergeGeneral(changes.general.newValue);
      enabledEl.checked = !!g.market.enabled;
      notifyEl.checked = !!g.market.notifyPurchases;
    }
  });

  load();
})();
