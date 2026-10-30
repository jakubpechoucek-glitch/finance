# Rodinné finance

Webová náhrada Excelu „aktiva a pasiva“: přehled majetku, měsíční uzávěrka stavů
účtů a investic a plán cash flow. Běží na GitHub Pages, data jsou v Supabase
a přístup mají jen přihlášení členové rodiny (společné přihlášení z Rozcestníku).

Adresa: <https://jakubpechoucek-glitch.github.io/finance/>

## Co aplikace umí

| Záložka | K čemu je |
|---|---|
| **Přehled** | Čisté jmění, rozpad na nemovitosti / hotovost / investice / penzijku, graf vývoje, souhrnná tabulka po měsících s procentní změnou (dřív řádky 73–84), rozpad podle osoby a měny, hotovost od roku 2020. |
| **Uzávěrka měsíce** | Jedna obrazovka místo 10 ručních kroků. Vyplníš stavy ke konci měsíce, načteš kurzy ČNB a klikneš na „Uzavřít měsíc“. |
| **Majetek a smlouvy** | Seznam účtů, investic, penzijka, nemovitostí, hypoték a pravidelných plateb včetně čísel smluv, VS, frekvence plateb a měsíčního přepočtu. Úpravy, přidání a ukončení položek. |
| **Cash flow** | Plán příjmů a výdajů po měsících, plán proti skutečnosti a rozdíl. Skutečnost se doplní sama po uzávěrce. |
| **Export a import** | Stažení do Excelu (.xlsx), plná záloha (.json) a obnova ze zálohy. |

## Měsíční uzávěrka – postup

Místo původních 10 kroků:

1. Po skončení měsíce otevři **Uzávěrka měsíce**. Automaticky se nabídne první neuzavřený měsíc.
2. Klikni **Načíst kurzy ČNB**. Kurz se vezme k poslednímu dni měsíce. Kdyby ČNB
   z prohlížeče nešla načíst, použijí se kurzy ECB a jde je i přepsat ručně.
3. Do políček opiš stavy z výpisů. Jde psát i výpočet jako v Excelu:
   - `7585+250537` (běžný + spořicí účet)
   - `20575*eur+80` (XTB v eurech přepočtené kurzem měsíce; dále jdou použít i `gbp` a `php`)
4. **RD Cvrčovice** se předvyplní sám jako minulá hodnota + platba stavby za daný měsíc
   z cash flow (řádek „Dům Cvrčovice“). To nahrazuje bývalý krok 4. Předtím zkontroluj,
   že v cash flow je u toho měsíce skutečně zaplacená částka.
5. Co se nezměnilo (nemovitosti, nulové účty…), nech prázdné. Při uzavření se převezme
   hodnota z minulého měsíce. Tlačítko **Doplnit prázdné z minulého měsíce** to udělá hned.
6. **Uložit rozpracované** = rozdělanou práci jde dokončit později.
   **Uzavřít měsíc** = měsíc je hotový a objeví se v přehledu i v cash flow jako skutečnost.

Kroky 3 a 5–10 z Excelu (kopírování sloupců, přepisování vzorců a odkazů) odpadají
úplně. Souhrny se počítají samy z uložených stavů.

Uzavřený měsíc jde kdykoli znovu otevřít (výběr měsíce nahoře) a opravit.

## Jak se počítá

- **Stav položky** se ukládá v její měně (CZK, EUR, GBP, PHP) vždy ke konci měsíce.
  Když položka v nějakém měsíci stav nemá, bere se poslední známý.
- **Přepočet na Kč** používá kurzy uložené u daného měsíce. Pro měsíce převedené
  z Excelu jsou to tehdejší pevné kurzy (24,15 / 24,25 Kč za EUR atd.), takže čísla sedí s Excelem.
- **Čisté jmění** = nemovitosti + hotovost + investice + penzijka − hypotéky.
- **Hotovost** před srpnem 2025 (kdy ještě nebyly stavy po účtech) se bere z historické
  tabulky hotovosti z Excelu (od ledna 2020).
