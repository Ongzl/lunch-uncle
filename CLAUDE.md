Lunch Uncle is a Cloudflare Worker that recommends lunch spots near CT Hub 2, Lavender. It runs an agentic loop against an OpenAI-compatible LLM with three tools: Places search, rain forecast, and bus arrivals.

## Conventions

- Keep each tool split into a fetch function that does IO and a pure format function that shapes the response. Test only the pure part.
- Secrets come from `env` only, never in code, `wrangler.toml`, or committed files. Local secrets go in `.env` (copy `.env.example`), which is gitignored.
- Run `npm test` before opening a PR. Keep the project free of runtime npm dependencies and build steps.
