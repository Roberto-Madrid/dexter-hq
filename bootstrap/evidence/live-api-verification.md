# Live Cursor API verification — read-only

Run date: 2026-09-19 (UTC)
Branch: `bootstrap/live-api`, taken from `origin/main` tip `53fac961c485b8ff6799b838a062f50905af0682` (HEAD confirmed equal to that SHA before editing).
Scope: read-only verification only. No agent was created, launched, resumed, or cancelled. No change to the barber application, its hosting, or its database.

Evidence labels used below:
- **supported** — observed first-hand in this run from a live API response.
- **reported** — read in Cursor documentation or help pages, not verified first-hand here.
- **unverified** — plausible but not established by evidence in this run.
- **unavailable** — the API does not expose it, or it could not be checked safely.

## Headline answers

1. **Does the key authenticate?** Yes. `GET https://api.cursor.com/v1/me` returned **HTTP 200**. **supported**
2. **Are both repositories reachable?** Yes. `GET /v1/repositories` returned **HTTP 200** with 9 repositories, including both `Roberto-Madrid/dexter-barber` and `Roberto-Madrid/dexter-hq`. Cross-repository dispatch is therefore not blocked by repository permissions. **supported**

## Secret handling

The key was never printed, echoed, logged, committed, hashed, or partially revealed. It was never passed as a command argument: each request used a mode-0600 temporary curl config file whose `Authorization` header line was written by shell expansion inside a here-document, deleted (`shred -u`) immediately after the requests. All response output was piped through a redactor. No `-v`/trace flag was used, so no request headers were emitted.

## 1. Secret presence

`DEXTER_CURSOR_API_KEY` is **PRESENT** in this run's environment. **supported**

This answers the open question from plan section 6B: environment secrets attached to cloud environment `16a2c703-b3e1-11f1-bb68-864e54d14197` **do** reach runs created this way. Earlier runs that lacked it predate the attachment.

## 2. Authentication and identity

Endpoint schema was confirmed against https://cursor.com/docs/cloud-agent/api/endpoints before calling; the current documented base path is `/v1` (the docs carry a "Migrating from v0?" notice). Requests used a bearer `Authorization` header.

| Check | Result |
| --- | --- |
| `GET /v1/me` | HTTP 200 |

Identity the key resolves to (**supported**):

- `apiKeyName`: `DEXTER_CURSOR_API_KEY`
- `userId`: `431080337`
- `userEmail`: `robbtm40@gmail.com`
- `userFirstName`: `4Poyo`
- `createdAt`: `2026-09-19T04:45:37.078Z`

Because `userId`/`userEmail` are populated, this is a **user-scoped key**, not a service-account or team key — the documented response for a service-account key omits those fields. **supported** for the observed fields; the user-vs-service-account distinction is **reported** from the documented field semantics.

Practical consequence: the key carries this individual's access and its usage bills to this individual's plan. It is not an independently scoped machine identity.

## 3. Discovery (read-only)

### Permitted repositories — `GET /v1/repositories`, HTTP 200

9 repositories returned (**supported**):

```
https://github.com/Roberto-Madrid/demo2
https://github.com/Roberto-Madrid/voyporti
https://github.com/Roberto-Madrid/dexter-barber      <-- required
https://github.com/Roberto-Madrid/dexter-hq          <-- required
https://github.com/elbmin79/BandiRutas
https://github.com/elbmin79/-BandeeRutas
https://github.com/elbmin79/MiaMotel
https://github.com/elbmin79/MiaMotelAssistant
https://github.com/elbmin79/Discovery-Sistema
```

**Both `dexter-barber` and `dexter-hq` are present.** Cross-repository dispatch is possible as far as repository permissions are concerned. **supported**

Two cautions:

- The API returns owner casing `Roberto-Madrid`, while the local git remotes use lowercase `roberto-madrid` and the `GET /v1/agents` listing also reports lowercase `roberto-madrid`. Whether the allowlist comparison in the dispatch client must be case-insensitive is **unverified**; treating repository URLs case-insensitively is the safe implementation choice.
- The docs state this endpoint has "very strict rate limits" — 1 request per user per minute and 30 per user per hour — and can take tens of seconds. **reported.** A dispatch client must cache this list rather than call it per dispatch. It was called exactly once in this run.

### Supported model IDs — `GET /v1/models`, HTTP 200

38 model IDs returned. These are the live values; none are recalled or invented. Per plan section 13, only IDs from this list should be used, and aliases from memory must not be hard-coded. **supported**

