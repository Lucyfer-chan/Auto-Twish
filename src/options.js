// options.js — pagina de configuracoes (abre numa aba propria).
// Configuracoes gerais + a lista de todos os canais configurados.
// Tudo e aplicado na hora, sem botao "Salvar".

const $ = (id) => document.getElementById(id);
const channelsEl = $("channels");
const template = $("channelTemplate");
const defaultJitterEl = $("defaultJitter");
const defaultJitterValueEl = $("defaultJitterValue");
const semiFocusEl = $("semiFocus");
const semiNotifyEl = $("semiNotify");
const notifyDuelEl = $("notifyDuel");
const notifyAutomationsEl = $("notifyAutomations");

// ---------------------------------------------------------------------------
// Campos das automacoes (usados no padrao geral e nas excecoes dos canais).
// save(patch) recebe so o que mudou.
// ---------------------------------------------------------------------------
// Campos minutos + segundos -> segundos (vazio conta como 0).
function readMinSec(minEl, secEl) {
  const m = parseInt(String(minEl.value).trim() || "0", 10);
  const s = parseInt(String(secEl.value).trim() || "0", 10);
  if (!Number.isFinite(m) || !Number.isFinite(s) || m < 0 || s < 0) return null;
  return Math.min(AT.MAX_MIN_SECONDS, m * 60 + s);
}
function writeMinSec(minEl, secEl, total) {
  if (document.activeElement === minEl || document.activeElement === secEl) return;
  minEl.value = Math.floor(total / 60);
  secEl.value = String(total % 60).padStart(2, "0");
}

function mountDuelEditor(host, save) {
  const root = $("duelTemplate").content.firstElementChild.cloneNode(true);
  host.appendChild(root);
  const q = (sel) => root.querySelector(sel);
  const el = {
    enabled: q(".js-duel-enabled"),
    fields: q(".js-duel-fields"),
    rule: q(".js-duel-rule"),
    valueField: q(".js-duel-value-field"),
    min: q(".js-duel-min"),
    sec: q(".js-duel-sec")
  };
  for (const r of AT.DUEL_RULES) {
    const o = document.createElement("option");
    o.value = r;
    o.textContent = AT.DUEL_RULE_LABELS[r];
    el.rule.appendChild(o);
  }
  let cfg = AT.sanitizeDuelAccept(null);
  el.enabled.addEventListener("change", () => save({ enabled: el.enabled.checked }));
  el.rule.addEventListener("change", () => save({ rule: el.rule.value }));
  const onTime = () => {
    const v = readMinSec(el.min, el.sec);
    if (v !== null) save({ minSeconds: v });
  };
  el.min.addEventListener("change", onTime);
  el.sec.addEventListener("change", onTime);
  return function render(next) {
    cfg = AT.sanitizeDuelAccept(next);
    el.enabled.checked = cfg.enabled;
    el.fields.hidden = !cfg.enabled;
    if (document.activeElement !== el.rule) el.rule.value = cfg.rule;
    el.valueField.hidden = cfg.rule === "always";
    writeMinSec(el.min, el.sec, cfg.minSeconds);
  };
}

function mountSellEditor(host, save) {
  const root = $("sellTemplate").content.firstElementChild.cloneNode(true);
  host.appendChild(root);
  const enabled = root.querySelector(".js-sell-enabled");
  const fields = root.querySelector(".js-sell-fields");
  const seconds = root.querySelector(".js-sell-seconds");
  enabled.addEventListener("change", () => save({ enabled: enabled.checked }));
  seconds.addEventListener("change", () => save({ secondsBeforeEnd: seconds.value }));
  return function render(next) {
    const cfg = AT.sanitizeTurboSell(next);
    enabled.checked = cfg.enabled;
    fields.hidden = !cfg.enabled;
    if (document.activeElement !== seconds) seconds.value = cfg.secondsBeforeEnd;
  };
}

// Especies do jogo para a protecao (nome -> id), lidas do bestiario.
let protectBestiary = [];
async function loadProtectBestiary() {
  try {
    const { list } = await browser.runtime.sendMessage({ type: "GET_BESTIARY" });
    protectBestiary = Array.isArray(list) ? list : [];
  } catch (e) {
    protectBestiary = [];
  }
  const dl = $("protectFishOptions");
  dl.innerHTML = "";
  for (const f of protectBestiary) {
    const o = document.createElement("option");
    o.value = f.name;
    dl.appendChild(o);
  }
}
function norm(t) {
  return String(t || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
}
// Aceita o nome (com ou sem acento) ou o id do jogo (ex: aruana_asiatica).
function resolveFish(text) {
  const n = norm(text);
  if (!n) return null;
  const hit = protectBestiary.find((f) => norm(f.name) === n || f.id === n);
  if (hit) return { id: hit.id, name: hit.name };
  const id = n.replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!protectBestiary.length && AT.FISH_ID_RE.test(id)) return { id, name: text.trim() }; // sem bestiario: aceita pelo formato do id
  return null;
}

