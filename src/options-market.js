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
  let saveTimer = null;

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
      o.label = `${f.tier || ""} · ${f.min_kg}–${f.max_kg} kg`;
      fishOptionsEl.appendChild(o);
    }
  }

  // ---------------------------------------------------------------- lista
  function numInput(value, step, cls) {
    const i = document.createElement("input");
    i.type = "number";
    i.min = "0";
    i.step = step;
    if (cls) i.className = cls;
    i.value = Number.isFinite(value) ? value : "";
    return i;
  }

  function scheduleSave() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 400);
  }

  async function save() {
    const res = await send({ type: "SAVE_ACQUISITION_LIST", list });
    list = res.list || list;
  }

  function renderList() {
    listEl.innerHTML = "";
    if (!list.length) {
      const p = document.createElement("div");
      p.className = "hint";
      p.textContent = "Nenhum peixe na lista ainda. Clique em \"Adicionar peixe\".";
      listEl.appendChild(p);
      return;
    }
    list.forEach((entry, idx) => {
      const row = document.createElement("div");
      row.className = "acq-row";

      const fish = document.createElement("input");
      fish.type = "text";
      fish.className = "fish";
      fish.setAttribute("list", "fishOptions");
      fish.placeholder = "nome do peixe";
      fish.value = entry.fishName || entry.fishId || "";
      const markFish = () => fish.classList.toggle("invalid", !fishIdFromInput(fish.value));
      fish.addEventListener("change", () => {
        const f = fishIdFromInput(fish.value);
        entry.fishId = f ? f.id : "";
        entry.fishName = f ? f.name : fish.value.trim();
        if (f) fish.title = `${f.min_kg}–${f.max_kg} kg`;
        markFish();
        scheduleSave();
      });

      const fields = [
        ["minKg", numInput(entry.minKg, "0.01")],
        ["minPct", numInput(entry.minPct, "0.1")],
        ["maxPrice", numInput(entry.maxPrice, "1")],
        ["maxPriceBelow95", numInput(entry.maxPriceBelow95, "1")]
      ];
      for (const [key, input] of fields) {
        const mark = () => input.classList.toggle("invalid", !(input.value !== "" && Number(input.value) >= 0));
        input.addEventListener("change", () => {
          entry[key] = input.value === "" ? NaN : Number(input.value);
          mark();
          scheduleSave();
        });
        mark();
      }

      const activeWrap = document.createElement("span");
      activeWrap.className = "center";
      const active = document.createElement("input");
      active.type = "checkbox";
      active.checked = !!entry.enabled;
      active.title = "Ativo";
      active.addEventListener("change", () => {
        entry.enabled = active.checked;
        scheduleSave();
      });
      activeWrap.appendChild(active);

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "icon-btn";
      remove.textContent = "✕";
      remove.title = "Remover da lista";
      remove.addEventListener("click", () => {
        list.splice(idx, 1);
        renderList();
        scheduleSave();
      });

      row.append(fish, ...fields.map(([, i]) => i), activeWrap, remove);
      listEl.appendChild(row);
      if (species.length) markFish();
    });
  }

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

  el("acqAdd").addEventListener("click", () => {
    list.push({ fishId: "", fishName: "", minKg: NaN, minPct: NaN, maxPrice: NaN, maxPriceBelow95: NaN, enabled: true });
    renderList();
    const inputs = listEl.querySelectorAll(".fish");
    if (inputs.length) inputs[inputs.length - 1].focus();
  });

  el("marketRun").addEventListener("click", async () => {
    const btn = el("marketRun");
    btn.disabled = true;
    runStatusEl.textContent = enabledEl.checked ? "Verificando…" : "Simulando (aquisição desligada)…";
    clearTimeout(saveTimer);
    await save();
    const r = await send({ type: "RUN_MARKET_NOW" });
    renderStatus(r.state);
    runStatusEl.textContent = "";
    btn.disabled = false;
  });

  browser.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.marketState) renderStatus(changes.marketState.newValue);
    if (changes.safety) renderSafety();
    if (changes.general) {
      const g = AT.mergeGeneral(changes.general.newValue);
      enabledEl.checked = !!g.market.enabled;
      notifyEl.checked = !!g.market.notifyPurchases;
    }
  });

  load();
})();
