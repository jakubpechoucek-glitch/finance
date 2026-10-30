-- Rodinné finance – tabulky v Supabase
--
-- Spustit jednou v Supabase → SQL Editor (projekt, který používá Rozcestník).
-- Skript jde pustit opakovaně, nic nesmaže.
--
-- Přístup: jen přihlášení členové rodiny (funkce public.je_clen() z Rozcestníku,
-- tabulka clenove). Veřejný klíč v aplikaci sám o sobě k datům nepustí.

-- Položky: účty, investice, penzijka, nemovitosti, hypotéky, pravidelné platby…
create table if not exists public.fin_polozky (
  id         text primary key,                       -- např. 'ucet-jana-moneta-czk'
  kategorie  text not null check (kategorie in
             ('hotovost','investice','penzijka','nemovitosti','hypoteky','sporeni','platby')),
  nazev      text not null,
  osoba      text,                                   -- Jana / Jakub / Matěj / Lukáš / Rodina
  instituce  text,
  mena       text not null default 'CZK',            -- CZK, EUR, GBP, PHP
  poradi     int  not null default 0,
  aktivni    boolean not null default true,
  info       jsonb not null default '{}'::jsonb      -- číslo smlouvy, účel, platba, frekvence, částka, VS…
);

-- Stav položky ke konci měsíce (v měně položky)
create table if not exists public.fin_stavy (
  polozka_id text not null references public.fin_polozky(id) on update cascade on delete cascade,
  mesic      date not null,                          -- vždy 1. den měsíce = stav ke konci toho měsíce
  castka     numeric,
  vyraz      text,                                   -- jak bylo zadáno, např. '7585+250537'
  zdroj      text,                                   -- 'excel' | 'ručně' | 'dropbox'
  upraveno   timestamptz not null default now(),
  primary key (polozka_id, mesic)
);

-- Měsíce: kurzy pro přepočet a stav uzávěrky
create table if not exists public.fin_mesice (
  mesic       date primary key,
  eur         numeric,                               -- CZK za 1 EUR
  gbp         numeric,
  php         numeric,
  kurzy_zdroj text,
  uzavreno    timestamptz,                           -- null = rozpracováno
  uzavrel     text,
  poznamka    text
);

-- Souhrnná historie z doby před podrobnými stavy (hotovost od 2020, skutečnost cash flow)
create table if not exists public.fin_historie (
  mesic    date not null,
  ukazatel text not null,                            -- 'hotovost' | 'cf_skutecnost'
  castka   numeric,
  primary key (mesic, ukazatel)
);

-- Cash flow: řádky (příjmy/náklady) a hodnoty po měsících
create table if not exists public.fin_cf_radky (
  id      text primary key,
  sekce   text not null check (sekce in ('prijem','naklad')),
  nazev   text not null,
  poradi  int  not null default 0,
  aktivni boolean not null default true
);

create table if not exists public.fin_cf (
  radek_id  text not null references public.fin_cf_radky(id) on update cascade on delete cascade,
  mesic     date not null,
  castka    numeric,
  vyraz     text,
  poznamka  text,
  primary key (radek_id, mesic)
);

-- Řádková ochrana: číst i zapisovat smí jen člen rodiny
do $$
declare t text;
begin
  foreach t in array array['fin_polozky','fin_stavy','fin_mesice','fin_historie','fin_cf_radky','fin_cf'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "jen rodina" on public.%I', t);
    execute format('create policy "jen rodina" on public.%I for all to authenticated
                    using (public.je_clen()) with check (public.je_clen())', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('revoke all on public.%I from anon', t);
  end loop;
end $$;