function mountProtectEditor(host, save) {
  const root = $("protectTemplate").content.firstElementChild.cloneNode(true);
  host.appendChild(root);
  const q = (sel) => root.querySelector(sel);
  const enabled = q(".js-protect-enabled");
  const chips = q(".js-protect-chips");
  const input = q(".js-protect-input");
  const add = q(".js-protect-add");
  const error = q(".js-protect-error");
  let cfg = AT.sanitizeProtection(null);
  enabled.addEventListener("change", () => save({ enabled: enabled.checked }));
  function addFish() {
    const f = resolveFish(input.value);
    if (!f) {
      error.textContent = "Espécie não encontrada — escolha um nome da lista de sugestões.";
      return;
    }
    if (cfg.fish.some((x) => x.id === f.id)) {
      error.textContent = `${f.name} já está na lista.`;
      return;
    }
    error.textContent = "";
    input.value = "";
    save({ fish: [...cfg.fish, f] });
  }
  add.addEventListener("click", addFish);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addFish();
    }
  });
  return function render(next) {
    cfg = AT.sanitizeProtection(next);
    enabled.checked = cfg.enabled;
    chips.innerHTML = "";
    if (!cfg.fish.length) {
      const e = document.createElement("span");
      e.className = "chips-empty";
      e.textContent = "Nenhuma espécie na lista.";
      chips.appendChild(e);
    }
    for (const f of cfg.fish) {
      const c = document.createElement("span");
      c.className = "chip";
      c.title = `id no jogo: ${f.id}`;
      c.textContent = f.name;
      const x = document.createElement("button");
      x.type = "button";
      x.textContent = "×";
      x.title = `Tirar ${f.name} da lista (não remove do jogo)`;
      x.setAttribute("aria-label", x.title);
      x.addEventListener("click", () => save({ fish: cfg.fish.filter((y) => y.id !== f.id) }));
      c.appendChild(x);
      chips.appendChild(c);
    }
  };
}

// ---------------------------------------------------------------------------
// Lista de Compras
// ---------------------------------------------------------------------------
let shopCatalog = [];
const shopEditors = new Set(); // re-render ao chegar o catalogo
async function loadShopCatalog() {
  try {
    const { list } = await browser.runtime.sendMessage({ type: "GET_SHOP_CATALOG" });
    shopCatalog = Array.isArray(list) ? list : [];
  } catch (e) {
    shopCatalog = [];
  }
  for (const fn of shopEditors) fn();
}
function shopEntry(id) {
  return shopCatalog.find((e) => e.id === id) || null;
}
function shopItemText(it) {
  const e = shopEntry(it.itemId);
  const cat = e ? AT.SHOP_CATEGORY_LABELS[e.category] : "";
  const price = e ? (e.pricesByRod ? "preço conforme a vara" : `${e.cost} moedas sem desconto`) : "fora da loja deste canal?";
  const what =
    it.mode === "once"
      ? `Compra única: ${it.quantity}`
      : it.mode === "recurring"
      ? `Recorrente: ${it.quantity} por desconto`
      : "Recorrente sem limite: até acabar as moedas";
  return { title: it.name, line: `${cat ? cat + " · " : ""}${price} · ${what}` };
}

