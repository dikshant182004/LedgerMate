# LedgerMate

> **Free, ad-free, real-time bill splitting web app and suite of 55+ statutory financial, housing, payroll, and everyday mathematical calculators — featuring an AI Calculation Agent and a 16-jurisdiction regional hub.**

- **Live Production URL:** [https://tryledgermate.in](https://tryledgermate.in)
- **App URL:** [https://tryledgermate.in/app/](https://tryledgermate.in/app/)
- **Calculators Directory:** [https://tryledgermate.in/tools/](https://tryledgermate.in/tools/)
- **Regional Hub:** [https://tryledgermate.in/regional/](https://tryledgermate.in/regional/)
- **AI CalcAgent:** [https://tryledgermate.in/tools/calc-agent/](https://tryledgermate.in/tools/calc-agent/)
- **License:** [MIT](./LICENSE)

---

## Architecture & Product Overview

### 1. Realtime Group Expense Splitter (`/app/`)
* **Zero-friction onboarding**: No sign-up required. Anyone can create a group, pick a base currency (`$`, `₹`, `€`, `£`, `¥`), set a retention policy, and share the link.
* **Instant synchronization**: Powered by Cloudflare **Durable Objects** (`GroupRoom`) with the **Hibernatable WebSockets API**. Open tabs receive instant pushes when bills are added, edited, or settled.
* **Simplified Debt Resolution**: In-memory debt graph minimization reduces redundant circular repayments to the minimum number of transactions.
* **Intelligent Auto-Expiry**: Custom retention per group (1 day, 1 week, 2 weeks, 1 month, permanent). Durable Object alarms wake up on schedule to clean expired groups without requiring global database cron sweeps.
* **Optional Google OAuth & Notifications**: Sign in with Google to access cross-device group lists and receive automated 48-hour reminder emails before groups auto-delete via Resend.
* **Realtime Visual Charts**: Interactive Chart.js doughnut charts ("Who Paid What") and net balance breakdown.

### 2. 55+ Free Financial & Mathematical Calculators (`/tools/`)
Comprehensive, mobile-responsive calculators with zero advertisements, zero tracking, and deterministic mathematical accuracy:
* **Rent, Housing & Real Estate**: Rent Split (by Sq Ft), Couple & Roommate Rent Split, Prorated Rent Calculator, Rent Affordability (30% / 40x rule), Rent vs Buy (10-year net wealth model), Mortgage Calculator (PITI + PMI amortization), Electricity Running Cost.
* **Travel, Dining & Dining Checks**: Tip Calculator & Gratuity Splitter, Restaurant Bill Splitter, Trip Budget Calculator, Vacation Expense Splitter, Airbnb Room Split, Gas & Fuel Split, Wedding Budget Planner, Bachelorette Party Splitter, Multi-Currency Splitter.
* **Loans, Taxes & Personal Finance**: Loan EMI Calculator, Auto Loan Calculator, Student Loan Payoff, Compound Interest, Retirement & 401(k), Freelance Hourly Rate, Income-Weighted Proportional Split, Discount & Sale Price, VAT & Sales Tax, Lifetime Pet Cost, Cloud Hosting Cost Estimator.
* **Everyday Math, Dates & Health**: Date Difference Calculator (calendar days, weeks, elapsed months, and Monday–Friday business days), Chronological Age Calculator, Percentage Calculator, Online Scientific Calculator, High School & College GPA / India CGPA Converter, Universal Metric/Imperial Unit Converter, Aspect Ratio Calculator, PX to REM/EM Converter, Download Bandwidth Duration, Global Time Zone Meeting Planner, TDEE, BMR, Body Fat %, Macro Nutrients, Pregnancy Due Date, Ovulation Calendar.

### 3. Global & Regional Statutory Calculation Hub (`/regional/`)
Official statutory labor, estate, and progressive tax engines spanning 16 jurisdictions with native-language interfaces and dynamic regional theming:
* **Saudi Arabia & UAE (GCC)**: حاسبة الزكاة الشرعية (Zakat 2026 with gold/silver Nisab), مكافأة نهاية الخدمة (End of Service under Saudi Article 84/85 & UAE Labor Law), حاسبة المواريث الشرعية (Quranic Fara'id inheritance).
* **Mexico (Spanish)**: Calculadora de Finiquito y Liquidación (LFT, prima de antigüedad, SDI), Calculadora de Aguinaldo (15-day baseline, ISR withholding, 30-UMA exemption).
* **France (French)**: Indemnité de Licenciement (Article R.1234-1 Code du travail), Barème Kilométrique URSSAF.
* **Germany**: Gehaltsrechner (Brutto-Netto 2026, Steuerklassen I–VI, Krankenversicherung, Rentenversicherung, Solidaritätszuschlag).
* **Japan**: 手取り計算 (Te-dori Take-Home Pay with income tax, resident tax, and health/pension insurances).
* **South Korea**: 연봉 실수령액 (Take-Home Pay with 4 major social insurances & national pension ceiling).
* **India**: CTC to In-Hand Monthly Salary, Income Tax Calculator (FY 2025–26 New vs Old Regime comparison).
* **Russia**: Зарплата на руки (13%/15% progressive Personal Income Tax НДФЛ).
* **United States**: 50-State Paycheck Tax Calculator, 2026 Federal Income Tax Estimator.
* **International**: IBAN Validator & BIC Search (MOD-97 checksum algorithm across 80+ countries).

### 4. AI Fast-Inference Calculation Agent (`/tools/calc-agent/`)
* **Natural language math inference**: Ask multi-layered financial questions (rent apportionments, cross-border tax brackets, mortgage amortizations) in plain words.
* **Sub-2s SLA inference**: Powered by the modern `@google/genai` TypeScript SDK with deterministic verification.
* **Interactive UI**: Reactive sliders, step-by-step mathematical proofs, and auto-generated calculation tapes.
* **Guides & Documentation**: Dedicated user guide at [`/guides/calc-agent/`](https://tryledgermate.in/guides/calc-agent/) and security architecture at [`/security/calc-agent/`](https://tryledgermate.in/security/calc-agent/).

---

## Directory Structure

```
├── public/
│   ├── index.html                   # Main landing page with tools directory preview
│   ├── app/                         # Core LedgerMate realtime expense splitting app
│   ├── tools/                       # 55+ standalone calculators & tools directory hub
│   │   ├── index.html               # Searchable tools directory
│   │   ├── tip-calculator/          # Dedicated Tip & Gratuity Splitter
│   │   ├── date-difference-calculator/# Dedicated Date Difference & Work Days tool
│   │   ├── calc-agent/              # AI Calculation Agent Studio
│   │   └── ...                      # 50+ individual calculator tools
│   ├── regional/                    # Global & Regional Statutory Hub (16 jurisdictions)
│   ├── blog/                        # Financial & Roommate Guides Hub (6 articles)
│   ├── guides/calc-agent/           # CalcAgent User Guide & SLA
│   ├── security/calc-agent/         # CalcAgent Security Architecture
│   ├── compare/                     # Comparison hubs (e.g. Splitwise alternative)
│   ├── sitemap.xml                  # 100% complete sitemap (87 indexed URLs)
│   ├── robots.txt                   # Search crawler directives
│   └── icons/                       # PWA icons & manifest assets
├── src/
│   ├── index.js                     # Cloudflare Worker / Hono HTTP application routes
│   ├── durable-objects/
│   │   └── group-room.js            # Durable Object: WebSocket fan-out & alarm scheduler
│   ├── services/
│   │   ├── group-state.js           # Core ledger domain logic & balance graph simplification
│   │   └── realtime.js              # Worker-side DO routing helpers
│   └── lib/                         # Crypto, HTTP, cookies, and email utilities
├── wrangler.jsonc                   # Cloudflare Workers configuration (D1, DO, Vars)
├── .env.example                     # Environment variables template
├── metadata.json                    # Project capabilities & metadata
└── package.json                     # Scripts and dependencies
```

---

## Local Development Setup

### Prerequisites
* Node.js 18+
* Cloudflare Wrangler CLI (`npm i -g wrangler`)

### 1. Install Dependencies
```bash
npm install
```

### 2. Environment Variables
Copy `.env.example` to your local environment or configure via Wrangler secrets:
```bash
cp .env.example .env
```

| Variable | Description |
| :--- | :--- |
| `APP_URL` | Base application URL (e.g. `http://localhost:3000` or `https://tryledgermate.in`) |
| `GOOGLE_CLIENT_ID` | Google OAuth Client ID for sign-in |
| `GOOGLE_CLIENT_SECRET` | Google OAuth Client Secret (store via `wrangler secret put`) |
| `GOOGLE_REDIRECT_URI` | OAuth callback endpoint (e.g. `/auth/google/callback`) |
| `RESEND_API_KEY` | Resend API key for email notifications (store via `wrangler secret put`) |
| `RESEND_FROM` | Verified sender address (e.g. `LedgerMate <notifications@yourdomain.com>`) |
| `EXTEND_SECRET` | 32+ character random secret for cryptographic session tokens |
| `GEMINI_API_KEY` | Google Gemini API key for AI Calculation Agent |

### 3. Local Database & Migrations
```bash
# Apply local D1 SQLite migrations
npm run db:migrate:local
```

### 4. Start Development Server
```bash
npm run dev
```
The app and tools will be accessible locally at `http://localhost:3000`.

---

## Testing, Validation & Quality Assurance

* **Syntax & Route Check:**
  ```bash
  npm run lint
  ```
* **Build Compilation:**
  ```bash
  npm run build
  ```
* **Search Engine Optimization Audit:**
  - `sitemap.xml`: Complete with 87 validated URLs, zero broken links.
  - Image Accessibility: 100% `alt` tag compliance across all 88 HTML pages.
  - Heading Structure: Exactly one `<h1>` per page.
  - Crawl Boundaries: Clean `robots.txt` configuration with `/auth/` protected from bot crawl traps.

---

## Deployment

Deploy directly to Cloudflare's edge network:
```bash
npm run deploy
```

For D1 database production migrations:
```bash
npm run db:migrate:remote
```

---

## Contributing & Support

* **Issues & Feedback:** Submit suggestions via the in-app [Feedback Page](https://tryledgermate.in/feedback/).
* **Security Reporting:** Refer to [security.txt](https://tryledgermate.in/.well-known/security.txt) or view our [Security Architecture](https://tryledgermate.in/security/calc-agent/).
