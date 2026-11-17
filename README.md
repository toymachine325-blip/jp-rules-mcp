# Japan Inbound & Cross-Border Rules MCP

[![Glama Status](https://img.shields.io/badge/Glama-Listed-blue.svg)](https://glama.ai/mcp)
[![Smithery](https://img.shields.io/badge/Smithery-Compatible-orange.svg)](https://smithery.ai)
[![Node.js 20+](https://img.shields.io/badge/node-20+-green.svg)](https://nodejs.org)
[![Zero Dependencies](https://img.shields.io/badge/dependencies-0-brightgreen.svg)](package.json)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A high-performance, **zero-npm-dependency** Model Context Protocol (MCP) server delivering verified, real-time official regulations for international travelers entering and shopping in Japan.

- **Repository**: [https://github.com/toymachine325-blip/jp-rules-mcp](https://github.com/toymachine325-blip/jp-rules-mcp)
- **Live Production Endpoint**: `https://jp-rules-mcp.onrender.com/mcp`
- **Interactive Web Landing Page**: [https://jp-rules-mcp.onrender.com/](https://jp-rules-mcp.onrender.com/)
- **Protocol Support**: MCP JSON-RPC 2.0 over HTTP (`POST /mcp`), Streamable HTTP, Direct JSON metadata (`/.well-known/mcp.json`)

---

## 🌟 Regulatory Coverage & Features

1. **November 2026 Tax-Free Shopping Reform**:
   - Airport departure gate tax-refund transition.
   - Elimination of in-store upfront tax exemptions for consumables.
   - Mandatory digital customs export declaration with domestic consumption block detection.
2. **JR Shinkansen Oversized Baggage Rules**:
   - Tokaido, Sanyo, and Kyushu Shinkansen baggage dimensions (>160 cm up to 250 cm total dimensions).
   - Mandatory advance reserved seat requirement with 1,000 JPY penalty if unreserved.
3. **Peak Holiday Congestion Risk & Peak Travel Rules**:
   - Golden Week (early May), Obon (mid-August), and Year-End/New Year peak crowding calendars.
   - All-reserved Nozomi train operations and accommodation surcharge alerts.
4. **Customs & Quarantine Restrictions**:
   - Strict prohibited animal product ban (meat, bacon, jerky, vacuum-sealed items).
   - Plant quarantine inspection rules and 200,000 JPY overseas duty-free shopping threshold.

---

## 🎁 Whole-store free beta

When `JP_RULES_ONLY=false` and `JP_RULES_FREE_BETA=true`, the whole store is free: no API key, no charge.

| Tool | What it does |
| :--- | :--- |
| `generate_beautiful_pdf` | Markdown → clean PDF (Japanese & English) |
| `generate_ogp_image` | Title → OGP / thumbnail PNG |
| `purchase_product` | Drum MIDI, motion JSON, prompt pack |
| `list_products` | List the above |

The disposable-mail tools are held back until a real receiving domain is configured (`TEMP_MAIL_DOMAIN`).
Run the whole store with `docker build -f Dockerfile.store .` (see the file for details).

Free requests are limited to 30 requests/min per IP.

### Usage counter

The server counts calls per day and per tool. No IP, user agent or request content is stored; "unique users" is an approximate daily count.
Set `STATS_TOKEN`, then read `GET /api/stats?days=30` with the header `x-stats-token`. Without the variable the endpoint returns 404.
Add the header `x-usage-ignore: 1` to your own test calls to keep them out of the counts.

---

## 🛠 Available MCP Tools & Pricing

| Tool Name | Price | Auth | Description |
| :--- | :---: | :---: | :--- |
| `list_jp_rule_categories` | **Free (0 JPY)** | None | Lists verified regulatory categories, rule counts, and latest verification timestamps. Zero cost, no API key needed. |
| `query_jp_inbound_rules` | **Free (0 JPY)** | None | Queries official Japan inbound travel and cross-border regulatory rules by category or keyword in English JSON format. Zero cost, no API key needed. |
| `check_jp_travel_compliance` | **30 JPY / call** | `sk_souon_...` | Instantly validates travel details (tax-free eligibility under 2026 reform, Shinkansen baggage dimensions, holiday rush dates). |

*Paid tools feature strict **hard-limit locks** (HTTP 402 Payment Required). AI agents can never exceed their prepaid allowance.*

---

## 🔌 MCP Client Configuration

### 1. Claude Desktop (`claude_desktop_config.json`)

#### Remote HTTP Server (Recommended)
```json
{
  "mcpServers": {
    "jp-rules": {
      "url": "https://jp-rules-mcp.onrender.com/mcp",
      "headers": {
        "x-api-key": "sk_souon_your_api_key_here"
      }
    }
  }
}
```

#### Local Node.js Process
```json
{
  "mcpServers": {
    "jp-rules-local": {
      "command": "node",
      "args": ["path/to/ai_micro_store/server.js"],
      "env": {
        "JP_RULES_ONLY": "true",
        "PORT": "3456"
      }
    }
  }
}
```

### 2. Cursor / Direct HTTP Client
Configure your remote MCP server:
- **Server URL**: `https://jp-rules-mcp.onrender.com/mcp`
- **Headers**:
  - `x-api-key: sk_souon_...` (or `Authorization: Bearer sk_souon_...`)
  - `Content-Type: application/json`

---

## 💳 AI Allowance Top-Up (Stripe Instant Checkout)

Get an API key in seconds with built-in Stripe Checkout:

1. **Visit the Landing Page**: Navigate to [https://jp-rules-mcp.onrender.com/](https://jp-rules-mcp.onrender.com/).
2. **Select an Allowance Plan**:
   - **Mini**: 100 JPY (~3 compliance checks, free rule queries)
   - **Starter**: 500 JPY (~16 compliance checks, free rule queries)
   - **Standard**: 1,500 JPY (50 compliance checks, free rule queries) — *Most Popular*
   - **Pro**: 5,000 JPY (~166 compliance checks, free rule queries)
3. **Instant Key Delivery**: Complete payment with credit/debit card. You will be redirected back to the landing page with your `sk_souon_...` key instantly displayed on screen and stored in secure idempotency mapping.

---

## 🚀 Running Locally

### With Docker
```bash
docker build -t jp-rules-mcp .
docker run -p 3456:3456 -e JP_RULES_ONLY=true jp-rules-mcp
```

### With Node.js
```bash
# Clone repository and enter directory
git clone https://github.com/toymachine325-blip/jp-rules-mcp.git
cd jp-rules-mcp

# Start in standalone Japan Rules mode (zero external npm install needed)
JP_RULES_ONLY=true node server.js
```

Verify health status:
```bash
curl http://localhost:3456/health
# Response: {"status":"ok","service":"souon-ai-micro-store","version":"1.0.0","mode":"jp_rules_only","toolsCount":3,...}
```

---

## 🧪 Comprehensive Automated Test Suites

Run strict technical QA tests without mock falsification:

```bash
# 1. Billing, deployment, and security regression QA (19 tests)
node test_billing_deploy.js

# 2. Japan Inbound Rules MCP core & fact-check pipeline QA (11 tests)
node test_jp_rules_mcp.js

# 3. Micro Store core & SMF Type 0 binary QA (20 tests)
node test_store.js
```

---

## 📄 License
MIT License - Created by 創音知能 (Souon Chino) & Ravy.
Zero-npm-dependency pure Node.js architecture.