function mountShopEditor(host, save) {
  const root = $("shopTemplate").content.firstElementChild.cloneNode(true);
  host.appendChild(root);
  const q = (sel) => root.querySelector(sel);
  const el = {
    enabled: q(".js-shop-enabled"),
    reserve: q(".js-shop-reserve"),
    items: q(".js-shop-items"),
    form: q(".js-shop-form"),
    formTitle: q(".js-shop-form-title"),
    item: q(".js-shop-item"),
    mode: q(".js-shop-mode"),
    qtyField: q(".js-shop-qty-field"),
    qty: q(".js-shop-qty"),
    qtyHint: q(".js-shop-qty-hint"),
    error: q(".js-shop-error"),
    confirm: q(".js-shop-confirm"),
    cancel: q(".js-shop-cancel"),
    add: q(".js-shop-add")
  };
  let cfg = AT.sanitizeShopList(null);
  let editingKey = null;

  for (const m of AT.SHOP_MODES) {
    const o = document.createElement("option");
    o.value = m;
    o.textContent = AT.SHOP_MODE_LABELS[m];
    el.mode.appendChild(o);
  }
  function fillItems() {
    const keep = el.item.value;
    el.item.innerHTML = "";
    const ph = document.createElement("option");
    ph.value = "";
    ph.textContent = shopCatalog.length ? "— escolha um item —" : "carregando a loja… (precisa de pelo menos um canal configurado)";
    el.item.appendChild(ph);
    for (const cat of AT.SHOP_CATEGORIES) {
      const items = shopCatalog.filter((e) => e.category === cat);
      if (!items.length) continue;
      const g = document.createElement("optgroup");
      g.label = AT.SHOP_CATEGORY_LABELS[cat];
      for (const e of items) {
        const o = document.createElement("option");
        o.value = e.id;
        o.textContent = `${e.name} — ${e.pricesByRod ? "preço conforme a vara" : e.cost + " moedas"}`;
        g.appendChild(o);
      }
      el.item.appendChild(g);
    }
    el.item.value = keep;
  }
  function syncFormFields() {
    const e = shopEntry(el.item.value);
    const single = !!(e && e.single);
    if (single) el.mode.value = "once";
    el.mode.disabled = single;
    el.qtyField.hidden = el.mode.value === "unlimited";
    el.qty.disabled = single;
    if (single) el.qty.value = "1";
    el.qtyHint.textContent = single
      ? "item que se tem um só: compra 1 vez"
      : el.mode.value === "once"
      ? "total a comprar; depois o item fica concluído"
      : "quanto comprar em cada Desconto na Loja";
  }
  function openForm(item) {
    editingKey = item ? item.key : null;
    el.formTitle.textContent = item ? `Editar ${item.name}` : "Adicionar item";
    el.confirm.textContent = item ? "Salvar alterações" : "Confirmar e adicionar";
    fillItems();
    el.item.value = item ? item.itemId : "";
    el.mode.value = item ? item.mode : "once";
    el.qty.value = item && item.quantity ? item.quantity : "1";
    el.error.textContent = "";
    el.form.hidden = false;
    el.add.hidden = true;
    syncFormFields();
  }
  function closeForm() {
    editingKey = null;
    el.form.hidden = true;
    el.add.hidden = false;
  }
  el.item.addEventListener("change", syncFormFields);
  el.mode.addEventListener("change", syncFormFields);
  el.add.addEventListener("click", () => openForm(null));
  el.cancel.addEventListener("click", closeForm);
  el.confirm.addEventListener("click", () => {
    const e = shopEntry(el.item.value);
    if (!e) {
      el.error.textContent = "Escolha um item da loja.";
      return;
    }
    const mode = e.single ? "once" : el.mode.value;
    let quantity = null;
    if (mode !== "unlimited") {
      const t = String(el.qty.value).trim();
      quantity = e.single ? 1 : /^\d+$/.test(t) ? Number(t) : NaN;
      if (!(quantity >= 1 && quantity <= AT.SHOP_MAX_QTY)) {
        el.error.textContent = `Quantidade: um número inteiro de 1 a ${AT.SHOP_MAX_QTY}.`;
        return;
      }
    }
    const entry = { itemId: e.id, name: e.name, mode, quantity, enabled: true };
    let items;
    if (editingKey) items = cfg.items.map((x) => (x.key === editingKey ? { ...x, ...entry } : x));
    else items = [...cfg.items, { ...entry, key: `${e.id}-${Date.now().toString(36)}` }];
    closeForm();
    save({ items });
  });
  el.enabled.addEventListener("change", () => save({ enabled: el.enabled.checked }));
  el.reserve.addEventListener("change", () => save({ reserve: el.reserve.value }));

  function move(i, d) {
    const items = [...cfg.items];
    const j = i + d;
    if (j < 0 || j >= items.length) return;
    [items[i], items[j]] = [items[j], items[i]];
    save({ items });
  }
  function renderItems() {
    el.items.innerHTML = "";
    if (!cfg.items.length) {
      const p = document.createElement("div");
      p.className = "chips-empty";
      p.style.marginTop = "8px";
      p.textContent = "Nenhum item na lista.";
      el.items.appendChild(p);
    }
    cfg.items.forEach((it, i) => {
      const row = document.createElement("div");
      row.className = "shop-item" + (it.enabled ? "" : " off");
      const prio = document.createElement("span");
      prio.className = "shop-prio";
      prio.textContent = `${i + 1}.`;
      const text = document.createElement("div");
      text.className = "shop-text";
      const t = shopItemText(it);
      const strong = document.createElement("strong");
      strong.textContent = t.title;
      text.append(strong, document.createElement("br"), t.line);
      const act = document.createElement("label");
      act.className = "acq-active";
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = it.enabled;
      cb.addEventListener("change", () => save({ items: cfg.items.map((x) => (x.key === it.key ? { ...x, enabled: cb.checked } : x)) }));
      act.append(cb, " Ativo");
      const mk = (label, title, fn, disabled) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "btn secondary small";
        b.textContent = label;
        b.title = title;
        b.setAttribute("aria-label", title);
        b.disabled = !!disabled;
        b.addEventListener("click", fn);
        return b;
      };
      row.append(
        prio,
        text,
        act,
        mk("↑", "Subir (mais prioridade)", () => move(i, -1), i === 0),
        mk("↓", "Descer (menos prioridade)", () => move(i, 1), i === cfg.items.length - 1),
        mk("Editar", "Editar", () => openForm(it)),
        mk("Remover", "Remover da lista", () => save({ items: cfg.items.filter((x) => x.key !== it.key) }))
      );
      el.items.appendChild(row);
    });
  }
  function render(next) {
    if (next !== undefined) cfg = AT.sanitizeShopList(next);
    el.enabled.checked = cfg.enabled;
    if (document.activeElement !== el.reserve) el.reserve.value = cfg.reserve;
    renderItems();
    if (!el.form.hidden) fillItems();
  }
  shopEditors.add(() => render());
  return render;
}

// ---------------------------------------------------------------------------
// Eventos (isca e reforcos), Torneio, Isca no duelo
// ---------------------------------------------------------------------------
function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") e.className = v;
    else if (k === "text") e.textContent = v;
    else e.setAttribute(k, v);
  }
  for (const c of kids) if (c != null) e.append(c);
  return e;
}
function checkRow(label, hint) {
  const cb = h("input", { type: "checkbox" });
  const row = h("label", { class: "check-row" }, cb, h("span", {}, label, hint ? h("span", { class: "hint", style: "display:block", text: hint }) : null));
  return { row, cb };
}
function baitSelect() {
  const sel = h("select");
  sel._fill = () => {
    const keep = sel.dataset.want || sel.value;
    sel.innerHTML = "";
    sel.append(h("option", { value: "", text: "— não trocar a isca —" }));
    const baits = shopCatalog.filter((e) => e.category === "baits");
    if (keep && !baits.some((b) => b.id === keep)) sel.append(h("option", { value: keep, text: keep }));
    for (const b of baits) sel.append(h("option", { value: b.id, text: b.name }));
    sel.value = keep || "";
  };
  sel._fill();
  shopEditors.add(() => sel._fill());
  return sel;
}
function setBait(sel, id) {
  sel.dataset.want = id || "";
  if (document.activeElement !== sel) sel._fill();
}