- **Cash flow**: přírůstek = příjmy − náklady; plán = skutečnost minulého měsíce + přírůstek;
  skutečnost = hotovost na konci měsíce (po uzávěrce); rozdíl = skutečnost − plán.
  Šipka → u řádku zkopíruje poslední hodnotu do dalších prázdných měsíců (náhrada vzorců `=AD12`).

## První spuštění (jednorázově)

1. **Databáze:** v Supabase (projekt Rozcestníku) otevři *SQL Editor*, vlož obsah
   [`supabase/schema.sql`](supabase/schema.sql) a spusť ho. Vytvoří tabulky `fin_*`
   s ochranou „jen rodina“ (využívá existující funkci `je_clen()` a tabulku `clenove`).
2. **GitHub Pages:** v repozitáři *Settings → Pages → Build and deployment*:
   Source *Deploy from a branch*, výchozí větev repozitáře (ideálně `main`), složka `/ (root)`.
3. **Data z Excelu:** otevři aplikaci → **Export a import** → vyber soubor
   `rodinne-finance-import.json` → **Nahrát**. Soubor obsahuje všechna data z Excelu
   a v repozitáři záměrně **není**, protože repozitář může být veřejný.

Co se z Excelu převedlo:

- 69 položek (účty, investice, penzijka, stavební spoření, nemovitosti, hypotéky, pravidelné platby a pojištění)
- stavy účtů 08/2025–09/2026 a stavy investic a nemovitostí 10/2025–09/2026
- kurzy, s jakými Excel počítal
- historie hotovosti od 01/2020
- cash flow 08/2023–06/2028 včetně skutečnosti

Uzavřené smlouvy a zrušené účty (J&T, Portu EUR, splacené hypotéky, vyplacené stavební
spoření, „Matěj – Portu“ bez hodnoty od 11/2025…) jsou vedené jako ukončené. Historie
zůstává a v Majetku a smlouvách je zobrazí volba „zobrazit i ukončené“.

Listy „účty u bank – procenta“ a „Kurzovní lístek“ se nepřeváděly. Nájemní smlouvy
a výnosy bytů řeší samostatná aplikace Byty k pronájmu.

## Výpisy na Dropboxu (připravuje se)

Výpisy z bank a investičních společností se budou ukládat do Dropboxu:

```
Dropbox/Rodinné finance/Výpisy/2026-10/   ← výpisy za říjen 2026
Dropbox/Rodinné finance/Výpisy/2026-11/
…
```

Další krok: naplánovaná úloha, která na začátku měsíce projde složku minulého měsíce,
z výpisů vytáhne konečné zůstatky a uloží je do uzávěrky jako návrh (se štítkem
„z výpisu“). Ty pak v Uzávěrce jen zkontroluješ a měsíc uzavřeš.

## Technika

- `index.html` – vzhled (stejný styl jako Rozcestník, světlý i tmavý režim)
- `app.js` – celá aplikace (bez build kroku a bez frameworku)
- `supabase/schema.sql` – tabulky a pravidla přístupu
- přihlášení: `/rozcestnik/auth.js` (sdílené s ostatními weby na stejné doméně)
- export do Excelu: knihovna SheetJS z cdnjs

### Tabulky

| Tabulka | Obsah |
|---|---|
| `fin_polozky` | účty, smlouvy a majetek (kategorie, osoba, instituce, měna, aktivní, `info` s detaily) |
| `fin_stavy` | stav položky ke konci měsíce (`castka` v měně položky, `vyraz` = zadaný výpočet, `zdroj`) |
| `fin_mesice` | kurzy EUR/GBP/PHP pro měsíc a informace o uzavření |
| `fin_historie` | souhrny z doby před podrobnými daty (`hotovost`, `cf_skutecnost`) |
| `fin_cf_radky`, `fin_cf` | řádky cash flow a jejich hodnoty po měsících |

Měsíc se vždy ukládá jako první den měsíce (`2026-10-01` = stav ke konci října 2026).

U položky RD Cvrčovice je v `info.pricist_cf` uvedený řádek cash flow, jehož platby
se při uzávěrce přičítají k minulé hodnotě. Stejně jde nastavit i jiná položka.
