// Smyšlená data pro ukázkový režim (?demo). Rodina Novákových, žádná skutečná čísla.
// Tvar odpovídá tabulkám v supabase/schema.sql.
window.DEMO_DATA = (function () {
  "use strict";
  const mKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-01`;
  const dnes = new Date();
  // 18 uzavřených měsíců končících minulým měsícem
  const mesice = [];
  for (let i = 18; i >= 1; i--) mesice.push(mKey(new Date(dnes.getFullYear(), dnes.getMonth() - i, 1)));
  // cash flow plán ještě 12 měsíců dopředu
  const cfMesice = [...mesice];
  for (let i = 0; i <= 12; i++) cfMesice.push(mKey(new Date(dnes.getFullYear(), dnes.getMonth() + i, 1)));

  const polozky = [
    { id: "demo-bezny",     kategorie: "hotovost",    nazev: "Běžný účet",          osoba: "Rodina", instituce: "Banka Alfa",  mena: "CZK", poradi: 10, aktivni: true, info: { ucty: "123456789/0000" } },
    { id: "demo-sporici",   kategorie: "hotovost",    nazev: "Spořicí účet",        osoba: "Eva",    instituce: "Banka Beta",  mena: "CZK", poradi: 20, aktivni: true, info: {} },
    { id: "demo-eur",       kategorie: "hotovost",    nazev: "Účet v eurech",       osoba: "Petr",   instituce: "Banka Alfa",  mena: "EUR", poradi: 30, aktivni: true, info: {} },
    { id: "demo-etf",       kategorie: "investice",   nazev: "ETF portfolio",       osoba: "Petr",   instituce: "Broker X",    mena: "EUR", poradi: 40, aktivni: true, info: { popis: "světové akcie, pravidelná investice" } },
    { id: "demo-fond",      kategorie: "investice",   nazev: "Podílový fond",       osoba: "Eva",    instituce: "Investiční společnost Y", mena: "CZK", poradi: 50, aktivni: true, info: {} },
    { id: "demo-dps-petr",  kategorie: "penzijka",    nazev: "Penzijní spoření",    osoba: "Petr",   instituce: "Penzijní společnost Z", mena: "CZK", poradi: 60, aktivni: true, info: { cislo: "DEMO-001" } },
    { id: "demo-dps-eva",   kategorie: "penzijka",    nazev: "Penzijní spoření",    osoba: "Eva",    instituce: "Penzijní společnost Z", mena: "CZK", poradi: 70, aktivni: true, info: { cislo: "DEMO-002" } },
    { id: "demo-byt",       kategorie: "nemovitosti", nazev: "Byt 2+kk",            osoba: "Rodina", instituce: "",            mena: "CZK", poradi: 80, aktivni: true, info: { porizovaci_cena: "4 200 000" } },
    { id: "demo-dum",       kategorie: "nemovitosti", nazev: "Novostavba RD",       osoba: "Rodina", instituce: "",            mena: "CZK", poradi: 90, aktivni: true, info: { pricist_cf: "demo-cf-dum" } },
    { id: "demo-hypo",      kategorie: "hypoteky",    nazev: "Hypotéka na byt",     osoba: "Rodina", instituce: "Banka Alfa",  mena: "CZK", poradi: 100, aktivni: true, info: { cislo: "HU-DEMO" } },
    { id: "demo-poj-dum",   kategorie: "platby",      nazev: "Pojištění domácnosti", osoba: "Rodina", instituce: "Pojišťovna Q", mena: "CZK", poradi: 110, aktivni: true, info: { castka: 6000, frekvence: "ročně", z_uctu: "Běžný účet" } },
    { id: "demo-poj-zivot", kategorie: "platby",      nazev: "Životní pojištění",   osoba: "Petr",   instituce: "Pojišťovna Q", mena: "CZK", poradi: 120, aktivni: true, info: { castka: 1200, frekvence: "měsíčně", z_uctu: "Běžný účet" } },
    { id: "demo-skolne",    kategorie: "platby",      nazev: "Kroužky dětí",        osoba: "Rodina", instituce: "",            mena: "CZK", poradi: 130, aktivni: true, info: { castka: 9000, frekvence: "kvartálně" } },
  ];

  const cf_radky = [
    { id: "demo-cf-mzda-p", sekce: "prijem", nazev: "Mzda Petr",       poradi: 10, aktivni: true },
    { id: "demo-cf-mzda-e", sekce: "prijem", nazev: "Mzda Eva",        poradi: 20, aktivni: true },
    { id: "demo-cf-najem",  sekce: "prijem", nazev: "Nájem z bytu",    poradi: 30, aktivni: true },
    { id: "demo-cf-domac",  sekce: "naklad", nazev: "Domácnost",       poradi: 40, aktivni: true },
    { id: "demo-cf-hypo",   sekce: "naklad", nazev: "Splátka hypotéky", poradi: 50, aktivni: true },
    { id: "demo-cf-inv",    sekce: "naklad", nazev: "Pravidelná investice", poradi: 60, aktivni: true },
    { id: "demo-cf-dum",    sekce: "naklad", nazev: "Dům – platby stavby", poradi: 70, aktivni: true },
  ];

  // jednoduchý deterministický „šum“, ať data vypadají živě, ale vždy stejně
  const sum = (i, a) => Math.round(Math.sin(i * 1.7 + a) * 1000) / 1000;

  const stavy = [], mesiceRows = [], cf = [], historie = [];
  let dum = 2_400_000, rezerva = 450_000;
  // čistý měsíční přebytek podle cash flow níže: příjmy 138 500 − náklady (domácnost, hypotéka, investice, stavba)
  const platbaStavby = (i) => (i % 3 === 0 ? 120_000 : 0);
  const domacnost = (i) => 48_000 + (i % 4 === 0 ? 12_000 : 0);
  mesice.forEach((m, i) => {
    const eur = 24.6 + sum(i, 1) * 0.5, gbp = 28.9 + sum(i, 2) * 0.6, php = 0.42 + sum(i, 3) * 0.01;
    mesiceRows.push({ mesic: m, eur: +eur.toFixed(3), gbp: +gbp.toFixed(3), php: +php.toFixed(4), kurzy_zdroj: "ukázka", uzavreno: new Date(m).toISOString(), uzavrel: "Ukázka", poznamka: null });
    dum += platbaStavby(i);
    rezerva += 138_500 - domacnost(i) - 16_400 - 10_000 - platbaStavby(i);
    const s = (id, castka) => stavy.push({ polozka_id: id, mesic: m, castka: Math.round(castka * 100) / 100, vyraz: null, zdroj: "ukázka", upraveno: new Date(m).toISOString() });
    s("demo-bezny",    85_000 + sum(i, 4) * 30_000);
    s("demo-sporici",  rezerva + sum(i, 5) * 15_000);
    s("demo-eur",      3_200 + sum(i, 6) * 600);
    s("demo-etf",      14_000 + i * 420 + sum(i, 7) * 900);
    s("demo-fond",     310_000 + i * 6_500 + sum(i, 8) * 9_000);
    s("demo-dps-petr", 182_000 + i * 2_100);
    s("demo-dps-eva",  146_000 + i * 1_800);
    s("demo-byt",      i < 9 ? 6_100_000 : 6_350_000);
    s("demo-dum",      dum);
    s("demo-hypo",     2_150_000 - i * 11_500);
  });
  cfMesice.forEach((m, i) => {
    const c = (radek_id, castka) => cf.push({ radek_id, mesic: m, castka, vyraz: null, poznamka: null });
    c("demo-cf-mzda-p", 68_000);
    c("demo-cf-mzda-e", 52_000);
    c("demo-cf-najem",  18_500);
    c("demo-cf-domac",  domacnost(i));
    c("demo-cf-hypo",   16_400);
    c("demo-cf-inv",    10_000);
    c("demo-cf-dum",    platbaStavby(i));
  });
  // starší souhrnná historie hotovosti
  for (let i = 1; i <= 12; i++) {
    const d = new Date(dnes.getFullYear(), dnes.getMonth() - 18 - i, 1);
    historie.push({ mesic: mKey(d), ukazatel: "hotovost", castka: 900_000 - i * 15_000 });
  }

  return { fin_polozky: polozky, fin_stavy: stavy, fin_mesice: mesiceRows, fin_historie: historie, fin_cf_radky: cf_radky, fin_cf: cf };
})();