function mountKitEditor(host, save) {
  host.append(
    h("div", { class: "setting-title", text: "Eventos: isca e reforços" }),
    h("div", {
      class: "hint",
      text: "Enquanto o evento durar: equipa a isca escolhida ($isca) e mantém ativos o Turbo de Pesca (Impulso) e/ou a Afiação de Anzol (Cuidado), renovando quando acabam. Sem o item no inventário, compra ($comprar) se você permitir. Ativar o item é feito pelo site (não existe comando de chat para isso). No fim do evento, volta a isca que você estava usando."
    })
  );
  const rows = {};
  for (const kind of AT.KIT_EVENTS) {
    const on = checkRow(h("strong", { text: AT.KIT_EVENT_LABELS[kind] }));
    const bait = baitSelect();
    const turbo = checkRow("Ativar Turbo de Pesca (20 s de CD por 5 min)");
    const turboBuy = checkRow("comprar se não tiver");
    const sharpen = checkRow("Ativar Afiação de Anzol (+5% pontos e XP por 30 min)");
    const sharpenBuy = checkRow("comprar se não tiver");
    const sub = h(
      "div",
      { class: "kit-sub" },
      h("div", { class: "acq-field", style: "max-width:320px;margin-top:6px" }, h("label", { text: "Isca durante o evento" }), bait),
      turbo.row,
      h("div", { class: "kit-sub" }, turboBuy.row),
      sharpen.row,
      h("div", { class: "kit-sub" }, sharpenBuy.row)
    );
    const box = h("div", { class: "kit-event" }, on.row, sub);
    on.row.style.marginTop = "0";
    host.append(box);
    const send = (p) => save({ [kind]: p });
    on.cb.addEventListener("change", () => send({ enabled: on.cb.checked }));
    bait.addEventListener("change", () => send({ baitId: bait.value || null }));
    turbo.cb.addEventListener("change", () => send({ turbo: turbo.cb.checked }));
    turboBuy.cb.addEventListener("change", () => send({ turboBuy: turboBuy.cb.checked }));
    sharpen.cb.addEventListener("change", () => send({ sharpen: sharpen.cb.checked }));
    sharpenBuy.cb.addEventListener("change", () => send({ sharpenBuy: sharpenBuy.cb.checked }));
    rows[kind] = { on, sub, bait, turbo, turboBuy, sharpen, sharpenBuy };
  }
  return function render(next) {
    const kit = AT.sanitizeEventKit(next);
    for (const kind of AT.KIT_EVENTS) {
      const r = rows[kind];
      const e = kit[kind];
      r.on.cb.checked = e.enabled;
      r.sub.hidden = !e.enabled;
      setBait(r.bait, e.baitId);
      r.turbo.cb.checked = e.turbo;
      r.turboBuy.cb.checked = e.turboBuy;
      r.turboBuy.row.hidden = !e.turbo;
      r.sharpen.cb.checked = e.sharpen;
      r.sharpenBuy.cb.checked = e.sharpenBuy;
      r.sharpenBuy.row.hidden = !e.sharpen;
    }
  };
}