| `id` | displayName | parameters (`id`=permitted values) |
| --- | --- | --- |
| `default` | Auto | — |
| `grok-4.6` | Cursor Grok 4.6 | `effort`=low\|medium\|high\|xhigh; `fast`=false\|true |
| `composer-2.5` | Composer 2.5 | `fast`=false\|true |
| `claude-opus-5` | Claude Opus 5 | `thinking`=false\|true; `context`=300k\|1m; `effort`=low\|medium\|high\|xhigh\|max; `fast`=false\|true |
| `claude-opus-4-8` | Claude Opus 4.8 | `thinking`; `context`=300k\|1m; `effort`=low..max; `fast` |
| `gpt-5.6-sol` | GPT-5.6 Sol | `context`=272k\|1m; `reasoning`=none..max; `fast` |
| `gpt-5.5` | GPT-5.5 | `context`=272k\|1m; `reasoning`=none..extra-high; `fast` |
| `claude-fable-5-1` | Claude Fable 5.1 | `thinking`; `context`=300k\|1m; `effort`=low..max |
| `claude-fable-5` | Claude Fable 5 | `thinking`; `context`=300k\|1m; `effort`=low..max |
| `grok-4.5` | Cursor Grok 4.5 | `effort`=low\|medium\|high; `fast` |
| `gemini-3.8-flash` | Gemini 3.8 Flash | `reasoning_effort`=low\|medium\|high |
| `gemini-3.7-flash` | Gemini 3.7 Flash | `effort`=low\|medium\|high |
| `muse-spark-1.3` | Muse Spark 1.3 | `context`=300k\|1m; `effort`=minimal..max |
| `gpt-5.6-terra` | GPT-5.6 Terra | `context`=272k\|1m; `reasoning`=none..max; `fast` |
| `claude-sonnet-5` | Claude Sonnet 5 | `thinking`; `context`=300k\|1m; `effort`=low..max |
| `claude-sonnet-4-6` | Claude Sonnet 4.6 | `thinking`; `context`=200k\|1m; `effort`=low..max |
| `gpt-5.3-codex` | Codex 5.3 | `reasoning`=low..extra-high; `fast` |
| `claude-opus-4-7` | Claude Opus 4.7 | `thinking`; `context`=300k\|1m; `effort`=low..max; `fast` |
| `gpt-5.4` | GPT-5.4 | `context`=272k\|1m; `reasoning`=none..extra-high; `fast` |
| `claude-opus-4-6` | Claude Opus 4.6 | `thinking`; `context`=200k\|1m; `effort`=low..max |
| `claude-opus-4-5` | Claude Opus 4.5 | `thinking` |
| `gpt-5.2` | GPT-5.2 | `reasoning`=low..extra-high; `fast` |
| `gpt-5.6-luna` | GPT-5.6 Luna | `context`=272k\|1m; `reasoning`=none..max; `fast` |
| `gemini-3.6-flash` | Gemini 3.6 Flash | `effort`=minimal..high |
| `gemini-3.1-pro` | Gemini 3.1 Pro | — |
| `gpt-5.4-mini` | GPT-5.4 Mini | `reasoning`=none..xhigh |
| `gpt-5.4-nano` | GPT-5.4 Nano | `reasoning`=none..xhigh |
| `claude-haiku-4-5` | Claude Haiku 4.5 | `thinking` |
| `claude-sonnet-4-5` | Claude Sonnet 4.5 | `thinking`; `context`=200k |
| `gpt-5.1` | GPT-5.1 | `reasoning`=low\|medium\|high |
| `gemini-3-flash` | Gemini 3 Flash | — |
| `gemini-3.5-flash` | Gemini 3.5 Flash | — |
| `claude-sonnet-4` | Claude Sonnet 4 | `thinking`; `context`=200k |
| `gpt-5-mini` | GPT-5 Mini | — |
| `gemini-2.5-flash` | Gemini 2.5 Flash | — |
| `kimi-k3` | Kimi K3 | `reasoning`=low\|high\|max |
| `kimi-k2.7-code` | Kimi K2.7 Code | — |
| `glm-5.2` | GLM 5.2 | `reasoning`=high\|max |

Notes:

- `model.id` on Create An Agent takes the bare `id`; reasoning effort and similar settings go in `model.params` as `{id, value}` pairs. The kebab-case composite slugs used for in-session subagents (for example `claude-opus-5-thinking-high`) are **not** valid API model IDs. **reported** from the endpoint documentation, consistent with the observed `parameters`/`variants` shape.
- Aliases are returned by the API and several are ambiguous across versions (`opus`, `gpt`, `sonnet`, `gemini-flash` each appear on more than one model). Per plan section 13, the dispatch client should send explicit `id` values, never aliases.
- Omitting `model` entirely makes Cursor resolve the account default. **reported**

## 4. Usage and billing (read-only)

### What the API genuinely exposes — **supported**

`GET /v1/agents/{id}/usage` returned HTTP 200 for this very run's agent and includes a **cost** object that the endpoint documentation does not describe:

```json
{"totalUsage":{"inputTokens":16,"outputTokens":4299,"cacheWriteTokens":66875,
 "cacheReadTokens":406992,"totalTokens":478182},
 "cost":{"rawCostCents":72.901975,"chargedCents":72.901975},
 "runs":[{"id":"run-...","usage":{...},"cost":{"rawCostCents":72.901975,"chargedCents":72.901975}}]}
```

