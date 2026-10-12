// stats.js — pagina de estatisticas e atividades (le direto do armazenamento).
const $ = (id) => document.getElementById(id);
$("version").textContent = `v ${browser.runtime.getManifest().version}`;

let stats = {};
let activity = [];

const COLS = [
  ["casts", "Lances"],
  ["points", "Pontos"],
  ["xp", "XP"],
  ["level", "Níveis"],
  ["coins", "Moedas"],
  ["duelWins", "Duelos vencidos"],
  ["tourneyWins", "Torneios vencidos"]
];

// Dias (AAAA-MM-DD) do periodo escolhido.
function periodDays(period) {
  const today = AT.gameDay();
  const back = (n) => AT.gameDay(AT.gameDayStart() - n * 86400000 + 3600000);
  if (period === "today") return { days: [today], from: AT.gameDayStart(), to: Infinity };
  if (period === "yesterday") return { days: [back(1)], from: AT.gameDayStart() - 86400000, to: AT.gameDayStart() };
  if (period === "week") return { days: [0, 1, 2, 3, 4, 5, 6].map((n) => (n ? back(n) : today)), from: AT.gameDayStart() - 6 * 86400000, to: Infinity };
  return { days: null, from: 0, to: Infinity };
}

// Primeira e ultima foto do periodo + contadores somados.
function channelPeriod(c, period) {
  const { days } = periodDays(period);
  const all = Object.keys(c.days || {}).sort();
  const keys = days ? all.filter((d) => days.includes(d)) : all;
  if (!keys.length) return null;
  const first = days ? c.days[keys[0]].start || c.days[keys[0]].end : c.first;
  const last = c.days[keys[keys.length - 1]].end;
  const counts = {};
  for (const k of keys) for (const [n, v] of Object.entries(c.days[k].counts || {})) counts[n] = (counts[n] || 0) + v;
  return { first, last, counts };
}

function cell(tr, text, cls) {
  const td = document.createElement("td");
  td.textContent = text;
  if (cls) td.className = cls;
  tr.append(td);
}
const fmt = (n) => n.toLocaleString("pt-BR");

function renderStats() {
  const period = $("period").value;
  const table = $("statsTable");
  table.textContent = "";
  const head = document.createElement("tr");
  for (const t of ["Canal", ...COLS.map((c) => c[1]), "Saldo", "$pescar (extensão)", "$pescar (você)"]) {
    const th = document.createElement("th");
    th.textContent = t;
    head.append(th);
  }
  table.append(head);
  let rows = 0;
  for (const ch of Object.keys(stats).sort()) {
    const p = channelPeriod(stats[ch], period);
    if (!p || !p.last) continue;
    rows++;
    const tr = document.createElement("tr");
    cell(tr, ch);
    for (const [key] of COLS) {
      const a = p.first && p.first[key];
      const b = p.last[key];
      if (a == null || b == null) cell(tr, "—", "na");
      else {
        const d = b - a;
        cell(tr, d > 0 ? `+${fmt(d)}` : fmt(d), d > 0 ? "pos" : d < 0 ? "neg" : "");
      }
    }
    cell(tr, p.last.coins == null ? "—" : fmt(p.last.coins));
    cell(tr, fmt(p.counts.pescarExt || 0));
    cell(tr, fmt(p.counts.pescarVoce || 0));
    table.append(tr);
  }
  $("statsEmpty").hidden = rows > 0;
  table.hidden = rows === 0;

  // Acoes da extensao no periodo (do registro de atividades), por tipo.
  const { from, to } = periodDays(period);
  const byKind = {};
  for (const a of activity) if (a.at >= from && a.at < to) byKind[a.kind] = (byKind[a.kind] || 0) + 1;
  const acts = $("actions");
  acts.textContent = "";
  const entries = Object.entries(byKind).sort((x, y) => y[1] - x[1]);
  if (entries.length) {
    const lbl = document.createElement("span");
    lbl.className = "hint";
    lbl.textContent = "Registros no período:";
    acts.append(lbl);
    for (const [k, n] of entries) {
      const c = document.createElement("span");
      c.className = "chip";
      c.textContent = `${k}: ${n}`;
      acts.append(c);
    }
  }
}

function fillSelect(sel, values) {
  const keep = sel.value;
  while (sel.options.length > 1) sel.remove(1);
  for (const v of values) {
    const o = document.createElement("option");
    o.value = v;
    o.textContent = v;
    sel.append(o);
  }
  sel.value = values.includes(keep) ? keep : "";
}

function renderLog() {
  fillSelect($("fChannel"), [...new Set(activity.map((a) => a.channel).filter(Boolean))].sort());
  fillSelect($("fKind"), [...new Set(activity.map((a) => a.kind).filter(Boolean))].sort());
  const fc = $("fChannel").value;
  const fk = $("fKind").value;
  const list = $("log");
  list.textContent = "";
  const items = activity.filter((a) => (!fc || a.channel === fc) && (!fk || a.kind === fk));
  if (!items.length) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "Nada registrado ainda.";
    list.append(li);
    return;
  }
  for (const a of items) {
    const li = document.createElement("li");
    const when = document.createElement("span");
    when.className = "when";
    const d = new Date(a.at);
    when.textContent = `${d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} ${d.toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}`;
    const who = document.createElement("span");
    who.className = "who";
    who.textContent = a.channel || "geral";
    const kind = document.createElement("span");
    kind.className = "kind";
    kind.textContent = a.kind;
    who.append(kind);
    const msg = document.createElement("span");
    msg.textContent = a.msg;
    li.append(when, who, msg);
    list.append(li);
  }
}

async function load() {
  const r = await browser.storage.local.get(["stats", "activity"]);
  stats = r.stats || {};
  activity = Array.isArray(r.activity) ? r.activity : [];
  renderStats();
  renderLog();
}

$("period").addEventListener("change", renderStats);
$("fChannel").addEventListener("change", renderLog);
$("fKind").addEventListener("change", renderLog);
$("clearLog").addEventListener("click", async () => {
  if (!confirm("Apagar todo o registro de atividades?")) return;
  await browser.storage.local.set({ activity: [] });
});
browser.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.stats) {
    stats = changes.stats.newValue || {};
    renderStats();
  }
  if (changes.activity) {
    activity = Array.isArray(changes.activity.newValue) ? changes.activity.newValue : [];
    renderStats();
    renderLog();
  }
});
load();