function mountTourneyEditor(host, save) {
  host.append(
    h("div", { class: "setting-title", text: "Torneio" }),
    h("div", { class: "hint", text: "Lido pela sua conta no site (página do torneio), conferido a cada 30 s e na hora em que o bot falar de torneio no chat." })
  );
  const join = checkRow(
    h("span", {}, h("strong", { text: "Entrar automaticamente" }), " ", h("span", { class: "hint", text: "($entrar)" })),
    "Entrar no torneio zera o CD da pesca. No padrão, se o CD acabar antes de fecharem as inscrições, a extensão pesca antes e entra logo depois (só se ela pescar neste canal); faltando 15 s para fechar, entra de qualquer jeito."
  );
  const rule = h("select");
  for (const r of AT.TOURNEY_RULES) rule.append(h("option", { value: r, text: AT.TOURNEY_RULE_LABELS[r] }));
  const tMin = h("input", { type: "text", inputmode: "numeric", autocomplete: "off", "aria-label": "minutos" });
  const tSec = h("input", { type: "text", inputmode: "numeric", autocomplete: "off", "aria-label": "segundos" });
  const valueField = h(
    "div",
    { class: "acq-field" },
    h("label", { text: "Tempo mínimo para pescar" }),
    h("div", { class: "minsec" }, tMin, h("span", { text: "min" }), tSec, h("span", { text: "s" })),
    h("div", { class: "field-hint", text: "só entra se faltar pelo menos isso para o $pescar" })
  );
  const joinFields = h("div", { class: "auto-fields" }, h("div", { class: "acq-field" }, h("label", { text: "Quando entrar" }), rule), valueField);
  const bait = baitSelect();
  const boost = checkRow("Ativar Turbo Torneio (10 s de CD por 3 min; um por torneio)");
  const boostBuy = checkRow("comprar se não tiver");
  const grease = checkRow("Ativar Graxa de Molinete (peixe 5% mais pesado por 20 lançadas; renova)");
  const greaseBuy = checkRow("comprar se não tiver");
  host.append(
    join.row,
    joinFields,
    h("div", { class: "acq-field", style: "max-width:320px;margin:10px 0 0 26px" }, h("label", { text: "Isca durante o torneio" }), bait),
    h("div", { style: "margin-left:26px" }, boost.row, h("div", { class: "kit-sub" }, boostBuy.row), grease.row, h("div", { class: "kit-sub" }, greaseBuy.row))
  );
  let cfg = AT.sanitizeTournament(null);
  join.cb.addEventListener("change", () => save({ join: join.cb.checked }));
  rule.addEventListener("change", () => save({ rule: rule.value }));
  const onTTime = () => {
    const v = readMinSec(tMin, tSec);
    if (v !== null) save({ minSeconds: v });
  };
  tMin.addEventListener("change", onTTime);
  tSec.addEventListener("change", onTTime);
  grease.cb.addEventListener("change", () => save({ grease: grease.cb.checked }));
  greaseBuy.cb.addEventListener("change", () => save({ greaseBuy: greaseBuy.cb.checked }));
  bait.addEventListener("change", () => save({ baitId: bait.value || null }));
  boost.cb.addEventListener("change", () => save({ boost: boost.cb.checked }));
  boostBuy.cb.addEventListener("change", () => save({ boostBuy: boostBuy.cb.checked }));
  return function render(next) {
    cfg = AT.sanitizeTournament(next);
    join.cb.checked = cfg.join;
    joinFields.hidden = !cfg.join;
    if (document.activeElement !== rule) rule.value = cfg.rule;
    valueField.hidden = cfg.rule !== "minTime";
    writeMinSec(tMin, tSec, cfg.minSeconds);
    grease.cb.checked = cfg.grease;
    greaseBuy.cb.checked = cfg.greaseBuy;
    greaseBuy.row.hidden = !cfg.grease;
    setBait(bait, cfg.baitId);
    boost.cb.checked = cfg.boost;
    boostBuy.cb.checked = cfg.boostBuy;
    boostBuy.row.hidden = !cfg.boost;
  };
}

function mountDuelBaitEditor(host, save) {
  const on = checkRow(h("span", {}, h("strong", { text: "Isca no duelo" }), " ", h("span", { class: "hint", text: "($isca <id> 1)" })), "Ao aceitar um duelo (por você ou pela extensão), equipa 1 isca; quando o duelo termina, volta a isca de antes.");
  on.row.style.marginTop = "0";
  const bait = baitSelect();
  const field = h("div", { class: "acq-field", style: "max-width:320px;margin:8px 0 0 26px" }, h("label", { text: "Isca do duelo" }), bait);
  host.append(on.row, field);
  on.cb.addEventListener("change", () => save({ enabled: on.cb.checked }));
  bait.addEventListener("change", () => save({ baitId: bait.value || null }));
  return function render(next) {
    const c = AT.sanitizeDuelBait(next);
    on.cb.checked = c.enabled;
    field.hidden = !c.enabled;
    setBait(bait, c.baitId);
  };
}

const renderGeneralDuel = mountDuelEditor($("generalDuel"), (patch) => updateGeneral({ duelAccept: patch }));
const renderGeneralSell = mountSellEditor($("generalSell"), (patch) => updateGeneral({ turboSell: patch }));
const renderGeneralProtect = mountProtectEditor($("generalProtect"), (patch) => updateGeneral({ protection: patch }));
const renderGeneralShop = mountShopEditor($("generalShop"), (patch) => updateGeneral({ shopList: patch }));
const renderGeneralKit = mountKitEditor($("generalKit"), (patch) => updateGeneral({ eventKit: patch }));
const renderGeneralTourney = mountTourneyEditor($("generalTourney"), (patch) => updateGeneral({ tournament: patch }));
const renderGeneralDuelBait = mountDuelBaitEditor($("generalDuelBait"), (patch) => updateGeneral({ duelBait: patch }));
let gameState = {};

$("version").textContent = `v ${browser.runtime.getManifest().version}`;

let state = { general: AT.mergeGeneral(null), channels: {} };
const cards = new Map(); // canal -> { root, els }

// ---------------------------------------------------------------------------
// Configuracoes gerais
// ---------------------------------------------------------------------------

function renderGeneral() {
  const g = state.general;
  if (document.activeElement !== defaultJitterEl) defaultJitterEl.value = g.defaultMaxJitterSeconds;
  defaultJitterValueEl.textContent = `${defaultJitterEl.value}s`;
  semiFocusEl.checked = !!g.semiAuto.focusTab;
  semiNotifyEl.checked = !!g.semiAuto.notify;
  notifyDuelEl.checked = !!g.notifyDuelInvites;
  notifyAutomationsEl.checked = !!g.notifyAutomations;
  renderGeneralDuel(g.duelAccept);
  renderGeneralSell(g.turboSell);
  renderGeneralProtect(g.protection);
  renderGeneralShop(g.shopList);
  renderGeneralKit(g.eventKit);
  renderGeneralTourney(g.tournament);
  renderGeneralDuelBait(g.duelBait);
  $("loginInfo").textContent = g.twishLogin ? `conta reconhecida: ${g.twishLogin}` : "ainda não lida (abra o popup num canal estando logado no twish.com.br)";
}