So per-agent and per-run token counts **and** a cent-denominated cost are retrievable after the fact. This satisfies plan section 5's "report usage when genuinely exposed" requirement at agent granularity, and section 13's "track usage per accepted task where available".

Interpretation limits:
- Whether `chargedCents` means "billed on-demand dollars" or "value of usage drawn from the included pool" is **unverified**. The field is undocumented, and on individual plans Cursor's dashboard deliberately shows included usage as "Included" rather than a dollar amount (**reported**), so a non-zero `chargedCents` here is not by itself proof of overage spend.
- This is **retrospective**. There is no pre-flight cost estimate and no API-side cap, so it cannot prevent spend — only measure it.

`GET /v1/agents` (HTTP 200) also lists existing agents with their `repos`, `status`, `url`, and `latestRunId`, which is what a dispatch client needs to recover known IDs in a fresh session (plan section 5).

### What the API does not expose — **unavailable**

Account-level included allowance, remaining allowance, billing-cycle reset date, on-demand enablement state, and spend limits are **unknown — not exposed by the API**. Probed read-only, all HTTP 404 `Route ... not found`:

```
GET /v1/usage              -> 404 {"message":"Route GET:/v1/usage not found","error":"Not Found","statusCode":404}
GET /v1/me/usage           -> 404 {"message":"Route GET:/v1/me/usage not found","error":"Not Found","statusCode":404}
GET /v1/billing            -> 404 {"message":"Route GET:/v1/billing not found","error":"Not Found","statusCode":404}
GET /teams/daily-usage-data-> 404 {"message":"Route GET:/teams/daily-usage-data not found","error":"Not Found","statusCode":404}
```

The documented Metadata endpoints are only `/v1/me`, `/v1/models`, and `/v1/repositories`; none of them returns plan, allowance, or spend information. **supported** (observed) and **reported** (docs inventory).

### Dashboard pages the owner must check manually — **reported**

- https://cursor.com/dashboard/spending — the Spending tab is the authoritative view of included-usage pools, remaining allowance, the billing-cycle reset date, whether on-demand usage is enabled, and the monthly spend limit. Setting a spend limit requires on-demand usage to be enabled; with on-demand disabled there is nothing to cap and the bill stays at the fixed plan price.
- https://cursor.com/dashboard/usage — per-request token usage with a Cost column and CSV export for a date range. On individual plans, included usage shows as "Included" rather than a dollar figure; dollar figures appear only for on-demand usage.
- Cursor's help pages describe two monthly pools: a Cursor Models pool (Cursor Grok 4.6, Cursor Grok 4.5, Composer 2.5) and an Other Models pool for third-party models charged at provider prices. Model choice therefore changes how fast included usage is consumed.

### Bearing on plan section 6C (spending boundaries)

The owner's "included usage only, no paid overage" boundary **cannot be enforced through this API**. There is no API-side budget, cap, or allowance read. The only hard enforcement is the account setting: with on-demand usage **disabled** on the Spending tab, usage stops at the included allowance instead of becoming billable. Per plan section 6C, this is the one specific dashboard setting the owner should confirm before any API worker is launched. Prompts, concurrency caps, and worker counts are not dollar caps. **reported** as to the mechanism; **unverified** as to the account's current on-demand setting, which this run cannot read.

## 5. No agents created

No `POST` request of any kind was issued. Only `GET` requests were made: `/v1/me`, `/v1/models`, `/v1/repositories`, `/v1/agents?limit=5`, `/v1/agents/{id}/usage`, and four 404 probes. Nothing was created, launched, resumed, or cancelled.

## Summary table

| # | Finding | Label |
| --- | --- | --- |
| 1 | `DEXTER_CURSOR_API_KEY` present in this run's environment | supported |
| 2 | Key authenticates — `GET /v1/me` HTTP 200 | supported |
| 3 | Key is user-scoped (`robbtm40@gmail.com`, userId 431080337), not a service account | supported |
| 4 | `dexter-barber` and `dexter-hq` both in the permitted repository list (9 total) | supported |
| 5 | 38 live model IDs recorded from `GET /v1/models` | supported |
| 6 | Repository owner casing differs between API (`Roberto-Madrid`) and agent records (`roberto-madrid`) | supported |
| 7 | `/v1/repositories` rate limit 1/min, 30/hour — must be cached | reported |
| 8 | Per-agent/per-run tokens **and** `cost.rawCostCents`/`chargedCents` retrievable | supported |
| 9 | Meaning of `chargedCents` for included vs on-demand usage | unverified |
| 10 | Account allowance, remaining balance, spend limit via API | unavailable — check `cursor.com/dashboard/spending` |
| 11 | On-demand usage disabled on the account is the only hard overage cap | reported |
| 12 | Current on-demand setting on this account | unverified — dashboard-only |
