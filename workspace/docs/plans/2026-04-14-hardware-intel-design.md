# Hardware Market Intelligence — Skill Design

**Date:** 2026-04-14
**Status:** Approved
**Schedule:** Weekly, Monday 08:00 (`0 8 * * 1`)

## Purpose

Weekly market intelligence skill that analyses hardware pricing trends and industry signals to advise on optimal purchase timing for PC components. Produces a dual-horizon buy/hold/wait recommendation backed by a layered signal model.

Covers both directions: "wait for a dip" AND "buy before the surge."

## Tracked Components

| Component | Purpose |
|-----------|---------|
| DDR5 RAM | Direct purchase target |
| RTX 5090 | Direct purchase target |
| NVMe SSD | Direct purchase target (shares NAND supply chain) |
| AI accelerator landscape | Demand signal — tracks ASICs/TPUs that could ease GPU/memory pressure |

## Signal Model

### 4 Categories with Weighted Scoring

Each indicator scored **-5 to +5** (negative = downward price pressure / good for buyer, positive = upward pressure / buy soon).

**1. Supply Side (weight: 30%)**
- DRAM/NAND spot prices (ChinaFlashMarket index)
- Foundry utilization rates (TSMC/Samsung via Silicon Analysts API + earnings)
- Supply disruptions (fab incidents, geopolitical risk)

**2. Demand Side (weight: 30%)**
- AI training demand (hyperscaler capex guidance)
- Crypto mining profitability (GPU demand proxy via Minerstat API)
- Consumer PC market trends (seasonal, platform launches)
- AI accelerator competition (TPU, Trainium, Groq, Cerebras → eases GPU pressure)

**3. Macro & Trade (weight: 20%)**
- Tariff changes and trade policy (US-China, EU regulation)
- EUR/USD fluctuations (Frankfurter API)
- OEM earnings guidance (Micron, SK Hynix, Samsung, Nvidia)

**4. Retail & Pricing (weight: 20%)**
- Current retail prices vs historical trend (Proshop, Komplett, Geizhals)
- Stock availability signals
- Promotional cycles (Black Friday, Prime Day, seasonal)

### Composite Pressure Index

Per component: `(Supply × 0.3) + (Demand × 0.3) + (Macro × 0.2) + (Retail × 0.2)`

Range: -5.0 to +5.0

### Traffic Light Mapping

| Signal | Range | Meaning |
|--------|-------|---------|
| 🟢 BUY | ≤ -1.5 | Prices dropping or expected to drop |
| 🟡 HOLD | -1.5 to +1.5 | No strong signal |
| 🔴 BUY SOON | ≥ +1.5 | Upward pressure — buy before spike or wait for correction |

### Dual Horizon

- **Short-term (1-4 weeks):** weighted toward Retail & Pricing category
- **Medium-term (1-3 months):** weighted toward Supply and Demand categories

## Data Sources

### Tier 1 — APIs (hard data, called directly)

| Source | Data | Access |
|--------|------|--------|
| Silicon Analysts `/api/v1/market-pulse` | Fab utilization, wafer prices, HBM costs, CoWoS capacity | Free JSON, no key |
| Frankfurter API (`frankfurter.dev`) | EUR/USD rate + trend | Free, no key, ECB data |
| Minerstat API (`api.minerstat.com`) | Top GPU mining profitability | Free |

### Tier 2 — Curated Web Search (8-10 targeted queries)

**Supply signals:**
- ChinaFlashMarket (en.chinaflashmarket.com) — DRAM & NAND spot indices
- TrendForce press center — contract price direction
- SemiAnalysis — semiconductor deep dives
- Reuters/EE Times — fab incidents, disruptions

**Demand signals:**
- Epoch AI — hyperscaler capex tracking (Creative Commons)
- WhatToMine — GPU mining profitability rankings
- The Register, SemiAnalysis, CNBC — AI accelerator landscape
- Steam Hardware Survey — consumer GPU adoption

**Macro & Trade:**
- Tax Foundation tariff tracker
- Sourceability — geopolitics + semiconductor supply chain
- CNBC, Yahoo Finance, Benzinga — OEM earnings summaries

**Retail & Pricing:**
- Proshop.dk, Komplett.dk, Amazon.de — primary retailers (DK/EU)
- Geizhals.de — price aggregation
- GPU Sniper (gpusniper.com) — GPU-specific pricing + stock

## Execution Flow

1. **Recall** — cortex recall for previous week's scores and mid-week observations
2. **API fetch** — Silicon Analysts, Frankfurter, Minerstat (~5 seconds)
3. **Web search sweep** — 8-10 targeted searches (~60-90 seconds)
4. **Score** — assess each indicator -5 to +5, compute category & composite scores
5. **Compare** — load previous week's vault note, diff scores, note trends
6. **Accuracy check** — review last week's predictions against this week's retail data
7. **Write vault note** — full analysis to `research/hardware-market/YYYY-Www.md`
8. **Send Telegram** — compact traffic light summary
9. **Remember** — store key signals in cortex

## Output Formats

### Telegram (compact, actionable)

```
📊 Hardware Market Intel — Week 16, 2026

DDR5 RAM
  Short:  🟡 HOLD (0.3)
  Medium: 🔴 BUY SOON (+2.1)
  → DRAM spot up 8% this month, contract prices rising next quarter

RTX 5090
  Short:  🔴 BUY SOON (+1.8)
  Medium: 🟡 HOLD (+0.9)
  → Proshop stock sporadic at 25,990 DKK, tariff risk may push higher

NVMe SSD
  Short:  🟢 BUY (-2.4)
  Medium: 🟢 BUY (-1.9)
  → NAND oversupply, prices at 12-month low

Notable this week:
• [key signal 1]
• [key signal 2]
• [key signal 3]

Full analysis: vault link
```

### Vault Note (`research/hardware-market/YYYY-Www.md`)

Frontmatter:
```yaml
title: "Hardware Market Intel — YYYY-Www"
date: YYYY-MM-DD
tags: [hardware-market, weekly-intel]
up: "[[research/hardware-market/MOC|Hardware Market Intel]]"
```

Sections:
- **Summary** — traffic light table
- **Supply Side** — per-indicator scores with data points and reasoning
- **Demand Side** — same format
- **Macro & Trade** — same format
- **Retail & Pricing** — same format
- **AI Accelerator Landscape** — competitive landscape assessment
- **Model Accuracy Tracker** — retrospective on previous week's predictions

## Vault Structure

- Folder: `~/dev/notes/remotevault/research/hardware-market/`
- MOC: `research/hardware-market/MOC.md`
- Weekly notes: `research/hardware-market/YYYY-Www.md`