async function updateGeneral(patch) {
  const { general } = await browser.runtime.sendMessage({ type: "UPDATE_GENERAL_SETTINGS", patch });
  state.general = general;
  renderGeneral();
  for (const name of cards.keys()) renderCard(name);
}

defaultJitterEl.addEventListener("input", () => {
  defaultJitterValueEl.textContent = `${defaultJitterEl.value}s`;
});
defaultJitterEl.addEventListener("change", () => updateGeneral({ defaultMaxJitterSeconds: Number(defaultJitterEl.value) }));
semiFocusEl.addEventListener("change", () => updateGeneral({ semiAuto: { focusTab: semiFocusEl.checked } }));
semiNotifyEl.addEventListener("change", () => updateGeneral({ semiAuto: { notify: semiNotifyEl.checked } }));
notifyDuelEl.addEventListener("change", () => updateGeneral({ notifyDuelInvites: notifyDuelEl.checked }));
notifyAutomationsEl.addEventListener("change", () => updateGeneral({ notifyAutomations: notifyAutomationsEl.checked }));

// ---------------------------------------------------------------------------
// Canais
// ---------------------------------------------------------------------------

async function updateChannel(name, patch) {
  const { settings } = await browser.runtime.sendMessage({ type: "UPDATE_CHANNEL_SETTINGS", channel: name, settings: patch });
  state.channels[name] = settings;
  renderCard(name);
}

function clockText(s) {
  if (!s.enabled) return { text: "Desativado", cls: "countdown muted" };
  if (s.awaitingUser) return { text: `Pesca disponível — esperando você enviar o ${AT.FISH_COMMAND}`, cls: "countdown waiting" };
  if (!s.nextFireAt) return { text: "Nenhum envio agendado", cls: "countdown muted" };
  const remaining = s.nextFireAt - Date.now();
  const verb = s.mode === "semi" ? "Próximo aviso" : "Próximo envio";
  return remaining > 0
    ? { text: `${verb} em ${AT.formatRemaining(remaining)}`, cls: "countdown" }
    : { text: `${verb}: agora…`, cls: "countdown" };
}

function createCard(name) {
  const root = template.content.firstElementChild.cloneNode(true);
  const q = (sel) => root.querySelector(sel);
  const els = {
    name: q(".channel-name"),
    clock: q(".channel-clock"),
    enabled: q(".js-enabled"),
    modeButtons: [...root.querySelectorAll(".js-mode button")],
    rodField: q(".js-rod-field"),
    rod: q(".js-rod"),
    notifyEvents: q(".js-notify-events"),
    jitterDefault: q(".js-jitter-default"),
    defaultValue: q(".js-default-value"),
    jitterRow: q(".js-jitter-row"),
    jitter: q(".js-jitter"),
    jitterValue: q(".js-jitter-value"),
    test: q(".js-test"),
    actionStatus: q(".js-action-status"),
    remove: q(".js-remove"),
    duelDefault: q(".js-duel-default"),
    duelSummary: q(".js-duel-summary"),
    duelHost: q(".js-duel-host"),
    sellDefault: q(".js-sell-default"),
    sellSummary: q(".js-sell-summary"),
    sellHost: q(".js-sell-host"),
    protectDefault: q(".js-protect-default"),
    protectSummary: q(".js-protect-summary"),
    protectHost: q(".js-protect-host"),
    protectStatusRow: q(".js-protect-status-row"),
    protectStatus: q(".js-protect-status"),
    protectCheck: q(".js-protect-check")
  };
  els.shopDefault = q(".js-shop-default");
  els.shopSummary = q(".js-shop-summary");
  els.shopHost = q(".js-shop-host");
  els.shopStatusRow = q(".js-shop-status-row");
  els.shopStatus = q(".js-shop-status");
  els.renderShop = mountShopEditor(els.shopHost, (patch) => updateChannel(name, { shopList: patch }));
  els.shopDefault.addEventListener("change", () => updateChannel(name, { shopList: els.shopDefault.checked ? null : {} }));
  for (const [key, cls, mount] of [
    ["eventKit", "kit", mountKitEditor],
    ["tournament", "tourney", mountTourneyEditor],
    ["duelBait", "duelbait", mountDuelBaitEditor]
  ]) {
    const def = q(`.js-${cls}-default`);
    const hostEl = q(`.js-${cls}-host`);
    els[`${cls}Default`] = def;
    els[`${cls}Summary`] = q(`.js-${cls}-summary`);
    els[`${cls}Host`] = hostEl;
    els[`${cls}Render`] = mount(hostEl, (patch) => updateChannel(name, { [key]: patch }));
    def.addEventListener("change", () => updateChannel(name, { [key]: def.checked ? null : {} }));
  }
  els.kitStatusRow = q(".js-kit-status-row");
  els.kitStatus = q(".js-kit-status");
  els.renderProtect = mountProtectEditor(els.protectHost, (patch) => updateChannel(name, { protection: patch }));
  els.protectDefault.addEventListener("change", () => updateChannel(name, { protection: els.protectDefault.checked ? null : {} }));
  els.protectCheck.addEventListener("click", async () => {
    els.protectCheck.disabled = true;
    els.protectStatus.textContent = "Conferindo…";
    await browser.runtime.sendMessage({ type: "SYNC_PROTECTION_NOW", channel: name });
    els.protectCheck.disabled = false;
    renderProtectStatus(name);
  });
  // Excecoes de automacao: desmarcar "usar o padrao geral" cria uma copia do
  // padrao atual para este canal; marcar de novo apaga a excecao.
  els.renderDuel = mountDuelEditor(els.duelHost, (patch) => updateChannel(name, { duelAccept: patch }));
  els.renderSell = mountSellEditor(els.sellHost, (patch) => updateChannel(name, { turboSell: patch }));
  els.duelDefault.addEventListener("change", () => updateChannel(name, { duelAccept: els.duelDefault.checked ? null : {} }));
  els.sellDefault.addEventListener("change", () => updateChannel(name, { turboSell: els.sellDefault.checked ? null : {} }));

  els.name.textContent = name;
  els.name.href = `https://www.twitch.tv/${encodeURIComponent(name)}`;
  for (const rod of AT.ROD_DEFS) {
    const opt = document.createElement("option");
    opt.value = rod.id;
    opt.textContent = `${rod.name} — ${rod.minutes} min`;
    els.rod.appendChild(opt);
  }

  els.enabled.addEventListener("change", () => updateChannel(name, { enabled: els.enabled.checked }));
  for (const b of els.modeButtons) {
    b.addEventListener("click", () => {
      if (state.channels[name]?.mode !== b.dataset.mode) updateChannel(name, { mode: b.dataset.mode });
    });
  }
  els.rod.addEventListener("change", () => updateChannel(name, { rod: els.rod.value }));
  els.notifyEvents.addEventListener("change", () => updateChannel(name, { notifyEvents: els.notifyEvents.checked }));

  els.jitterDefault.addEventListener("change", () => {
    // Desmarcar cria uma excecao comecando no valor padrao atual.
    updateChannel(name, {
      maxJitterSeconds: els.jitterDefault.checked ? null : state.general.defaultMaxJitterSeconds
    });
  });
  els.jitter.addEventListener("input", () => {
    els.jitterValue.textContent = `${els.jitter.value}s`;
  });
  els.jitter.addEventListener("change", () => updateChannel(name, { maxJitterSeconds: Number(els.jitter.value) }));

  els.test.addEventListener("click", async () => {
    els.test.disabled = true;
    els.actionStatus.textContent = "Enviando…";
    const result = await browser.runtime.sendMessage({ type: "SEND_NOW", channel: name });
    els.actionStatus.textContent = result?.ok
      ? "Enviado. Confira o chat."
      : `Falha ao enviar (${result?.reason || "motivo desconhecido"}). A aba do canal na Twitch está aberta?`;
    els.test.disabled = false;
  });

  // Remover pede um segundo clique pra confirmar.
  let confirmTimer = null;
  els.remove.addEventListener("click", async () => {
    if (!els.remove.classList.contains("confirm")) {
      els.remove.classList.add("confirm");
      els.remove.textContent = "Clique de novo para remover";
      confirmTimer = setTimeout(() => {
        els.remove.classList.remove("confirm");
        els.remove.textContent = "Remover canal";
      }, 4000);
      return;
    }
    clearTimeout(confirmTimer);
    await browser.runtime.sendMessage({ type: "REMOVE_CHANNEL", channel: name });
    delete state.channels[name];
    renderChannels();
  });

  cards.set(name, { root, els });
  return root;
}

