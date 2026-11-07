#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Grafy živé přesnosti — Bude pršet
====================================

Stáhne zabalancovanou historii sběrače (Worker, KV klíče raw/, TTL 14 dní)
a z naměřených párů „předpověď × pozorování“ vykreslí tři grafy do
docs/graphics/ + stats.json (badge pro README, formát shields.io endpoint).

Data: GET {BP_WORKER_URL}/analysis/page?h=YYYYMMDDHH → všech 12 dílků hodiny.
  záznam místa: fc (hourly pravděpodobnost deště pp[], h0), ens, met (METAR),
  rv (radar RainViewer, medián mm/h z 3×3 pixelů).

Metodika (stejná jako ruční analýza 6.–7. 11. 2026):
  - pár = pravděpodobnost fc.pp[k] z hodiny H proti pozorování v hodině H+k,
    k = 0..12 (pp[0] je hodina samotného sběru);
  - ground truth: METAR místa (jev RA/DZ/UP v hlavním těle zprávy —
    parsované VŽDY zastavením na TEMPO/BECMG/NOSIG/RMK, viz oprava #23),
    chybí-li METAR, radar rv.mm > 0,05 mm/h jako druhý svědek;
  - úspěšnost@50 = podíl párů, kde (pp ≥ 50 %) == pozorování;
  - Brierovo skóre = průměr (pp/100 − pozorování)².

Výstup (SVG, tmavý motiv aplikace):
  presnost_horizont.svg — úspěšnost + Brier podle horizontu 0–12 h
  spolehlivost.svg       — diagram spolehlivosti (hlášená × reálná %)
  denni_trend.svg        — úspěšnost + objem párů po dnech (UTC)
  stats.json             — badge shields.io endpoint + souhrn metrik

Provozní režim: denní GitHub Actions (.github/workflows/graphics.yml)
commituje grafy do main s [skip ci]. Worker nedostupný nebo prázdná data
NESELŽOU job — skript skončí kódem 0 bez zápisu (grafy zůstávají staré).

Použití:
  python3 scripts/accuracy_charts.py [--days 7] [--out docs/graphics] \
      [--worker URL] [--dry-run]
Proměnné prostředí: BP_WORKER_URL, BP_DAYS (přebíjejí --days).
"""

import argparse
import datetime as dt
import json
import math
import os
import re
import sys
import time
import urllib.request

DEFAULT_WORKER = "https://bude-prset-proxy.kopaci-podstavec1q.workers.dev"
DEFAULT_DAYS = 7
DEFAULT_OUT = os.path.join("docs", "graphics")
HORIZON_H = 12  # maximum hodnoty k v párování
RV_WET = 0.05   # mm/h — radar jako svědek od této intenzity
USER_AGENT = "bude-prset-charts/1.0"

# ---------------------------------------------------------------- METAR ----
# Věrný port parseMetar z worker/worker.mjs (včetně opravy #23: tělo zprávy
# končí na TEMPO/BECMG/NOSIG/RMK — trendové skupiny nejsou pozorování).
WX_TOKEN_RE = re.compile(
    r"^(-|\+|VC|RE)?(MI|BC|PR|DR|BL|SH|TS|FZ)?"
    r"(DZ|RA|SN|SG|PL|IC|GR|GS|UP)?(DZ|RA|SN|SG|PL|IC|GR|GS|UP)?$"
)


def parse_metar(raw_ob):
    out = {"r": 0, "i": 0, "s": 0, "th": 0, "sh": 0, "re": 0, "vc": 0}
    s = str(raw_ob or "")
    if s.startswith("METAR "):
        s = s[6:]
    elif s.startswith("SPECI "):
        s = s[6:]
    for tok in s.split():
        if tok in ("TEMPO", "BECMG", "NOSIG", "RMK"):
            break
        m = WX_TOKEN_RE.match(tok)
        if not m:
            continue
        pre = m.group(1) or ""
        desc = m.group(2) or ""
        jevy = (m.group(3) or "") + (m.group(4) or "")
        if not desc and not jevy:
            continue
        if pre == "VC":
            out["vc"] = 1
            continue
        if pre == "RE":
            if "RA" in jevy or "DZ" in jevy:
                out["re"] = 1
            continue
        if "RA" in jevy or "DZ" in jevy or "UP" in jevy:
            out["r"] = 1
            out["i"] = 1 if pre == "-" else (3 if pre == "+" else 2)
        if any(x in jevy for x in ("SN", "SG", "PL", "IC", "GR", "GS")):
            out["s"] = 1
        if "TS" in desc or pre == "TS":
            out["th"] = 1
        if "SH" in desc:
            out["sh"] = 1
    return out


# ------------------------------------------------------------- stahování ----
def http_json(url, timeout=25, retries=1):
    last = None
    for attempt in range(retries + 1):
        try:
            req = urllib.request.Request(
                url, headers={"user-agent": USER_AGENT, "accept": "application/json"}
            )
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:  # noqa: BLE001 — síť i JSON v jedné záchytě
            last = e
            if attempt < retries:
                time.sleep(1.5)
    raise RuntimeError("GET %s selhal: %s" % (url, last))


def hour_key(d):
    return "%04d%02d%02d%02d" % (d.year, d.month, d.day, d.hour)


def fetch_pages(worker, days, log):
    """Vrátí {epoch_hodiny: {place: {...}}} pro všechny neprázdné hodiny."""
    now = dt.datetime.now(dt.timezone.utc).replace(minute=0, second=0, microsecond=0)
    start = now - dt.timedelta(days=days)
    pages = {}
    n_req, n_data, n_skip = 0, 0, 0
    cur = start
    while cur <= now - dt.timedelta(hours=1):
        url = "%s/analysis/page?h=%s" % (worker.rstrip("/"), hour_key(cur))
        try:
            page = http_json(url)
        except RuntimeError as e:
            log("VAROVÁNÍ: %s" % e)
            n_skip += 1
            cur += dt.timedelta(hours=1)
            continue
        n_req += 1
        if page.get("found"):
            pages[int(cur.timestamp())] = page
            n_data += 1
        cur += dt.timedelta(hours=1)
    log("Stránek: %d dotazů, %d hodin s daty, %d přeskočeno/chyb." % (n_req, n_data, n_skip))
    return pages


def compact_hour(page):
    """Jedna hodina → {místo: {met, rv, fc(h0, pp)}} (poslední dílek s fc)."""
    out = {}
    for sl in page.get("slices") or []:
        for name, e in (sl.get("p") or {}).items():
            c = out.setdefault(name, {"met": [], "rv": [], "fc": None, "min": -1})
            if e.get("met"):
                # ground truth vždy přepočítat z raw (jednotné pravidlo #23)
                c["met"].append(parse_metar(e["met"].get("raw"))["r"])
            rv = e.get("rv")
            if rv and isinstance(rv.get("mm"), (int, float)):
                c["rv"].append(float(rv["mm"]))
            fc = e.get("fc")
            if fc and fc.get("pp") and fc.get("h0") is not None:
                if sl.get("slice", c["min"]) >= c["min"]:
                    c["fc"] = (int(fc["h0"]), fc["pp"])
                    c["min"] = sl.get("slice", c["min"])
    return out


def outcome(c):
    """0/1 = v hodině pršelo/nepršelo; None = bez svědka."""
    if c["met"]:
        return 1 if 1 in c["met"] else 0
    if c["rv"]:
        return 1 if max(c["rv"]) > RV_WET else 0
    return None


# ------------------------------------------------------------- páry/metry ----
def build_pairs(pages):
    """Páry (den, horizont k, pp, outcome) — fc z hodiny H vs. pozorování H+k."""
    hours = {}
    for ts, page in pages.items():
        hours[ts] = compact_hour(page)
    pairs = []
    for ts in sorted(hours):
        day = dt.datetime.fromtimestamp(ts, dt.timezone.utc).date()
        for name, c in hours[ts].items():
            fc = c["fc"]
            if not fc:
                continue
            h0, pp = fc
            if h0 != ts:  # pp[0] musí být hodina H, ne jiná
                continue
            for k in range(0, HORIZON_H + 1):
                if k >= len(pp) or pp[k] is None:
                    continue
                tgt = hours.get(ts + k * 3600)
                if tgt is None:
                    continue
                tc = tgt.get(name)
                if tc is None:
                    continue
                oc = outcome(tc)
                if oc is None:
                    continue
                pairs.append((day, k, pp[k], oc))
    return pairs, hours


def metrics(pairs):
    """Globální souhrn + rozpady podle horizontu, decilu pp a dne."""
    def acc_brier(sub):
        n = len(sub)
        if not n:
            return None
        hit = sum(1 for _, _, p, o in sub if (p >= 50) == bool(o))
        br = sum((p / 100.0 - o) ** 2 for _, _, p, o in sub) / n
        return {"n": n, "acc": 100.0 * hit / n, "brier": br}

    m = {"total": acc_brier(pairs), "horizon": {}, "decile": {}, "day": {}}
    for k in range(HORIZON_H + 1):
        m["horizon"][k] = acc_brier([p for p in pairs if p[1] == k])
    for d in range(10):
        sub = [p for p in pairs if d * 10 <= p[2] < (d + 1) * 10]
        a = acc_brier(sub)
        if a:
            m["decile"][d] = a
    days = sorted(set(p[0] for p in pairs))
    for d in days:
        m["day"][d] = acc_brier([p for p in pairs if p[0] == d])
    m["wet_share"] = (sum(p[3] for p in pairs) / len(pairs)) if pairs else 0.0
    return m


# ------------------------------------------------------------------ SVG ----
BG, PANEL = "#0A1017", "#0D1521"
TEXT, MUTED, GRID = "#E6EDF3", "#8CA0B3", "#1D2A38"
RAIN, WARN, OKC, BAR = "#A8E4FF", "#FFD98E", "#B9F0C8", "#223349"
FONT = "ui-sans-serif, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif"


def esc(s):
    return (
        str(s).replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    )


def fcs(v, d=1):
    """Český formát čísla: desetinná čárka, tisíce s mezerou neřešíme."""
    return (("%." + str(d) + "f") % v).replace(".", ",")


class Svg:
    def __init__(self, w, h, title):
        self.w, self.h = w, h
        self.b = [
            '<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" '
            'viewBox="0 0 %d %d" role="img" aria-label="%s">'
            % (w, h, w, h, esc(title))
        ]

    def rect(self, x, y, w, h, fill, rx=0, opacity=None):
        o = ' opacity="%s"' % opacity if opacity is not None else ""
        self.b.append('<rect x="%s" y="%s" width="%s" height="%s" rx="%s" fill="%s"%s/>'
                      % (x, y, w, h, rx, fill, o))

    def line(self, x1, y1, x2, y2, stroke, w=1, dash=None, opacity=None):
        da = ' stroke-dasharray="%s"' % dash if dash else ""
        o = ' opacity="%s"' % opacity if opacity is not None else ""
        self.b.append('<line x1="%s" y1="%s" x2="%s" y2="%s" stroke="%s" '
                      'stroke-width="%s" stroke-linecap="round"%s%s/>'
                      % (x1, y1, x2, y2, stroke, w, da, o))

    def poly(self, pts, stroke, w=2.5, fill="none", dash=None):
        da = ' stroke-dasharray="%s"' % dash if dash else ""
        self.b.append('<polyline points="%s" fill="%s" stroke="%s" '
                      'stroke-width="%s" stroke-linejoin="round" '
                      'stroke-linecap="round"%s/>'
                      % (" ".join("%s,%s" % p for p in pts), fill, stroke, w, da))

    def circle(self, x, y, r, fill, stroke=None, sw=0):
        s = ' stroke="%s" stroke-width="%s"' % (stroke, sw) if stroke else ""
        self.b.append('<circle cx="%s" cy="%s" r="%s" fill="%s"%s/>' % (x, y, r, fill, s))

    def text(self, x, y, s, size=13, fill=TEXT, anchor="start", weight=None, mono=False):
        wa = ' font-weight="%s"' % weight if weight else ""
        fa = "ui-monospace, 'Cascadia Mono', Menlo, Consolas, monospace" if mono else FONT
        self.b.append('<text x="%s" y="%s" font-family="%s" font-size="%s" '
                      'fill="%s" text-anchor="%s"%s>%s</text>'
                      % (x, y, fa, size, fill, anchor, wa, esc(s)))

    def save(self, path):
        self.b.append("</svg>")
        with open(path, "w", encoding="utf-8") as f:
            f.write("\n".join(self.b) + "\n")


def head(s, title, sub, w):
    s.rect(0, 0, w, s.h, BG)
    s.text(28, 40, title, size=18, weight="600")
    s.text(28, 62, sub, size=12.5, fill=MUTED)


def foot(s, y, lines):
    for i, ln in enumerate(lines):
        s.text(28, y + i * 17, ln, size=11.5, fill=MUTED)


def chart_horizon(m, gen, out):
    W, H = 940, 470
    s = Svg(W, H, "Úspěšnost a Brierovo skóre podle horizontu předpovědi")
    t = m["total"]
    head(s, "Přesnost podle horizontu předpovědi",
         "práh rozhodnutí 50 %% · %s párů · %s · vygenerováno %s UTC"
         % ("{:,}".format(t["n"]).replace(",", " "), "okno 0–12 h", gen), W)
    L, R, T, B = 78, 78, 96, 74
    pw, ph = W - L - R, H - T - B
    x = lambda k: L + pw * k / HORIZON_H  # noqa: E731
    # sítě + osy
    for pct in (40, 60, 80, 100):
        y = T + ph * (1 - (pct - 40) / 60.0)
        s.line(L, y, L + pw, y, GRID, 1)
        s.text(L - 12, y + 4, "%d" % pct, size=12, fill=MUTED, anchor="end")
    for k in range(HORIZON_H + 1):
        s.text(x(k), T + ph + 24, "%d h" % k if k else "teď", size=12, fill=MUTED, anchor="middle")
    s.text(L - 46, T - 26, "úspěšnost (%)", size=12, fill=RAIN, weight="600")
    s.text(L + pw + 46, T - 26, "Brier (×100)", size=12, fill=WARN, anchor="end", weight="600")
    # sloupce počtu párů
    nmax = max((m["horizon"][k] or {"n": 1})["n"] for k in range(HORIZON_H + 1))
    for k in range(HORIZON_H + 1):
        a = m["horizon"][k]
        if not a:
            continue
        bh = ph * 0.9 * a["n"] / nmax
        s.rect(x(k) - 13, T + ph - bh, 26, bh, BAR, rx=3)
    # úspěšnost
    pts = []
    for k in range(HORIZON_H + 1):
        a = m["horizon"][k]
        if not a:
            continue
        y = T + ph * (1 - (a["acc"] - 40) / 60.0)
        pts.append((x(k), y))
        s.circle(x(k), y, 3.5, RAIN, stroke=BG, sw=1.5)
        if k % 2 == 0 or k == HORIZON_H:
            s.text(x(k), y - 12, fcs(a["acc"], 0) + " %", size=11, fill=TEXT, anchor="middle")
    s.poly(pts, RAIN)
    # Brier ×100 na pravé ose 0–25
    bmax = 25.0
    pts = []
    for k in range(HORIZON_H + 1):
        a = m["horizon"][k]
        if not a:
            continue
        y = T + ph * (1 - min(a["brier"] * 100, bmax) / bmax)
        pts.append((x(k), y))
    s.poly(pts, WARN, w=2, dash="5 5")
    for gv in (0, 5, 10, 15, 20, 25):
        s.text(L + pw + 12, T + ph * (1 - gv / bmax) + 4, "%d" % gv, size=11, fill=MUTED)
    # legenda
    lx = L + pw - 250
    s.line(lx, T - 22, lx + 26, T - 22, RAIN, 2.5)
    s.text(lx + 34, T - 17, "úspěšnost (pp ≥ 50 %)", size=12)
    s.line(lx + 190, T - 22, lx + 216, T - 22, WARN, 2, dash="5 5")
    s.text(lx + 224, T - 17, "Brier ×100", size=12)
    foot(s, H - 26, [
        "pár = pravděpodobnost Open-Meteo pro hodinu H+k z hodiny H × pozorování v H+k (k = 0–12 h)",
        "ground truth: METAR místa (jevy z hlavního těla zprávy, bez TEMPO/BECMG), jinak radar > 0,05 mm/h · sloupce = počet párů · časy UTC",
    ])
    s.save(out)


def chart_reliability(m, gen, out):
    W, H = 640, 560
    s = Svg(W, H, "Diagram spolehlivosti: hlášená × reálná pravděpodobnost deště")
    t = m["total"]
    head(s, "Spolehlivost kalibrace",
         "hlášená × reálná pravděpodobnost · %s párů · %s UTC"
         % ("{:,}".format(t["n"]).replace(",", " "), gen), W)
    L, R, T, B = 74, 40, 100, 92
    pw, ph = W - L - R, H - T - B
    x = lambda p: L + pw * p / 100.0  # noqa: E731
    y = lambda p: T + ph * (1 - p / 100.0)  # noqa: E731
    for gv in (0, 25, 50, 75, 100):
        s.line(L, y(gv), L + pw, y(gv), GRID, 1)
        s.line(x(gv), T, x(gv), T + ph, GRID, 1)
        s.text(L - 12, y(gv) + 4, "%d" % gv, size=12, fill=MUTED, anchor="end")
        s.text(x(gv), T + ph + 22, "%d" % gv, size=12, fill=MUTED, anchor="middle")
    s.poly([(x(0), y(0)), (x(100), y(100))], MUTED, 1.5, dash="4 6")
    s.text(x(97), y(95) - 10, "dokonalá kalibrace", size=11.5, fill=MUTED, anchor="end")
    pts = []
    for d in sorted(m["decile"]):
        a = m["decile"][d]
        cx, cy = x(d * 10 + 5), y(a["acc"])
        pts.append((cx, cy))
        s.circle(cx, cy, 4.5, RAIN, stroke=BG, sw=1.5)
        s.text(cx, cy + 22, "%d" % a["n"], size=10.5, fill=MUTED, anchor="middle")
    if pts:
        s.poly(pts, RAIN)
    s.text(L - 46, T - 26, "reálně pršelo (%)", size=12, fill=RAIN, weight="600")
    s.text(L + pw - 2, T - 26, "hlášená pravděpodobnost (%)", size=12, fill=MUTED, anchor="end")
    foot(s, H - 26, [
        "každý bod = desetina hlášené pravděpodobnosti (25–35 %, …), výška = podíl párů, kde skutečně pršelo, číslo pod bodem = počet párů",
        "body pod úhlopříčkou = aplikace nadhodnocuje, nad = podhodnocuje · tečkovaná čára = ideál",
    ])
    s.save(out)


def chart_daily(m, gen, out):
    days = sorted(m["day"])
    slot = 74 if len(days) <= 10 else max(46, min(74, int(940 / max(len(days), 1))))
    W = max(940, 160 + slot * len(days))
    H = 400
    s = Svg(W, H, "Denní trend úspěšnosti")
    t = m["total"]
    head(s, "Úspěšnost po dnech",
         "práh 50 %% · %s párů za okno · %s UTC" % ("{:,}".format(t["n"]).replace(",", " "), gen), W)
    L, R, T, B = 78, 40, 96, 78
    pw, ph = W - L - R, H - T - B
    x = lambda i: L + slot * i + slot / 2.0  # noqa: E731
    for pct in (40, 60, 80, 100):
        yy = T + ph * (1 - (pct - 40) / 60.0)
        s.line(L, yy, L + pw, yy, GRID, 1)
        s.text(L - 12, yy + 4, "%d" % pct, size=12, fill=MUTED, anchor="end")
    nmax = max(a["n"] for a in m["day"].values())
    pts = []
    for i, d in enumerate(days):
        a = m["day"][d]
        bh = ph * 0.9 * a["n"] / nmax
        s.rect(x(i) - slot * 0.3, T + ph - bh, slot * 0.6, bh, BAR, rx=3)
        yy = T + ph * (1 - (a["acc"] - 40) / 60.0)
        pts.append((x(i), yy))
        s.circle(x(i), yy, 3.5, RAIN, stroke=BG, sw=1.5)
        s.text(x(i), yy - 12, fcs(a["acc"], 0), size=11, fill=TEXT, anchor="middle")
        s.text(x(i), T + ph + 24, "%d. %d." % (d.day, d.month), size=12, fill=MUTED, anchor="middle")
        s.text(x(i), T + ph + 42, "%d párů" % a["n"] if a["n"] < 10 else "{:,}".format(a["n"]).replace(",", " "), size=10.5, fill=MUTED, anchor="middle")
    s.poly(pts, RAIN)
    foot(s, H - 24, [
        "jedna hodnota = všechny páry daného dne UTC (základna předpovědi) · sloupce = počet párů · křivka = úspěšnost na prahu 50 %",
    ])
    s.save(out)


# ----------------------------------------------------------------- main ----
def main():
    ap = argparse.ArgumentParser(description="Grafy živé přesnosti Bude pršet")
    ap.add_argument("--days", type=int, default=int(os.environ.get("BP_DAYS", DEFAULT_DAYS)))
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--worker", default=os.environ.get("BP_WORKER_URL", DEFAULT_WORKER))
    ap.add_argument("--dry-run", action="store_true", help="jen metriky na stdout, bez zápisu souborů")
    args = ap.parse_args()

    def log(msg):
        print(msg, file=sys.stderr)

    pages = fetch_pages(args.worker, args.days, log)
    pairs, hours = build_pairs(pages)
    if not pairs:
        log("Žádné páry — grafy se nepřepisují, job končí úspěchem.")
        return 0
    m = metrics(pairs)
    t = m["total"]
    gen = dt.datetime.now(dt.timezone.utc)
    log("Párů: %d · mokrých: %.1f %% · úspěšnost@50: %.1f %% · Brier: %.4f"
        % (t["n"], 100 * m["wet_share"], t["acc"], t["brier"]))

    if args.dry_run:
        print(json.dumps({k: (str(v) if isinstance(v, dt.date) else v)
                         for k, v in m["total"].items()}, ensure_ascii=False))
        return 0

    os.makedirs(args.out, exist_ok=True)
    gen_s = gen.strftime("%d. %m. %Y %H:%M")
    chart_horizon(m, gen_s, os.path.join(args.out, "presnost_horizont.svg"))
    chart_reliability(m, gen_s, os.path.join(args.out, "spolehlivost.svg"))
    chart_daily(m, gen_s, os.path.join(args.out, "denni_trend.svg"))

    badge = {
        "schemaVersion": 1,
        "label": "přesnost",
        "message": "%s %% · %s párů" % (fcs(t["acc"], 1), "{:,}".format(t["n"]).replace(",", " ")),
        "color": "#A8E4FF",
        # — rozšiřující klíče (shields.io je ignoruje, čtou je skripty/lidé) —
        "generated": gen.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "acc50": round(t["acc"], 2),
        "brier": round(t["brier"], 4),
        "pairs": t["n"],
        "wetShare": round(m["wet_share"], 4),
        "windowDays": args.days,
        "groundTruth": "METAR (bez trendových skupin), jinak radar > 0.05 mm/h",
    }
    with open(os.path.join(args.out, "stats.json"), "w", encoding="utf-8") as f:
        json.dump(badge, f, ensure_ascii=False, indent=2)
        f.write("\n")
    log("Zapsáno do %s" % args.out)
    return 0


if __name__ == "__main__":
    sys.exit(main())
