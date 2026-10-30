// Rodinné finance – přehled majetku, měsíční uzávěrka a cash flow.
// Data jsou v Supabase (tabulky fin_*, viz supabase/schema.sql), přihlášení
// a přístup řeší společný /rozcestnik/auth.js.
(function () {
  "use strict";

  const KATEGORIE = {
    hotovost:    { nazev: "Hotovost a účty", barva: "var(--c-hotovost)" },
    investice:   { nazev: "Investice",       barva: "var(--c-investice)" },
    penzijka:    { nazev: "Penzijka a životko", barva: "var(--c-penzijka)" },
    nemovitosti: { nazev: "Nemovitosti",     barva: "var(--c-nemovitosti)" },
    hypoteky:    { nazev: "Hypotéky a úvěry" },
    sporeni:     { nazev: "Stavební spoření" },
    platby:      { nazev: "Pravidelné platby a pojištění" },
  };
  // pořadí ve skládaném grafu (největší dole)
  const AKTIVA = ["nemovitosti", "hotovost", "investice", "penzijka"];
  const MENY = ["CZK", "EUR", "GBP", "PHP"];
  const VYCHOZI_KURZY = { eur: 24.25, gbp: 27.5, php: 0.35 };
  const MESICE_CS = ["leden", "únor", "březen", "duben", "květen", "červen", "červenec", "srpen", "září", "říjen", "listopad", "prosinec"];

  let db = null;          // supabase klient
  let uzivatel = null;
  const D = { polozky: [], stavy: new Map(), mesice: new Map(), historie: new Map(), cfRadky: [], cf: new Map() };

  // ---------- pomocné ----------
  const $ = (s, el = document) => el.querySelector(s);
  const esc = (t) => String(t ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmt0 = new Intl.NumberFormat("cs-CZ", { maximumFractionDigits: 0 });
  const fmt2 = new Intl.NumberFormat("cs-CZ", { maximumFractionDigits: 2 });
  const kc = (v) => (v == null || isNaN(v) ? "–" : fmt0.format(Math.round(v)) + " Kč");
  const cislo = (v, mena) => (v == null || isNaN(v) ? "–" : (mena && mena !== "CZK" ? fmt2 : fmt0).format(v));
  const mil = (v) => (v == null ? "–" : fmt2.format(Math.round(v / 1e4) / 100) + " mil.");
  const proc = (v) => (v == null || !isFinite(v) ? "" : (v >= 0 ? "+" : "") + fmt2.format(Math.round(v * 1000) / 10) + " %");
  const znam = (v) => (v > 0 ? "good" : v < 0 ? "bad" : "");
  const plus = (v) => (v > 0 ? "+" : "") + fmt0.format(Math.round(v));

  const mKey = (y, m) => `${y}-${String(m).padStart(2, "0")}-01`;
  const mPosun = (k, n) => { const [y, m] = k.split("-").map(Number); const d = new Date(y, m - 1 + n, 1); return mKey(d.getFullYear(), d.getMonth() + 1); };
  const mNazev = (k) => { const [y, m] = k.split("-").map(Number); return `${MESICE_CS[m - 1]} ${y}`; };
  const mKratce = (k) => { const [y, m] = k.split("-").map(Number); return `${m}/${String(y).slice(2)}`; };
  const mDnes = () => { const d = new Date(); return mKey(d.getFullYear(), d.getMonth() + 1); };
  const mPosledniDen = (k) => { const [y, m] = k.split("-").map(Number); return new Date(y, m, 0); };
  const sk = (pid, m) => pid + "|" + m;

  function toast(text, chyba) {
    const t = $("#toast");
    t.textContent = text; t.className = "toast" + (chyba ? " err" : ""); t.style.display = "block";
    clearTimeout(toast.t); toast.t = setTimeout(() => (t.style.display = "none"), chyba ? 6000 : 2500);
  }

  // Výraz jako v Excelu: 7585+250537, 20575*eur+80, (100-20)/2 … bez eval
  function spocti(text, kurzy, des = 2) {
    const s = String(text).replace(/^=/, "").replace(/\s+/g, "").replace(/,/g, ".").toLowerCase();
    if (s === "") return null;
    let i = 0;
    const cislo_ = () => {
      const m = /^\d+(\.\d+)?|^\.\d+/.exec(s.slice(i));
      if (m) { i += m[0].length; return parseFloat(m[0]); }
      const id = /^(eur|gbp|php)/.exec(s.slice(i));
      if (id) { i += 3; return kurzy[id[1]]; }
      if (s[i] === "(") { i++; const v = soucet(); if (s[i++] !== ")") throw 0; return v; }
      if (s[i] === "-") { i++; return -cislo_(); }
      throw 0;
    };
    const soucin = () => { let v = cislo_(); while (s[i] === "*" || s[i] === "/") { const o = s[i++]; const w = cislo_(); v = o === "*" ? v * w : v / w; } return v; };
    const soucet = () => { let v = soucin(); while (s[i] === "+" || s[i] === "-") { const o = s[i++]; const w = soucin(); v = o === "+" ? v + w : v - w; } return v; };
    try {
      const v = soucet();
      if (i !== s.length || !isFinite(v)) return NaN;
      return Math.round(v * 10 ** des) / 10 ** des;
    } catch (e) { return NaN; }
  }
  const jeVyraz = (t) => /[+\-*/()a-z]/i.test(String(t).replace(/^-/, ""));

  // ---------- data ----------
  async function nactiVse(tab) {
    const out = [];
    for (let od = 0; ; od += 1000) {
      const { data, error } = await db.from(tab).select("*").range(od, od + 999);
      if (error) throw error;
      out.push(...data);
      if (data.length < 1000) return out;
    }
  }

  async function nacti() {
    const [p, s, m, h, r, c] = await Promise.all(
      ["fin_polozky", "fin_stavy", "fin_mesice", "fin_historie", "fin_cf_radky", "fin_cf"].map(nactiVse));
    D.polozky = p.sort((a, b) => a.poradi - b.poradi || a.nazev.localeCompare(b.nazev, "cs"));
    D.stavy = new Map(s.map((x) => [sk(x.polozka_id, x.mesic), x]));
    D.mesice = new Map(m.map((x) => [x.mesic, x]));
    D.historie = new Map(h.map((x) => [x.ukazatel + "|" + x.mesic, Number(x.castka)]));
    D.cfRadky = r.sort((a, b) => a.poradi - b.poradi);
    D.cf = new Map(c.map((x) => [sk(x.radek_id, x.mesic), x]));
    prepocet();
  }

  async function upsert(tab, rows, onConflict) {
    for (let i = 0; i < rows.length; i += 500) {
      const { error } = await db.from(tab).upsert(rows.slice(i, i + 500), { onConflict });
      if (error) throw error;
    }
  }

  // ---------- výpočty ----------
  let C = {};   // cache: měsíce, souhrny
  function prepocet() {
    const mesSet = new Set();
    for (const s of D.stavy.values()) mesSet.add(s.mesic);
    const vse = [...mesSet].sort();
    // Přehled začíná prvním měsícem, kdy máme i něco jiného než účty
    const neHot = vse.filter((m) => [...D.stavy.values()].some((s) => s.mesic === m && polozka(s.polozka_id)?.kategorie !== "hotovost"));
    const prvni = neHot[0] || vse[0];
    const posl = vse[vse.length - 1];
    const mesice = [];
    if (prvni) for (let m = prvni; m <= posl; m = mPosun(m, 1)) mesice.push(m);
    C = { mesice, vse, souhrn: new Map() };
    for (const m of mesice) C.souhrn.set(m, souhrn(m));
  }

  const polozka = (id) => D.polozky.find((p) => p.id === id);

  function kurzy(m) {
    // kurz daného měsíce, jinak poslední známý dřívější, jinak výchozí
    const klice = [...D.mesice.keys()].filter((k) => k <= m).sort().reverse();
    const k = { ...VYCHOZI_KURZY };
    for (const mena of ["eur", "gbp", "php"]) {
      const z = klice.find((x) => D.mesice.get(x)[mena] != null);
      if (z) k[mena] = Number(D.mesice.get(z)[mena]);
    }
    return k;
  }
  const kurz = (mena, k) => (mena === "CZK" ? 1 : k[mena.toLowerCase()] ?? 0);

  // poslední známý stav položky k měsíci m (stav se „nese“ dál, dokud se nezmění)
  function stavK(pid, m, jenPresne) {
    const presne = D.stavy.get(sk(pid, m));
    if (presne || jenPresne) return presne || null;
    let best = null;
    for (const s of D.stavy.values()) if (s.polozka_id === pid && s.mesic <= m && (!best || s.mesic > best.mesic)) best = s;
    return best;
  }

  function souhrn(m) {
    const k = kurzy(m);
    const out = { mesic: m, kat: {}, osoba: {}, mena: {}, polozky: {} };
    for (const p of D.polozky) {
      if (!["hotovost", "investice", "penzijka", "nemovitosti", "hypoteky"].includes(p.kategorie)) continue;
      const s = stavK(p.id, m);
      if (!s || s.castka == null) continue;
      const czk = Number(s.castka) * kurz(p.mena, k);
      out.polozky[p.id] = czk;
      out.kat[p.kategorie] = (out.kat[p.kategorie] || 0) + czk;
      if (p.kategorie !== "hypoteky") {
        out.osoba[p.osoba || "Rodina"] = (out.osoba[p.osoba || "Rodina"] || 0) + czk;
        out.mena[p.mena] = (out.mena[p.mena] || 0) + czk;
      }
    }
    out.aktiva = AKTIVA.reduce((a, c) => a + (out.kat[c] || 0), 0);
    out.celkem = out.aktiva - (out.kat.hypoteky || 0);
    return out;
  }

  // hotovost celkem k měsíci: z účtů, pokud je máme, jinak z historie (2020–2025)
  function hotovost(m) {
    const maUcty = D.polozky.some((p) => p.kategorie === "hotovost" && D.stavy.has(sk(p.id, m)));
    if (maUcty) return (C.souhrn.get(m) || souhrn(m)).kat.hotovost || 0;
    return D.historie.get("hotovost|" + m) ?? null;
  }

  const posledniUzavreny = () => [...D.mesice.values()].filter((x) => x.uzavreno).map((x) => x.mesic).sort().pop() || null;

  // ---------- grafy (SVG) ----------
  const tip = () => $("#tip");
  function ukazTip(ev, html, box) {
    const t = tip(); t.innerHTML = html; t.style.display = "block";
    const r = box.getBoundingClientRect();
    let x = ev.clientX - r.left + 14, y = ev.clientY - r.top + 14;
    if (x + t.offsetWidth > r.width) x = ev.clientX - r.left - t.offsetWidth - 14;
    t.style.left = r.left + window.scrollX + Math.max(0, x) + "px";
    t.style.top = r.top + window.scrollY + y + "px";
  }
  const skryjTip = () => (tip().style.display = "none");

  function osaY(max) {
    const kroky = [1, 2, 2.5, 5, 10];
    const mag = Math.pow(10, Math.floor(Math.log10(max / 5 || 1)));
    const krok = kroky.map((k) => k * mag).find((k) => max / k <= 6) || mag * 10;
    const ticks = []; for (let v = 0; v <= max + krok * 0.01; v += krok) ticks.push(v);
    if (ticks[ticks.length - 1] < max) ticks.push(ticks[ticks.length - 1] + krok);
    return ticks;
  }

  function grafSloupce(box, mesice) {
    const W = 760, H = 280, L = 56, B = 26, T = 8, R = 8;
    const data = mesice.map((m) => C.souhrn.get(m));
    const ticks = osaY(Math.max(...data.map((d) => d.aktiva)));
    const max = ticks[ticks.length - 1];
    const y = (v) => T + (H - T - B) * (1 - v / max);
    const sirka = (W - L - R) / mesice.length;
    const bw = Math.min(42, sirka * 0.62);
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Vývoj majetku po kategoriích">`;
    svg += `<g class="grid">${ticks.map((t) => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/>`).join("")}</g>`;
    svg += `<g class="axis">${ticks.map((t) => `<text x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${fmt0.format(t / 1e6)} M</text>`).join("")}</g>`;
    data.forEach((d, i) => {
      const x = L + i * sirka + (sirka - bw) / 2;
      let base = 0;
      AKTIVA.forEach((k, j) => {
        const v = d.kat[k] || 0; if (v <= 0) return;
        const y1 = y(base + v), y0 = y(base);
        const h = Math.max(0, y0 - y1 - (j ? 2 : 0));
        const top = j === AKTIVA.length - 1 || AKTIVA.slice(j + 1).every((kk) => !(d.kat[kk] > 0));
        svg += top
          ? `<path d="M${x},${y1 + h} V${y1 + 4} q0,-4 4,-4 H${x + bw - 4} q4,0 4,4 V${y1 + h} Z" fill="${KATEGORIE[k].barva}"/>`
          : `<rect x="${x}" y="${y1}" width="${bw}" height="${h}" fill="${KATEGORIE[k].barva}"/>`;
        base += v;
      });
      svg += `<rect class="hit" data-i="${i}" x="${L + i * sirka}" y="${T}" width="${sirka}" height="${H - T - B}" fill="transparent"/>`;
      if (mesice.length <= 14 || i % Math.ceil(mesice.length / 12) === 0)
        svg += `<g class="axis"><text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle">${mKratce(mesice[i])}</text></g>`;
    });
    svg += "</svg>";
    box.innerHTML = `<div class="legend">${AKTIVA.slice().reverse().map((k) => `<span><i class="dot" style="background:${KATEGORIE[k].barva}"></i>${KATEGORIE[k].nazev}</span>`).join("")}</div>${svg}`;
    box.querySelectorAll(".hit").forEach((el) => {
      el.addEventListener("mousemove", (ev) => {
        const d = data[+el.dataset.i];
        ukazTip(ev, `<b>${mNazev(d.mesic)}</b>` + AKTIVA.slice().reverse().map((k) =>
          `<div class="row"><span><i class="dot" style="background:${KATEGORIE[k].barva}"></i> ${KATEGORIE[k].nazev}</span><span class="num">${kc(d.kat[k] || 0)}</span></div>`).join("") +
          `<div class="row" style="margin-top:4px;font-weight:600"><span>Celkem</span><span class="num">${kc(d.celkem)}</span></div>`, box);
      });
      el.addEventListener("mouseleave", skryjTip);
    });
  }

  function grafLinie(box, body, popis) {
    if (body.length < 2) { box.innerHTML = '<p class="muted">Málo dat pro graf.</p>'; return; }
    const W = 760, H = 220, L = 56, B = 26, T = 8, R = 8;
    const ticks = osaY(Math.max(...body.map((b) => b.v)));
    const max = ticks[ticks.length - 1];
    const x = (i) => L + (W - L - R) * (i / (body.length - 1));
    const y = (v) => T + (H - T - B) * (1 - v / max);
    const pts = body.map((b, i) => `${x(i).toFixed(1)},${y(b.v).toFixed(1)}`).join(" ");
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(popis)}">`;
    svg += `<g class="grid">${ticks.map((t) => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}"/>`).join("")}</g>`;
    svg += `<g class="axis">${ticks.map((t) => `<text x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${fmt0.format(t / 1e6)} M</text>`).join("")}</g>`;
    let rok = null;
    body.forEach((b, i) => {
      const r = b.m.slice(0, 4);
      if (r !== rok) { rok = r; svg += `<g class="axis"><text x="${x(i)}" y="${H - 8}" text-anchor="start">${r}</text></g>`; }
    });
    svg += `<polyline points="${pts}" fill="none" stroke="var(--c-hotovost)" stroke-width="2" stroke-linejoin="round"/>`;
    svg += `<line class="cross" y1="${T}" y2="${H - B}" stroke="var(--muted)" stroke-dasharray="3 3" style="display:none"/>`;
    svg += `<circle class="mark" r="4.5" fill="var(--c-hotovost)" stroke="var(--tile)" stroke-width="2" style="display:none"/>`;
    svg += `<rect class="hit" x="${L}" y="${T}" width="${W - L - R}" height="${H - T - B}" fill="transparent"/></svg>`;
    box.innerHTML = svg;
    const el = box.querySelector("svg"), hit = box.querySelector(".hit"), cross = box.querySelector(".cross"), mark = box.querySelector(".mark");
    hit.addEventListener("mousemove", (ev) => {
      const r = el.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const i = Math.max(0, Math.min(body.length - 1, Math.round(((px - L) / (W - L - R)) * (body.length - 1))));
      cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i)); cross.style.display = "";
      mark.setAttribute("cx", x(i)); mark.setAttribute("cy", y(body[i].v)); mark.style.display = "";
      ukazTip(ev, `<b>${mNazev(body[i].m)}</b><span class="num">${kc(body[i].v)}</span>`, box);
    });
    hit.addEventListener("mouseleave", () => { skryjTip(); cross.style.display = "none"; mark.style.display = "none"; });
  }

  // ---------- stránka: Přehled ----------
  function strPrehled(app) {
    if (!C.mesice.length) {
      app.innerHTML = `<div class="card"><h2>Zatím tu nejsou žádná data</h2><p>Nahraj úvodní data z Excelu v záložce <a href="#data">Export a import</a>.</p></div>`;
      return;
    }
    const posl = C.mesice[C.mesice.length - 1];
    const s = C.souhrn.get(posl), p = C.souhrn.get(mPosun(posl, -1));
    const zm = p ? s.celkem - p.celkem : null;
    const rokZpet = C.souhrn.get(mPosun(posl, -12)) || C.souhrn.get(C.mesice[0]);
    const uz = D.mesice.get(posl)?.uzavreno;

    app.innerHTML = `
      <div class="kpis">
        <div class="card kpi hero">
          <div class="lbl">Čisté jmění · ${mNazev(posl)} ${uz ? '<span class="badge ok">uzavřeno</span>' : '<span class="badge">rozpracováno</span>'}</div>
          <div class="val">${kc(s.celkem)}</div>
          <div class="sub">${zm != null ? `<span class="${znam(zm)}">${plus(zm)} Kč (${proc(zm / p.celkem)})</span> proti minulému měsíci` : ""}
          ${rokZpet && rokZpet !== s ? `<br><span class="${znam(s.celkem - rokZpet.celkem)}">${plus(s.celkem - rokZpet.celkem)} Kč</span> od ${mNazev(rokZpet.mesic)}` : ""}</div>
        </div>
        ${AKTIVA.map((k) => {
          const d = p ? (s.kat[k] || 0) - (p.kat[k] || 0) : null;
          return `<div class="card kpi"><div class="lbl"><i class="dot" style="background:${KATEGORIE[k].barva}"></i>${KATEGORIE[k].nazev}</div>
            <div class="val">${mil(s.kat[k] || 0)}</div>
            <div class="sub muted">${d != null ? `<span class="${znam(d)}">${plus(d)} Kč</span>` : ""}</div></div>`;
        }).join("")}
      </div>

      <h3>Vývoj majetku</h3>
      <div class="card chart" id="g1"></div>

      <h3>Souhrn po měsících</h3>
      <div class="card scroll" id="tabSouhrn"></div>

      <div class="twocol">
        <div><h3>Podle osoby · ${mNazev(posl)}</h3><div class="card" id="tabOsoby"></div></div>
        <div><h3>Podle měny · ${mNazev(posl)}</h3><div class="card" id="tabMeny"></div></div>
      </div>

      <h3>Hotovost od roku 2020</h3>
      <div class="card chart" id="g2"></div>
    `;
    grafSloupce($("#g1"), C.mesice);

    // tabulka souhrnu (jako řádky PENZIJKA / AKCIE / NEMOVITOSTI / CASH / CELKEM)
    const ms = C.mesice.slice(-13);
    const radek = (nazev, f, tucne) => `<tr class="${tucne ? "sum" : ""}"><td>${nazev}</td>${ms.map((m, i) => {
      const v = f(C.souhrn.get(m)); const pv = i ? f(C.souhrn.get(ms[i - 1])) : null;
      return `<td class="r"><span class="num">${fmt0.format(Math.round(v))}</span>${pv ? `<br><span class="small ${znam(v - pv)}">${proc(v / pv - 1)}</span>` : ""}</td>`;
    }).join("")}</tr>`;
    $("#tabSouhrn").innerHTML = `<table><thead><tr><th></th>${ms.map((m) => `<th class="r">${mKratce(m)}</th>`).join("")}</tr></thead><tbody>
      ${["penzijka", "investice", "nemovitosti", "hotovost"].map((k) => radek(KATEGORIE[k].nazev, (x) => x.kat[k] || 0)).join("")}
      ${s.kat.hypoteky ? radek("− Hypotéky", (x) => x.kat.hypoteky || 0) : ""}
      ${radek("Celkem", (x) => x.celkem, true)}
    </tbody></table>`;

    const malaTab = (obj) => {
      const rows = Object.entries(obj).filter((r) => Math.round(r[1])).sort((a, b) => b[1] - a[1]);
      const sum = rows.reduce((a, r) => a + r[1], 0);
      return `<table><tbody>${rows.map(([k, v]) => `<tr><td>${esc(k)}</td><td class="r num">${kc(v)}</td><td class="r small muted">${fmt0.format(Math.round((v / sum) * 100))} %</td></tr>`).join("")}</tbody></table>`;
    };
    $("#tabOsoby").innerHTML = malaTab(s.osoba);
    $("#tabMeny").innerHTML = malaTab(s.mena) + `<p class="small muted" style="margin:8px 0 0">Přepočteno kurzy ${kurzyText(kurzy(posl))}.</p>`;

    // hotovost: historie + výpočet z účtů
    const mesH = new Set([...D.historie.keys()].filter((k) => k.startsWith("hotovost|")).map((k) => k.split("|")[1]));
    C.vse.forEach((m) => mesH.add(m));
    const body = [...mesH].sort().map((m) => ({ m, v: hotovost(m) })).filter((b) => b.v != null && b.v > 0);
    grafLinie($("#g2"), body, "Vývoj hotovosti");
    ["#g1", "#g2"].forEach((id) => ($(id).scrollLeft = $(id).scrollWidth));   // na mobilu ukázat nejnovější měsíce
  }
  const fmt4 = new Intl.NumberFormat("cs-CZ", { maximumFractionDigits: 4 });
  const kurzyText = (k) => `EUR ${fmt4.format(k.eur)} · GBP ${fmt4.format(k.gbp)} · PHP ${fmt4.format(k.php)}`;

  // ---------- stránka: Uzávěrka měsíce ----------
  let uzMesic = null;
  function strUzaverka(app) {
    const pu = posledniUzavreny();
    if (!uzMesic) uzMesic = pu ? mPosun(pu, 1) : mPosun(mDnes(), -1);
    const m = uzMesic, pm = mPosun(m, -1);
    const info = D.mesice.get(m);
    const k = info && info.eur != null ? { eur: +info.eur, gbp: +info.gbp, php: +info.php } : kurzy(pm);
    const zdrojKurzu = info?.kurzy_zdroj || "převzato z minulého měsíce";
    const kat = ["hotovost", "investice", "penzijka", "nemovitosti", "hypoteky"];
    const pol = D.polozky.filter((p) => kat.includes(p.kategorie) && (p.aktivni || D.stavy.has(sk(p.id, m))));
    const moznosti = [];
    for (let x = mPosun(mDnes(), 1); moznosti.length < 24; x = mPosun(x, -1)) moznosti.push(x);
    if (!moznosti.includes(m)) moznosti.push(m);

    app.innerHTML = `
      <h2>Uzávěrka: ${mNazev(m)} ${info?.uzavreno ? '<span class="badge ok">uzavřeno</span>' : ""}</h2>
      <p class="muted">Vyplň stavy ke konci měsíce. Do políček jde psát i výpočet jako v Excelu, třeba <span class="num">7585+250537</span> nebo <span class="num">20575*eur+80</span>.
      Prázdné políčko se uloží jako „beze změny“, tedy s hodnotou z minulého měsíce.</p>
      <div class="toolbar">
        <label class="f">Měsíc <select id="uzM">${moznosti.sort().reverse().map((x) => `<option value="${x}" ${x === m ? "selected" : ""}>${mNazev(x)}${D.mesice.get(x)?.uzavreno ? " ✓" : ""}</option>`).join("")}</select></label>
        <label class="f">EUR <input id="kEUR" class="amount" style="width:90px" value="${k.eur}"></label>
        <label class="f">GBP <input id="kGBP" class="amount" style="width:90px" value="${k.gbp}"></label>
        <label class="f">PHP <input id="kPHP" class="amount" style="width:90px" value="${k.php}"></label>
        <div style="align-self:flex-end"><button id="btnCNB">Načíst kurzy ČNB</button></div>
        <div class="grow"></div>
      </div>
      <p class="small muted" id="kZdroj" style="margin-top:-6px">Kurzy: ${esc(zdrojKurzu)}</p>
      ${pol.some((p) => p.info?.pricist_cf) ? `<div class="note">RD Cvrčovice: hodnota se předvyplní jako minulý stav + platby stavby za tento měsíc z cash flow (řádek „Dům Cvrčovice“). Zkontroluj, že v cash flow je skutečná částka, ne plán.</div>` : ""}
      <div class="card scroll"><table id="uzTab"><thead><tr>
        <th>Položka</th><th>Měna</th><th class="r">${mKratce(pm)}</th><th class="r">${mKratce(m)}</th><th class="r">Změna (Kč)</th>
      </tr></thead><tbody></tbody><tfoot></tfoot></table></div>
      <div class="toolbar">
        <span class="muted small" id="uzStav"></span><div class="grow"></div>
        <button id="uzPrevzit">Doplnit prázdné z minulého měsíce</button>
        <button id="uzUlozit">Uložit rozpracované</button>
        <button id="uzUzavrit" class="primary">${info?.uzavreno ? "Uložit změny" : "Uzavřít měsíc"}</button>
      </div>`;

    const tb = $("#uzTab tbody");
    let html = "";
    for (const kk of kat) {
      const ps = pol.filter((p) => p.kategorie === kk);
      if (!ps.length) continue;
      html += `<tr class="grp"><td colspan="5">${KATEGORIE[kk].nazev}</td></tr>`;
      for (const p of ps) {
        const prev = stavK(p.id, pm);
        const cur = D.stavy.get(sk(p.id, m));
        let navrh = "";
        if (!cur && p.info?.pricist_cf && prev?.castka != null) {
          const platba = Number(D.cf.get(sk(p.info.pricist_cf, m))?.castka || 0);
          navrh = String(Math.round(Number(prev.castka) + platba));
        }
        const hodnota = cur ? (cur.vyraz || (cur.castka ?? "")) : navrh;
        html += `<tr data-id="${esc(p.id)}" data-mena="${p.mena}" data-prev="${prev?.castka ?? ""}">
          <td>${esc(p.nazev)}<div class="small muted">${esc(p.instituce || "")}${prev && prev.mesic !== pm ? ` · naposledy ${mKratce(prev.mesic)}` : ""}</div></td>
          <td class="small">${p.mena}</td>
          <td class="r num">${cislo(prev?.castka, p.mena)}</td>
          <td class="r"><input class="amount ${cur ? "filled" : ""}" value="${esc(hodnota)}" placeholder="${prev?.castka != null ? cislo(prev.castka, p.mena) : ""}" inputmode="decimal">
            ${cur?.zdroj === "dropbox" ? '<div><span class="badge src">z výpisu</span></div>' : ""}${navrh ? '<div><span class="badge src">návrh</span></div>' : ""}</td>
          <td class="r num zm"></td></tr>`;
      }
    }
    tb.innerHTML = html;

    const kurzyForm = () => ({ eur: spocti($("#kEUR").value, {}, 4), gbp: spocti($("#kGBP").value, {}, 4), php: spocti($("#kPHP").value, {}, 4) });
    function prepocitej() {
      const kf = kurzyForm();
      const kp = kurzy(pm);
      let vypl = 0, cel = 0, sumNow = 0, sumPrev = 0;
      tb.querySelectorAll("tr[data-id]").forEach((tr) => {
        const inp = tr.querySelector("input"), mena = tr.dataset.mena, prev = tr.dataset.prev === "" ? null : +tr.dataset.prev;
        const v = inp.value.trim() === "" ? prev : spocti(inp.value, kf);
        inp.classList.toggle("err", inp.value.trim() !== "" && isNaN(v));
        inp.classList.toggle("filled", inp.value.trim() !== "" && !isNaN(v));
        inp.title = jeVyraz(inp.value) && !isNaN(v) ? "= " + cislo(v, mena) : "";
        cel++; if (inp.value.trim() !== "") vypl++;
        const kat_ = polozka(tr.dataset.id).kategorie, zn = kat_ === "hypoteky" ? -1 : 1;
        const now = (v ?? 0) * kurz(mena, kf) * zn, was = (prev ?? 0) * kurz(mena, kp) * zn;
        sumNow += isNaN(now) ? 0 : now; sumPrev += was;
        const d = now - was;
        tr.querySelector(".zm").innerHTML = isNaN(d) || Math.abs(d) < 0.5 ? "" : `<span class="${znam(d)}">${plus(d)}</span>`;
      });
      $("#uzTab tfoot").innerHTML = `<tr class="sum"><td colspan="2">Čisté jmění</td><td class="r num">${fmt0.format(sumPrev)}</td><td class="r num">${fmt0.format(sumNow)}</td><td class="r num ${znam(sumNow - sumPrev)}">${plus(sumNow - sumPrev)}</td></tr>`;
      $("#uzStav").textContent = `Vyplněno ${vypl} z ${cel} položek`;
    }
    app.addEventListener("input", prepocitej);
    prepocitej();

    $("#uzM").onchange = (e) => { uzMesic = e.target.value; render(); };
    $("#uzPrevzit").onclick = () => {
      tb.querySelectorAll("tr[data-id]").forEach((tr) => { const i = tr.querySelector("input"); if (!i.value.trim() && tr.dataset.prev !== "") i.value = tr.dataset.prev; });
      prepocitej();
    };
    $("#btnCNB").onclick = async () => {
      try {
        const r = await nactiKurzy(m);
        $("#kEUR").value = r.eur; $("#kGBP").value = r.gbp; $("#kPHP").value = r.php;
        $("#kZdroj").textContent = "Kurzy: " + r.zdroj;
        $("#kZdroj").dataset.zdroj = r.zdroj;
        prepocitej();
      } catch (e) { toast("Kurzy se nepodařilo načíst – doplň je ručně.", true); }
    };

    async function uloz(uzavrit) {
      const kf = kurzyForm();
      if ([kf.eur, kf.gbp, kf.php].some((v) => v == null || isNaN(v))) return toast("Zkontroluj kurzy.", true);
      const rows = [];
      let chyba = false;
      tb.querySelectorAll("tr[data-id]").forEach((tr) => {
        const inp = tr.querySelector("input"), prev = tr.dataset.prev === "" ? null : +tr.dataset.prev;
        let t = inp.value.trim();
        if (t === "") { if (!uzavrit || prev == null) return; t = String(prev); }
        const v = spocti(t, kf);
        if (isNaN(v)) { chyba = true; return; }
        const puvodni = D.stavy.get(sk(tr.dataset.id, m));
        const vyraz = jeVyraz(t) ? t.replace(/^=/, "") : null;
        if (puvodni && Number(puvodni.castka) === v && (puvodni.vyraz || null) === vyraz) return;
        rows.push({ polozka_id: tr.dataset.id, mesic: m, castka: v, vyraz, zdroj: "ručně", upraveno: new Date().toISOString() });
      });
      if (chyba) return toast("Některé políčko obsahuje chybný výpočet.", true);
      if (uzavrit && !info?.uzavreno && !confirm(`Uzavřít ${mNazev(m)}? Prázdné položky se uloží s hodnotou z minulého měsíce.`)) return;
      try {
        await upsert("fin_stavy", rows, "polozka_id,mesic");
        const mes = { mesic: m, eur: kf.eur, gbp: kf.gbp, php: kf.php, kurzy_zdroj: $("#kZdroj").dataset.zdroj || info?.kurzy_zdroj || "ručně" };
        if (uzavrit) { mes.uzavreno = info?.uzavreno || new Date().toISOString(); mes.uzavrel = info?.uzavrel || uzivatel.jmeno; }
        await upsert("fin_mesice", [mes], "mesic");
        await nacti();
        toast(uzavrit ? `${mNazev(m)} je uzavřený.` : "Uloženo.");
        if (uzavrit && !info?.uzavreno) { uzMesic = null; location.hash = "#prehled"; } else render();
      } catch (e) { toast("Uložení selhalo: " + e.message, true); }
    }
    $("#uzUlozit").onclick = () => uloz(false);
    $("#uzUzavrit").onclick = () => uloz(true);
  }

  // Kurzy k poslednímu dni měsíce: ČNB, a když prohlížeč nepustí, ECB (Frankfurter)
  async function nactiKurzy(m) {
    const den = mPosledniDen(m) > new Date() ? new Date() : mPosledniDen(m);
    const iso = `${den.getFullYear()}-${String(den.getMonth() + 1).padStart(2, "0")}-${String(den.getDate()).padStart(2, "0")}`;
    try {
      const r = await fetch(`https://api.cnb.cz/cnbapi/exrates/daily?date=${iso}&lang=CZ`);
      if (!r.ok) throw 0;
      const j = await r.json();
      const g = (c) => { const x = j.rates.find((q) => q.currencyCode === c); return Math.round((x.rate / x.amount) * 10000) / 10000; };
      return { eur: g("EUR"), gbp: g("GBP"), php: g("PHP"), zdroj: `ČNB k ${j.rates[0].validFor}` };
    } catch (e) {
      const r = await fetch(`https://api.frankfurter.app/${iso}?from=CZK&to=EUR,GBP,PHP`);
      if (!r.ok) throw new Error("kurzy");
      const j = await r.json();
      const g = (c) => Math.round((1 / j.rates[c]) * 10000) / 10000;
      return { eur: g("EUR"), gbp: g("GBP"), php: g("PHP"), zdroj: `ECB k ${j.date} (ČNB nedostupná)` };
    }
  }

  // ---------- stránka: Majetek a smlouvy ----------
  let ukazNeaktivni = false;
  const INFO_POPISY = {
    cislo: "Číslo smlouvy", ucel: "Účel", podpis_cena: "Podpis / cena", platba: "Platba", z_uctu: "Z účtu",
    frekvence: "Frekvence", castka: "Částka", na_ucet: "Na účet", banka: "Kód banky", vs: "VS", ks: "KS",
    ucty: "Čísla účtů", poznamka: "Poznámka", popis: "Popis", porizovaci_cena: "Pořizovací cena", pricist_cf: "Přičítat řádek cash flow",
  };
  const mesicne = (i) => {
    const c = Number(i?.castka); if (!c) return 0;
    return { "měsíčně": c, "kvartálně": c / 4, "ročně": c / 12 }[i.frekvence] ?? 0;
  };

  function strPolozky(app) {
    const posl = C.mesice[C.mesice.length - 1];
    const poradiKat = ["hotovost", "investice", "penzijka", "nemovitosti", "hypoteky", "sporeni", "platby"];
    let html = `<h2>Majetek a smlouvy</h2>
      <div class="toolbar"><label class="small"><input type="checkbox" id="neakt" ${ukazNeaktivni ? "checked" : ""}> zobrazit i ukončené</label>
      <div class="grow"></div><button class="primary" id="novaPol">+ Nová položka</button></div>`;
    for (const k of poradiKat) {
      const ps = D.polozky.filter((p) => p.kategorie === k && (ukazNeaktivni || p.aktivni));
      if (!ps.length) continue;
      const platby = k === "platby";
      const sum = platby ? ps.filter((p) => p.aktivni).reduce((a, p) => a + mesicne(p.info), 0) : null;
      html += `<h3>${KATEGORIE[k].nazev}</h3><div class="card scroll"><table><thead><tr>
        <th>Název</th><th>Osoba</th><th>Instituce</th><th>${platby ? "Platba" : "Detail"}</th>
        <th class="r">${platby ? "Měsíčně" : posl ? "Stav " + mKratce(posl) : ""}</th><th></th></tr></thead><tbody>
        ${ps.map((p) => {
          const s = posl ? stavK(p.id, posl) : null;
          const det = platby ? [p.info?.frekvence, p.info?.castka ? kc(p.info.castka) : null, p.info?.z_uctu ? "z " + p.info.z_uctu : null].filter(Boolean).join(" · ")
            : [p.info?.cislo, p.info?.ucty, p.info?.ucel, p.info?.popis, p.info?.poznamka].filter(Boolean).join(" · ");
          return `<tr class="${p.aktivni ? "" : "off"}"><td>${esc(p.nazev)}${p.aktivni ? "" : ' <span class="badge">ukončeno</span>'}</td>
            <td>${esc(p.osoba || "")}</td><td class="small">${esc(p.instituce || "")}</td>
            <td class="small muted" style="max-width:360px">${esc(det)}</td>
            <td class="r num">${platby ? kc(mesicne(p.info)) : s?.castka != null ? cislo(s.castka, p.mena) + (p.mena !== "CZK" ? " " + p.mena : "") : ""}</td>
            <td class="r"><button class="mini" data-edit="${esc(p.id)}">Upravit</button></td></tr>`;
        }).join("")}
        ${platby ? `<tr class="sum"><td colspan="4">Celkem měsíčně (aktivní)</td><td class="r num">${kc(sum)}</td><td></td></tr>` : ""}
        </tbody></table></div>`;
    }
    app.innerHTML = html;
    $("#neakt").onchange = (e) => { ukazNeaktivni = e.target.checked; render(); };
    $("#novaPol").onclick = () => editPolozku(null);
    app.querySelectorAll("[data-edit]").forEach((b) => (b.onclick = () => editPolozku(polozka(b.dataset.edit))));
  }

  function editPolozku(p) {
    const novy = !p;
    p = p || { id: "", kategorie: "hotovost", nazev: "", osoba: "Rodina", instituce: "", mena: "CZK", poradi: (D.polozky.reduce((a, x) => Math.max(a, x.poradi), 0) + 10), aktivni: true, info: {} };
    const dlg = $("#dlg");
    const info = Object.entries(p.info || {});
    dlg.innerHTML = `<form method="dialog">
      <h2>${novy ? "Nová položka" : "Upravit položku"}</h2>
      <label class="f">Název <input name="nazev" required value="${esc(p.nazev)}"></label>
      <div class="grid2">
        <label class="f">Kategorie <select name="kategorie">${Object.entries(KATEGORIE).map(([k, v]) => `<option value="${k}" ${k === p.kategorie ? "selected" : ""}>${v.nazev}</option>`).join("")}</select></label>
        <label class="f">Osoba <input name="osoba" list="osoby" value="${esc(p.osoba || "")}"></label>
        <label class="f">Instituce <input name="instituce" value="${esc(p.instituce || "")}"></label>
        <label class="f">Měna <select name="mena">${MENY.map((m) => `<option ${m === p.mena ? "selected" : ""}>${m}</option>`).join("")}</select></label>
        <label class="f">Pořadí <input name="poradi" type="number" value="${p.poradi}"></label>
        <label class="f" style="align-self:end"><span><input type="checkbox" name="aktivni" ${p.aktivni ? "checked" : ""}> aktivní</span></label>
      </div>
      <datalist id="osoby"><option>Jana</option><option>Jakub</option><option>Matěj</option><option>Lukáš</option><option>Rodina</option></datalist>
      <div class="f">Podrobnosti</div>
      <div class="kv" id="kv">${info.map(([k, v]) => kvRadek(k, v)).join("")}</div>
      <div><button type="button" class="mini" id="kvAdd">+ přidat údaj</button></div>
      <p class="small muted" style="margin:0">U pravidelných plateb vyplň <i>castka</i> a <i>frekvence</i> (měsíčně / kvartálně / ročně) – z nich se počítá měsíční částka.</p>
      <div class="toolbar">${novy ? "" : '<button type="button" class="danger" id="smazat">Smazat</button>'}<div class="grow"></div>
        <button value="cancel" formnovalidate>Zrušit</button><button class="primary" value="ok">Uložit</button></div>
    </form>`;
    dlg.showModal();
    $("#kvAdd").onclick = () => $("#kv").insertAdjacentHTML("beforeend", kvRadek("", ""));
    $("#kv").onclick = (e) => { if (e.target.matches("[data-del]")) e.target.closest(".kvr").remove(); };
    if (!novy) $("#smazat").onclick = async () => {
      if (!confirm(`Smazat „${p.nazev}“ včetně celé historie stavů? Pro ukončenou smlouvu raději jen odškrtni „aktivní“.`)) return;
      const { error } = await db.from("fin_polozky").delete().eq("id", p.id);
      if (error) return toast(error.message, true);
      dlg.close(); await nacti(); render(); toast("Smazáno.");
    };
    dlg.querySelector("form").onsubmit = async (e) => {
      if (e.submitter?.value !== "ok") return;
      e.preventDefault();
      const f = new FormData(e.target);
      const inf = {};
      dlg.querySelectorAll(".kvr").forEach((r) => {
        const k = r.querySelector(".k").value.trim(), v = r.querySelector(".v").value.trim();
        if (k && v) inf[k] = k === "castka" || k === "porizovaci_cena" ? (spocti(v, {}) || v) : v;
      });
      const row = {
        id: novy ? slug(f.get("nazev")) : p.id, nazev: f.get("nazev").trim(), kategorie: f.get("kategorie"),
        osoba: f.get("osoba").trim() || null, instituce: f.get("instituce").trim() || null, mena: f.get("mena"),
        poradi: +f.get("poradi") || 0, aktivni: f.get("aktivni") === "on", info: inf,
      };
      if (novy && polozka(row.id)) row.id += "-" + Date.now().toString(36);
      try { await upsert("fin_polozky", [row], "id"); dlg.close(); await nacti(); render(); toast("Uloženo."); }
      catch (err) { toast(err.message, true); }
    };
  }
  const kvRadek = (k, v) => `<div class="kvr" style="display:contents">
    <input class="k" list="infoKlice" value="${esc(k)}" placeholder="údaj" title="${esc(INFO_POPISY[k] || "")}">
    <input class="v" value="${esc(v)}"><button type="button" class="mini" data-del>×</button></div>
    <datalist id="infoKlice">${Object.keys(INFO_POPISY).map((x) => `<option value="${x}">${INFO_POPISY[x]}</option>`).join("")}</datalist>`;
  const slug = (s) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "polozka";

  // ---------- stránka: Cash flow ----------
  function cfMesice() {
    const ms = new Set([...D.cf.values()].map((x) => x.mesic));
    const od = [...ms].sort()[0] || mPosun(mDnes(), -6);
    let doM = [...ms].sort().pop() || mDnes();
    if (doM < mPosun(mDnes(), 12)) doM = mPosun(mDnes(), 12);
    const out = []; for (let m = od; m <= doM; m = mPosun(m, 1)) out.push(m);
    return out;
  }

  function cfVypocet(mesice) {
    const pu = posledniUzavreny();
    const r = { prijmy: {}, naklady: {}, prirustek: {}, skut: {}, plan: {}, diff: {} };
    const radky = D.cfRadky.filter((x) => x.aktivni);
    let predSkut = D.historie.get("cf_skutecnost|" + mPosun(mesice[0], -1)) ?? null;
    let predPlan = predSkut ?? 0;
    for (const m of mesice) {
      const suma = (sekce) => radky.filter((x) => x.sekce === sekce).reduce((a, x) => a + Number(D.cf.get(sk(x.id, m))?.castka || 0), 0);
      r.prijmy[m] = suma("prijem"); r.naklady[m] = suma("naklad");
      r.prirustek[m] = r.prijmy[m] - r.naklady[m];
      r.plan[m] = (predSkut ?? predPlan) + r.prirustek[m];
      let s = D.historie.get("cf_skutecnost|" + m) ?? null;
      if (s == null && pu && m <= pu) s = hotovost(m);
      r.skut[m] = s;
      r.diff[m] = s != null ? s - r.plan[m] : null;
      predSkut = s; predPlan = r.plan[m];
    }
    return r;
  }

  // stav zobrazení cash flow (pamatuje si prohlížeč, ne databáze)
  const cfUi = (() => { try { return JSON.parse(localStorage.getItem("fin-cf-ui")) || {}; } catch (e) { return {}; } })();
  const cfUiUloz = () => { try { localStorage.setItem("fin-cf-ui", JSON.stringify(cfUi)); } catch (e) {} };

  function strCashflow(app) {
    const vse = cfMesice();
    const v = cfVypocet(vse);
    const dnes = mDnes();
    const odM = mPosun(dnes, -6);
    const starsich = vse.filter((m) => m < odM).length;
    const mesice = cfUi.starsi ? vse : vse.filter((m) => m >= odM);
    // hranice: do posledního uzavřeného měsíce je skutečnost, dál výhled
    const hranice = posledniUzavreny() || mPosun(dnes, -1);
    const jeVyhled = (m) => m > hranice;
    const nSkut = mesice.filter((m) => !jeVyhled(m)).length, nVyhl = mesice.length - nSkut;

    // nejhorší / nejlepší přírůstek a nejnižší plánovaná hotovost ve výhledu
    const prir = mesice.map((m) => v.prirustek[m]);
    const maxAbs = Math.max(1, ...prir.map(Math.abs));
    // nejhorší a nejlepší měsíc zvlášť ve skutečnosti a ve výhledu
    const vyhl = mesice.filter(jeVyhled);
    const extremy = (ms) => ms.length ? [ms.reduce((a, m) => (v.prirustek[m] < v.prirustek[a] ? m : a)), ms.reduce((a, m) => (v.prirustek[m] > v.prirustek[a] ? m : a))] : [];
    const [hS, lS] = extremy(mesice.filter((m) => !jeVyhled(m))), [hV, lV] = extremy(vyhl);
    const nejhorsi = new Set([hS, hV]), nejlepsi = new Set([lS, lV]);
    const minPlan = vyhl.length ? vyhl.reduce((a, m) => (v.plan[m] < v.plan[a] ? m : a), vyhl[0]) : null;
    const maxAbsDiff = Math.max(1, ...mesice.map((m) => Math.abs(v.diff[m] || 0)));

    const tridy = (m) => [jeVyhled(m) ? "fc" : "", m === dnes ? "now" : "", m === mPosun(hranice, 1) ? "hr" : ""].join(" ");
    const tint = (val, max) => {
      if (!val) return "";
      const a = Math.round(8 + 32 * Math.min(1, Math.abs(val) / max));
      return `style="background:color-mix(in srgb, var(${val > 0 ? "--good" : "--bad"}) ${a}%, transparent)"`;
    };
    const bunka = (rid, m) => {
      const c = D.cf.get(sk(rid, m));
      return `<td class="cell ${tridy(m)} ${c?.vyraz ? "vyr" : ""}" data-r="${esc(rid)}" data-m="${m}" title="${esc([c?.vyraz ? "= " + c.vyraz : "", c?.poznamka || ""].filter(Boolean).join("\n"))}">${c?.castka != null ? fmt0.format(Math.round(c.castka)) : c?.poznamka ? "…" : ""}</td>`;
    };
    const sekce = (s, nazev, soucty) => {
      const zav = !(cfUi.otevreno || {})[s];
      const radky = D.cfRadky.filter((x) => x.sekce === s && x.aktivni);
      return `<tr class="grp sec" data-sekce="${s}"><td class="lbl"><button class="tog" aria-expanded="${!zav}">${zav ? "▸" : "▾"} ${nazev} <span class="muted small">(${radky.length})</span></button></td>
          ${mesice.map((m) => `<td class="r num ${tridy(m)}">${fmt0.format(Math.round(soucty[m]))}</td>`).join("")}</tr>` +
        radky.map((x) => `<tr class="det" data-sekce="${s}" ${zav ? "hidden" : ""}><td class="lbl">${esc(x.nazev)} <button class="mini" data-fill="${esc(x.id)}" title="Zkopírovat poslední vyplněnou hodnotu do dalších měsíců">→</button></td>${mesice.map((m) => bunka(x.id, m)).join("")}</tr>`).join("");
    };
    const calc = (nazev, f, extra) => `<tr class="calc"><td class="lbl">${nazev}</td>${mesice.map((m) => f(m)).join("")}</tr>`;
    const td = (m, val, styl, znacka) => `<td class="r num ${tridy(m)}" ${styl || ""}>${val == null ? "" : fmt0.format(Math.round(val))}${znacka ? `<div class="mark">${znacka}</div>` : ""}</td>`;

    app.innerHTML = `<h2>Cash flow</h2>
      <p class="muted">Plán příjmů a výdajů po měsících. <b>Plán</b> = skutečnost minulého měsíce + přírůstek, <b>skutečnost</b> se doplní sama po uzávěrce měsíce.
      Klikni do buňky a zadej částku nebo výpočet. Šipka → u řádku zkopíruje hodnotu do dalších měsíců.</p>
      <div class="toolbar">
        ${starsich ? `<button id="cfStarsi">${cfUi.starsi ? "◂ Skrýt starší měsíce" : `▸ Zobrazit starší měsíce (${starsich})`}</button>` : ""}
        <button id="cfRozbal">${Object.values(cfUi.otevreno || {}).some(Boolean) ? "Sbalit sekce" : "Rozbalit sekce"}</button>
        <div class="grow"></div>
        <span class="legend" style="margin:0"><span><i class="dot" style="background:color-mix(in srgb,var(--good) 35%,transparent)"></i>lepší</span>
        <span><i class="dot" style="background:color-mix(in srgb,var(--bad) 35%,transparent)"></i>horší</span>
        <span><i class="dot fcdot"></i>výhled</span></span>
        <button id="cfNovy">+ Nový řádek</button>
      </div>
      <div class="card scroll" id="cfBox"><table class="cf"><thead>
        <tr class="obdobi"><th class="lbl"></th>
          ${nSkut ? `<th colspan="${nSkut}" class="per skut">Skutečnost · do ${mKratce(hranice)}</th>` : ""}
          ${nVyhl ? `<th colspan="${nVyhl}" class="per fc hr">Výhled →</th>` : ""}</tr>
        <tr><th class="lbl"></th>${mesice.map((m) => `<th class="r ${tridy(m)}">${mKratce(m)}${m === dnes ? '<div class="mark">dnes</div>' : ""}</th>`).join("")}</tr></thead><tbody>
        ${sekce("prijem", "Příjmy", v.prijmy)}
        ${sekce("naklad", "Náklady", v.naklady)}
        <tr class="grp"><td class="lbl">Výsledek</td><td colspan="${mesice.length}"></td></tr>
        ${calc("Přírůstek / úbytek", (m) => td(m, v.prirustek[m], tint(v.prirustek[m], maxAbs),
            nejhorsi.has(m) && v.prirustek[m] < 0 ? "▼ nejhorší" : nejlepsi.has(m) && v.prirustek[m] > 0 ? "▲ nejlepší" : ""))}
        ${calc("Cash flow – plán", (m) => td(m, v.plan[m], m === minPlan ? 'style="outline:2px solid var(--bad);outline-offset:-2px"' : "", m === minPlan ? "▼ minimum" : ""))}
        ${calc("Skutečnost", (m) => td(m, v.skut[m]))}
        ${calc("Rozdíl proti plánu", (m) => td(m, v.diff[m], tint(v.diff[m], maxAbsDiff)))}
      </tbody></table></div>

      <h3>Příjmy, náklady a přírůstek</h3>
      <div class="card chart" id="cfG1"></div>
      <h3>Hotovost: plán a skutečnost</h3>
      <div class="card chart" id="cfG2"></div>`;

    // výchozí pohled: posunout na začátek zobrazených měsíců (u celé historie na dnešek)
    const box = $("#cfBox");
    const th = box.querySelector("thead tr:last-child th.now");
    if (cfUi.starsi && th) box.scrollLeft = th.offsetLeft - box.querySelector("th.lbl").offsetWidth - 200;

    grafCfSloupce($("#cfG1"), mesice, v, jeVyhled);
    grafCfLinie($("#cfG2"), mesice, v, jeVyhled);

    box.addEventListener("click", (e) => {
      const tg = e.target.closest(".tog");
      if (tg) {
        const s = tg.closest("tr").dataset.sekce;
        cfUi.otevreno = { ...(cfUi.otevreno || {}), [s]: !(cfUi.otevreno || {})[s] }; cfUiUloz();
        const sl = box.scrollLeft; render(); $("#cfBox").scrollLeft = sl; return;
      }
      const cell = e.target.closest("td.cell");
      if (cell && !cell.querySelector("input")) editBunku(cell);
      const f = e.target.closest("[data-fill]");
      if (f) vyplnDoprava(f.dataset.fill, vse);
    });
    if (starsich) $("#cfStarsi").onclick = () => { cfUi.starsi = !cfUi.starsi; cfUiUloz(); render(); };
    $("#cfRozbal").onclick = () => {
      const otevrit = !Object.values(cfUi.otevreno || {}).some(Boolean);
      cfUi.otevreno = { prijem: otevrit, naklad: otevrit }; cfUiUloz(); render();
    };
    $("#cfNovy").onclick = async () => {
      const nazev = prompt("Název řádku (např. Auto, Dovolená):"); if (!nazev) return;
      const prijem = confirm("Je to příjem? (OK = příjem, Zrušit = náklad)");
      const row = { id: "cf-" + slug(nazev), sekce: prijem ? "prijem" : "naklad", nazev, poradi: D.cfRadky.reduce((a, x) => Math.max(a, x.poradi), 0) + 10, aktivni: true };
      try {
        await upsert("fin_cf_radky", [row], "id");
        cfUi.otevreno = { ...(cfUi.otevreno || {}), [row.sekce]: true }; cfUiUloz();
        await nacti(); render();
      } catch (err) { toast(err.message, true); }
    };
  }

  // společná kostra grafů cash flow: osa, šrafovaný výhled, popisky měsíců, hover
  function cfKostra(box, mesice, jeVyhled, min, max, legenda, tipHtml, kresli) {
    const W = 760, H = 260, L = 60, B = 26, T = 18, R = 8;
    const rozsah = osaY(Math.max(Math.abs(min), Math.abs(max)));
    const krok = rozsah[1] - rozsah[0];
    const lo = Math.floor(Math.min(0, min) / krok) * krok + (min > 0 ? Math.floor(min / krok) * krok : 0), hi = Math.ceil(max / krok) * krok || krok;
    const ticks = []; for (let t = lo; t <= hi + krok / 2; t += krok) ticks.push(t);
    const y = (val) => T + (H - T - B) * (1 - (val - lo) / (hi - lo));
    const sirka = (W - L - R) / mesice.length;
    const xc = (i) => L + sirka * (i + 0.5);
    const iV = mesice.findIndex(jeVyhled);
    const jedn = hi - lo >= 5e6 ? [1e6, " M"] : [1e3, " tis."];
    let svg = `<svg viewBox="0 0 ${W} ${H}" role="img">
      <defs><pattern id="sraf" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><line x1="0" y1="0" x2="0" y2="6" stroke="var(--line)" stroke-width="2"/></pattern></defs>`;
    if (iV >= 0) svg += `<rect x="${L + sirka * iV}" y="${T - 14}" width="${W - R - L - sirka * iV}" height="${H - B - T + 14}" fill="url(#sraf)" opacity=".7"/>
      <line x1="${L + sirka * iV}" x2="${L + sirka * iV}" y1="${T - 14}" y2="${H - B}" stroke="var(--muted)" stroke-dasharray="4 3"/>
      <g class="axis"><text x="${L + sirka * iV + 6}" y="${T - 4}">výhled →</text></g>`;
    svg += `<g class="grid">${ticks.map((t) => `<line x1="${L}" x2="${W - R}" y1="${y(t)}" y2="${y(t)}" ${t === 0 ? 'stroke="var(--muted)"' : ""}/>`).join("")}</g>`;
    svg += `<g class="axis">${ticks.map((t) => `<text x="${L - 8}" y="${y(t) + 4}" text-anchor="end">${fmt0.format(t / jedn[0])}${jedn[1]}</text>`).join("")}</g>`;
    const kazdy = Math.ceil(mesice.length / 14);
    svg += `<g class="axis">${mesice.map((m, i) => (i % kazdy ? "" : `<text x="${xc(i)}" y="${H - 8}" text-anchor="middle">${mKratce(m)}</text>`)).join("")}</g>`;
    svg += kresli({ y, xc, sirka });
    svg += `<line class="cross" y1="${T}" y2="${H - B}" stroke="var(--muted)" stroke-dasharray="3 3" style="display:none"/>`;
    svg += mesice.map((m, i) => `<rect class="hit" data-i="${i}" x="${L + sirka * i}" y="${T}" width="${sirka}" height="${H - T - B}" fill="transparent"/>`).join("");
    svg += "</svg>";
    box.innerHTML = `<div class="legend">${legenda}</div>${svg}`;
    const cross = box.querySelector(".cross");
    box.querySelectorAll(".hit").forEach((el) => {
      el.addEventListener("mousemove", (ev) => {
        const i = +el.dataset.i;
        cross.setAttribute("x1", xc(i)); cross.setAttribute("x2", xc(i)); cross.style.display = "";
        ukazTip(ev, `<b>${mNazev(mesice[i])}${jeVyhled(mesice[i]) ? " · výhled" : ""}</b>` + tipHtml(mesice[i]), box);
      });
      el.addEventListener("mouseleave", () => { skryjTip(); cross.style.display = "none"; });
    });
  }

  const tipRadek = (barva, nazev, val, cara) => `<div class="row"><span><i class="dot" style="background:${barva}${cara ? ";height:3px;border-radius:0" : ""}"></i> ${nazev}</span><span class="num">${val == null ? "–" : kc(val)}</span></div>`;

  function grafCfSloupce(box, mesice, v, jeVyhled) {
    const hodn = mesice.flatMap((m) => [v.prijmy[m], v.naklady[m], v.prirustek[m]]);
    cfKostra(box, mesice, jeVyhled, Math.min(0, ...hodn), Math.max(...hodn),
      `<span><i class="dot" style="background:var(--c-prijmy)"></i>Příjmy</span><span><i class="dot" style="background:var(--c-naklady)"></i>Náklady</span>
       <span><i class="dot" style="background:var(--text);height:3px;border-radius:0"></i>Přírůstek / úbytek</span>`,
      (m) => tipRadek("var(--c-prijmy)", "Příjmy", v.prijmy[m]) + tipRadek("var(--c-naklady)", "Náklady", v.naklady[m]) +
        `<div class="row" style="margin-top:4px;font-weight:600"><span>Přírůstek</span><span class="num ${znam(v.prirustek[m])}">${plus(v.prirustek[m])} Kč</span></div>`,
      ({ y, xc, sirka }) => {
        const bw = Math.max(2, Math.min(16, sirka * 0.32));
        const sloupec = (x, val, barva, fc) => {
          if (!val) return "";
          const y0 = y(0), y1 = y(val), h = Math.abs(y0 - y1), top = Math.min(y0, y1);
          const r = Math.min(4, h / 2, bw / 2);
          const d = val > 0 ? `M${x},${y0} V${top + r} q0,-${r} ${r},-${r} H${x + bw - r} q${r},0 ${r},${r} V${y0} Z`
                            : `M${x},${y0} V${top + h - r} q0,${r} ${r},${r} H${x + bw - r} q${r},0 ${r},-${r} V${y0} Z`;
          return `<path d="${d}" fill="${barva}" ${fc ? 'fill-opacity=".55"' : ""}/>`;
        };
        let s = mesice.map((m, i) => sloupec(xc(i) - bw - 1, v.prijmy[m], "var(--c-prijmy)", jeVyhled(m)) + sloupec(xc(i) + 1, v.naklady[m], "var(--c-naklady)", jeVyhled(m))).join("");
        s += `<polyline points="${mesice.map((m, i) => `${xc(i).toFixed(1)},${y(v.prirustek[m]).toFixed(1)}`).join(" ")}" fill="none" stroke="var(--text)" stroke-width="2" stroke-linejoin="round"/>`;
        s += mesice.map((m, i) => `<circle cx="${xc(i)}" cy="${y(v.prirustek[m])}" r="3.5" fill="${v.prirustek[m] < 0 ? "var(--bad)" : "var(--good)"}" stroke="var(--tile)" stroke-width="1.5"/>`).join("");
        return s;
      });
  }

  function grafCfLinie(box, mesice, v, jeVyhled) {
    const hodn = mesice.flatMap((m) => [v.plan[m], v.skut[m]]).filter((x) => x != null);
    const maxV = Math.max(...hodn);
    const planVyhl = mesice.filter(jeVyhled).map((m) => v.plan[m]);
    const minV = planVyhl.length ? Math.min(...planVyhl) : null;
    cfKostra(box, mesice, jeVyhled, Math.min(...hodn) * 0.85, maxV,
      `<span><i class="dot" style="background:var(--c-plan);height:3px;border-radius:0"></i>Plán</span><span><i class="dot" style="background:var(--c-hotovost);height:3px;border-radius:0"></i>Skutečnost</span>
       ${minV != null ? `<span class="small">nejnižší plánovaná hotovost: <b class="num">${kc(minV)}</b></span>` : ""}`,
      (m) => tipRadek("var(--c-plan)", "Plán", v.plan[m], true) + tipRadek("var(--c-hotovost)", "Skutečnost", v.skut[m], true) +
        (v.diff[m] != null ? `<div class="row" style="margin-top:4px"><span>Rozdíl</span><span class="num ${znam(v.diff[m])}">${plus(v.diff[m])} Kč</span></div>` : ""),
      ({ y, xc }) => {
        const cara = (f, barva, dash) => {
          const body = mesice.map((m, i) => (f(m) == null ? null : `${xc(i).toFixed(1)},${y(f(m)).toFixed(1)}`)).filter(Boolean);
          return body.length ? `<polyline points="${body.join(" ")}" fill="none" stroke="${barva}" stroke-width="2" stroke-linejoin="round" ${dash ? 'stroke-dasharray="5 4"' : ""}/>` : "";
        };
        const iMin = minV == null ? -1 : mesice.findIndex((m) => v.plan[m] === minV && jeVyhled(m));
        return cara((m) => v.plan[m], "var(--c-plan)", true) + cara((m) => v.skut[m], "var(--c-hotovost)") +
          mesice.map((m, i) => (v.skut[m] != null ? `<circle cx="${xc(i)}" cy="${y(v.skut[m])}" r="3" fill="var(--c-hotovost)" stroke="var(--tile)" stroke-width="1.5"/>` : "")).join("") +
          (iMin >= 0 ? `<circle cx="${xc(iMin)}" cy="${y(minV)}" r="6" fill="none" stroke="var(--bad)" stroke-width="2"/><g class="axis"><text x="${xc(iMin)}" y="${y(minV) + 20}" text-anchor="middle" style="fill:var(--bad)">▼ minimum</text></g>` : "");
      });
  }

  function editBunku(td) {
    const key = sk(td.dataset.r, td.dataset.m), c = D.cf.get(key);
    const kf = kurzy(td.dataset.m);
    td.innerHTML = `<input value="${esc(c ? c.vyraz || c.castka || "" : "")}">`;
    const inp = td.querySelector("input"); inp.focus(); inp.select();
    let hotovo = false;
    const konec = async (ulozit) => {
      if (hotovo) return; hotovo = true;
      const t = inp.value.trim();
      if (ulozit && t !== String(c ? c.vyraz || c.castka || "" : "")) {
        const v = t === "" ? null : spocti(t, kf);
        if (isNaN(v)) { toast("Chybný výpočet.", true); render(); return; }
        try {
          if (v == null && !c?.poznamka) { await db.from("fin_cf").delete().eq("radek_id", td.dataset.r).eq("mesic", td.dataset.m); }
          else await upsert("fin_cf", [{ radek_id: td.dataset.r, mesic: td.dataset.m, castka: v, vyraz: jeVyraz(t) ? t : null, poznamka: c?.poznamka || null }], "radek_id,mesic");
          const sl = $("#cfBox").scrollLeft;
          await nacti(); render(); $("#cfBox").scrollLeft = sl;
        } catch (err) { toast(err.message, true); }
      } else render();
    };
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") konec(true); if (e.key === "Escape") konec(false); });
    inp.addEventListener("blur", () => konec(true));
  }

  async function vyplnDoprava(rid, mesice) {
    const vypl = mesice.filter((m) => D.cf.get(sk(rid, m))?.castka != null);
    const z = vypl.filter((m) => m <= mDnes()).pop() || vypl.pop();
    if (!z) return toast("Řádek nemá žádnou hodnotu.", true);
    const c = D.cf.get(sk(rid, z));
    const cil = mesice.filter((m) => m > z && D.cf.get(sk(rid, m))?.castka == null);
    if (!cil.length) return toast("Další měsíce už jsou vyplněné.");
    if (!confirm(`Doplnit ${fmt0.format(c.castka)} z ${mKratce(z)} do ${cil.length} prázdných měsíců (do ${mKratce(cil[cil.length - 1])})?`)) return;
    try {
      await upsert("fin_cf", cil.map((m) => ({ radek_id: rid, mesic: m, castka: c.castka, vyraz: null, poznamka: null })), "radek_id,mesic");
      await nacti(); render();
    } catch (err) { toast(err.message, true); }
  }

  // ---------- stránka: Export a import ----------
  function strData(app) {
    app.innerHTML = `<h2>Export a import</h2>
      <div class="twocol">
        <div class="card"><h3 style="margin-top:0">Export</h3>
          <p>Excel se souhrnem, stavy všech položek po měsících, seznamem smluv a cash flow.</p>
          <div class="toolbar"><button class="primary" id="exXlsx">Stáhnout Excel (.xlsx)</button><button id="exJson">Záloha (.json)</button></div>
          <p class="small muted">Záloha JSON obsahuje úplně všechno a jde z ní data kdykoli obnovit tady vedle.</p></div>
        <div class="card"><h3 style="margin-top:0">Import / obnova</h3>
          <p>Nahraje soubor <span class="num">rodinne-finance-import.json</span> (převod z Excelu) nebo zálohu. Existující záznamy se stejným klíčem se přepíšou, nic se nemaže.</p>
          <div class="toolbar"><input type="file" id="imFile" accept=".json,application/json"><button id="imGo" disabled>Nahrát</button></div>
          <p class="small muted" id="imInfo"></p></div>
      </div>
      <h3>Stav databáze</h3>
      <div class="card small">${D.polozky.length} položek · ${D.stavy.size} stavů · ${D.mesice.size} měsíců (${[...D.mesice.values()].filter((x) => x.uzavreno).length} uzavřených) · ${D.cfRadky.length} řádků cash flow · ${D.cf.size} hodnot cash flow</div>`;
    $("#exJson").onclick = () => stahni(new Blob([JSON.stringify(zaloha(), null, 1)], { type: "application/json" }), `rodinne-finance-${new Date().toISOString().slice(0, 10)}.json`);
    $("#exXlsx").onclick = exportXlsx;
    let soubor = null;
    $("#imFile").onchange = async (e) => {
      try {
        soubor = JSON.parse(await e.target.files[0].text());
        if (soubor.format !== "rodinne-finance") throw new Error("Neznámý formát souboru.");
        $("#imInfo").textContent = `${soubor.polozky.length} položek, ${soubor.stavy.length} stavů, ${soubor.cf.length} hodnot cash flow.`;
        $("#imGo").disabled = false;
      } catch (err) { soubor = null; $("#imGo").disabled = true; $("#imInfo").textContent = "Soubor nejde přečíst: " + err.message; }
    };
    $("#imGo").onclick = async () => {
      if (!soubor || !confirm("Nahrát data do databáze?")) return;
      $("#imGo").disabled = true; $("#imInfo").textContent = "Nahrávám…";
      try {
        await upsert("fin_polozky", soubor.polozky, "id");
        await upsert("fin_cf_radky", soubor.cf_radky, "id");
        await upsert("fin_stavy", soubor.stavy, "polozka_id,mesic");
        await upsert("fin_mesice", soubor.mesice, "mesic");
        await upsert("fin_historie", soubor.historie, "mesic,ukazatel");
        await upsert("fin_cf", soubor.cf, "radek_id,mesic");
        await nacti(); toast("Data nahrána."); location.hash = "#prehled";
      } catch (err) { $("#imInfo").textContent = "Chyba: " + err.message; $("#imGo").disabled = false; }
    };
  }

  function zaloha() {
    return {
      format: "rodinne-finance", verze: 1, vytvoreno: new Date().toISOString(),
      polozky: D.polozky, stavy: [...D.stavy.values()], mesice: [...D.mesice.values()],
      historie: [...D.historie.entries()].map(([k, castka]) => { const [ukazatel, mesic] = k.split("|"); return { mesic, ukazatel, castka }; }),
      cf_radky: D.cfRadky, cf: [...D.cf.values()],
    };
  }

  function stahni(blob, nazev) {
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = nazev;
    document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  function exportXlsx() {
    if (!window.XLSX) return toast("Knihovna pro Excel se ještě načítá, zkus to za chvíli.", true);
    const wb = XLSX.utils.book_new();
    const ms = C.mesice.slice().reverse();
    // Souhrn
    const sou = [["", ...ms.map(mNazev)]];
    for (const k of ["penzijka", "investice", "nemovitosti", "hotovost", "hypoteky"]) sou.push([KATEGORIE[k].nazev, ...ms.map((m) => Math.round(C.souhrn.get(m).kat[k] || 0))]);
    sou.push(["Čisté jmění", ...ms.map((m) => Math.round(C.souhrn.get(m).celkem))]);
    sou.push([]); sou.push(["Kurz EUR", ...ms.map((m) => kurzy(m).eur)]); sou.push(["Kurz GBP", ...ms.map((m) => kurzy(m).gbp)]); sou.push(["Kurz PHP", ...ms.map((m) => kurzy(m).php)]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sou), "Souhrn");
    // Stavy (v měně položky) – nejnovější měsíc vlevo jako dřív
    const vseM = C.vse.slice().reverse();
    const st = [["Kategorie", "Položka", "Osoba", "Instituce", "Měna", ...vseM.map(mNazev)]];
    for (const p of D.polozky.filter((x) => !["platby", "sporeni"].includes(x.kategorie)))
      st.push([KATEGORIE[p.kategorie].nazev, p.nazev, p.osoba, p.instituce, p.mena, ...vseM.map((m) => { const s = D.stavy.get(sk(p.id, m)); return s?.castka != null ? Number(s.castka) : null; })]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(st), "Stavy");
    // Smlouvy a položky
    const klice = [...new Set(D.polozky.flatMap((p) => Object.keys(p.info || {})))];
    const pol = [["Kategorie", "Název", "Osoba", "Instituce", "Měna", "Aktivní", "Měsíčně (platby)", ...klice.map((k) => INFO_POPISY[k] || k)]];
    for (const p of D.polozky) pol.push([KATEGORIE[p.kategorie].nazev, p.nazev, p.osoba, p.instituce, p.mena, p.aktivni ? "ano" : "ne", p.kategorie === "platby" ? Math.round(mesicne(p.info)) : null, ...klice.map((k) => p.info?.[k] ?? null)]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(pol), "Majetek a smlouvy");
    // Cash flow
    const cm = cfMesice(), v = cfVypocet(cm);
    const cf = [["", ...cm.map(mKratce)]];
    for (const s of ["prijem", "naklad"]) {
      cf.push([s === "prijem" ? "PŘÍJMY" : "NÁKLADY"]);
      for (const r of D.cfRadky.filter((x) => x.sekce === s)) cf.push([r.nazev, ...cm.map((m) => { const c = D.cf.get(sk(r.id, m)); return c?.castka != null ? Number(c.castka) : null; })]);
    }
    cf.push([]);
    for (const [n, o] of [["Přírůstek/(úbytek)", v.prirustek], ["Cash flow – plán", v.plan], ["Skutečnost", v.skut], ["Rozdíl", v.diff]]) cf.push([n, ...cm.map((m) => (o[m] == null ? null : Math.round(o[m])))]);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(cf), "Cash flow");
    // Historie hotovosti
    const h = [["Měsíc", "Hotovost (Kč)"]];
    const mesH = new Set([...D.historie.keys()].filter((k) => k.startsWith("hotovost|")).map((k) => k.split("|")[1])); C.vse.forEach((m) => mesH.add(m));
    [...mesH].sort().forEach((m) => { const x = hotovost(m); if (x) h.push([mNazev(m), Math.round(x)]); });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(h), "Historie hotovosti");
    XLSX.writeFile(wb, `rodinne-finance-${new Date().toISOString().slice(0, 10)}.xlsx`);
  }

  // ---------- router ----------
  const STRANKY = { prehled: strPrehled, uzaverka: strUzaverka, polozky: strPolozky, cashflow: strCashflow, data: strData };
  function render() {
    const id = (location.hash || "#prehled").slice(1);
    const fn = STRANKY[id] || strPrehled;
    document.querySelectorAll("#tabs a").forEach((a) => a.classList.toggle("on", a.getAttribute("href") === "#" + (STRANKY[id] ? id : "prehled")));
    skryjTip();
    const old = $("#app"), app = old.cloneNode(false);   // nový prvek = žádné staré posluchače
    old.replaceWith(app);
    try { fn(app); } catch (e) { console.error(e); app.innerHTML = `<div class="note">Chyba při zobrazení: ${esc(e.message)}</div>`; }
  }
  window.addEventListener("hashchange", render);

  async function start() {
    const s = await window.RodinaAuth.vyzadujPrihlaseni();
    if (!s) return;
    uzivatel = s; db = window.RodinaAuth.client;
    $("#kdo").innerHTML = `${esc(s.jmeno)} · <button id="odhl">odhlásit</button>`;
    $("#odhl").onclick = () => window.RodinaAuth.odhlasit();
    try { await nacti(); }
    catch (e) {
      $("#app").innerHTML = `<div class="note">Nepodařilo se načíst data: ${esc(e.message)}<br>Pokud jde o první spuštění, je potřeba v Supabase spustit <span class="num">supabase/schema.sql</span> (viz README).</div>`;
      return;
    }
    render();
  }
  start();
})();