function renderCard(name) {
  const card = cards.get(name);
  const s = state.channels[name];
  if (!card || !s) return;
  const { els } = card;

  els.enabled.checked = !!s.enabled;
  for (const b of els.modeButtons) b.setAttribute("aria-checked", String(b.dataset.mode === s.mode));
  els.rodField.hidden = s.mode !== "manual"; // a vara so aparece no modo manual
  if (document.activeElement !== els.rod) els.rod.value = s.rod || AT.DEFAULT_ROD;

  els.notifyEvents.checked = !!s.notifyEvents;

  const usesDefault = s.maxJitterSeconds === null || s.maxJitterSeconds === undefined;
  els.jitterDefault.checked = usesDefault;
  els.defaultValue.textContent = `${state.general.defaultMaxJitterSeconds}s`;
  els.jitterRow.hidden = usesDefault;
  if (!usesDefault && document.activeElement !== els.jitter) {
    els.jitter.value = s.maxJitterSeconds;
    els.jitterValue.textContent = `${s.maxJitterSeconds}s`;
  }

  const g = state.general;
  els.duelDefault.checked = !s.duelAccept;
  els.duelSummary.textContent = AT.describeDuelAccept(AT.sanitizeDuelAccept(g.duelAccept));
  els.duelHost.hidden = !s.duelAccept;
  if (s.duelAccept) els.renderDuel(s.duelAccept);
  els.sellDefault.checked = !s.turboSell;
  els.sellSummary.textContent = AT.describeTurboSell(AT.sanitizeTurboSell(g.turboSell));
  els.sellHost.hidden = !s.turboSell;
  if (s.turboSell) els.renderSell(s.turboSell);
  els.protectDefault.checked = !s.protection;
  els.protectSummary.textContent = AT.describeProtection(AT.sanitizeProtection(g.protection));
  els.protectHost.hidden = !s.protection;
  if (s.protection) els.renderProtect(s.protection);
  for (const [key, cls, describe, sanitize] of [
    ["eventKit", "kit", AT.describeEventKit, AT.sanitizeEventKit],
    ["tournament", "tourney", AT.describeTournament, AT.sanitizeTournament],
    ["duelBait", "duelbait", AT.describeDuelBait, AT.sanitizeDuelBait]
  ]) {
    els[`${cls}Default`].checked = !s[key];
    els[`${cls}Summary`].textContent = describe(sanitize(g[key]));
    els[`${cls}Host`].hidden = !s[key];
    if (s[key]) els[`${cls}Render`](s[key]);
  }
  els.shopDefault.checked = !s.shopList;
  els.shopSummary.textContent = AT.describeShopList(AT.sanitizeShopList(g.shopList));
  els.shopHost.hidden = !s.shopList;
  if (s.shopList) els.renderShop(s.shopList);
  renderProtectStatus(name);

  renderClock(name);
}

