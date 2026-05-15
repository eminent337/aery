# Aery Gateway

Cloudflare Worker for Aery-owned model routing.

The gateway stores user provider credentials under one Aery key and exposes stable routes like:

```text
https://aery-gateway.eminent337.workers.dev/v1/openai
https://aery-gateway.eminent337.workers.dev/v1/anthropic
https://aery-gateway.eminent337.workers.dev/v1/openrouter
```

## Local Checks

```bash
npm install
npm run check
```

## Deploy

```bash
npm run kv:create
wrangler secret put FREE_TIER_OPENROUTER_KEY
npm run deploy
```

## API

| Method | Path | Description |
| --- | --- | --- |
| `GET` | `/health` | Liveness and version check |
| `GET` | `/providers` | Supported gateway providers |
| `POST` | `/register` | Create an Aery key and optionally store provider keys |
| `PUT` | `/keys` | Add or update provider keys |
| `GET` | `/keys` | List configured providers without returning secrets |
| `GET` | `/usage` | Return recent per-provider usage counts |
| `POST` | `/v1/<provider>/<path>` | Proxy to an upstream provider |

Cloudflare Workers AI credentials must be stored as:

```json
{
	"cloudflare-workers-ai": {
		"key": "CLOUDFLARE_API_TOKEN",
		"accountId": "CLOUDFLARE_ACCOUNT_ID"
	}
}
```