function renderShopStatus(name) {
  const card = cards.get(name);
  const s = state.channels[name];
  if (!card || !s) return;
  const cfg = AT.effectiveShopList(s, state.general);
  const sh = (gameState[name] || {}).shop;
  const show = cfg.enabled && cfg.items.length > 0;
  card.els.shopStatusRow.hidden = !show;
  if (!show) return;
  card.els.shopStatus.textContent =
    sh && sh.lastRunAt
      ? `Última Lista de Compras (${new Date(sh.lastRunAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}): ${sh.lastMsg || ""}`
      : "Lista de Compras: esperando o próximo Desconto na Loja.";
}

function renderKitStatus(name) {
  const card = cards.get(name);
  const s = state.channels[name];
  if (!card || !s) return;
  const k = (gameState[name] || {}).kit;
  const show = !!(k && k.lastAt);
  card.els.kitStatusRow.hidden = !show;
  if (!show) return;
  card.els.kitStatus.textContent = `Eventos/torneio (${new Date(k.lastAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}): ${k.lastMsg || ""}`;
}

function renderProtectStatus(name) {
  renderShopStatus(name);
  renderKitStatus(name);
  const card = cards.get(name);
  const s = state.channels[name];
  if (!card || !s) return;
  const cfg = AT.effectiveProtection(s, state.general);
  const active = cfg.enabled && cfg.fish.length > 0;
  card.els.protectStatusRow.hidden = !active;
  if (!active) return;
  const w = (gameState[name] || {}).whitelist;
  card.els.protectStatus.textContent = w && w.checkedAt
    ? `${w.lastMsg || ""} Conferido às ${new Date(w.checkedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}.`
    : "Ainda não conferido.";
}

function renderClock(name) {
  const card = cards.get(name);
  const s = state.channels[name];
  if (!card || !s) return;
  const { text, cls } = clockText(s);
  card.els.clock.textContent = text;
  card.els.clock.className = `channel-clock ${cls}`;
}

function renderChannels() {
  const names = Object.keys(state.channels).sort((a, b) => a.localeCompare(b));
  const enabledCount = names.filter((n) => state.channels[n] && state.channels[n].enabled).length;
  $("channelsCount").textContent = names.length
    ? `${names.length} cana${names.length === 1 ? "l" : "is"} · ${enabledCount} ativado${enabledCount === 1 ? "" : "s"}`
    : "nenhum ainda";

  // Remove cartoes de canais que sumiram.
  for (const name of [...cards.keys()]) {
    if (!names.includes(name)) {
      cards.get(name).root.remove();
      cards.delete(name);
    }
  }

  if (names.length === 0) {
    channelsEl.innerHTML = "";
    const p = document.createElement("div");
    p.className = "panel empty";
    p.textContent =
      "Nenhum canal configurado ainda. Abra a aba de um canal na Twitch e ative pelo popup da extensão — ele aparece aqui.";
    channelsEl.appendChild(p);
    return;
  }
  channelsEl.querySelector(".empty")?.remove();

  for (const name of names) {
    const root = cards.has(name) ? cards.get(name).root : createCard(name);
    channelsEl.appendChild(root); // mantem a ordem alfabetica
    renderCard(name);
  }
}

// ---------------------------------------------------------------------------
// Estado
// ---------------------------------------------------------------------------

async function loadState() {
  state = await browser.runtime.sendMessage({ type: "GET_ALL_STATE" });
  try {
    gameState = (await browser.storage.local.get("gameState")).gameState || {};
  } catch (e) {
    gameState = {};
  }
  loadProtectBestiary();
  loadShopCatalog();
  renderGeneral();
  renderChannels();
}

// Mudancas feitas em outro lugar (popup, envios, Twish) aparecem aqui sozinhas.
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.general) {
    state.general = AT.mergeGeneral(changes.general.newValue);
    renderGeneral();
  }
  if (changes.gameState) {
    gameState = changes.gameState.newValue || {};
    for (const name of cards.keys()) renderProtectStatus(name);
  }
  if (changes.channels) {
    const next = changes.channels.newValue || {};
    state.channels = {};
    for (const [name, s] of Object.entries(next)) state.channels[name] = { ...AT.DEFAULT_CHANNEL_SETTINGS, ...s };
    renderChannels();
  }
});

// Contadores: 1x por segundo.
setInterval(() => {
  for (const name of cards.keys()) renderClock(name);
}, 1000);

// Lista de canais: fechada por padrao; lembra se o jogador deixou aberta.
(() => {
  const box = $("channelsBox");
  try {
    if (localStorage.getItem("at.channelsOpen") === "1") box.open = true;
  } catch (e) {}
  box.addEventListener("toggle", () => {
    try {
      localStorage.setItem("at.channelsOpen", box.open ? "1" : "0");
    } catch (e) {}
  });
})();

loadState();
