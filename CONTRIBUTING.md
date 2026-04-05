# Contributing to brice-tao

Thanks for your interest in contributing! This project is a Bittensor portfolio rebalancer built with TypeScript and the Bun runtime. Below is everything you need to get started.

## Getting Started

1. **Clone the repo**

	```sh
	git clone https://github.com/<your-fork>/brice-tao.git
	cd brice-tao
	```

2. **Install dependencies**

	```sh
	bun install
	```

3. **Configure environment**

	```sh
	cp .env.example .env
	```

	Fill in the required values (RPC endpoint, coldkey address, etc.). See the README for details on each variable.

4. **Verify your setup**

	```sh
	bun rebalance -- --strategy root-emission --dry-run
	```

	A successful dry run confirms everything is wired up correctly.

## Code Style

This project uses **Bun** exclusively — **do not use npm, pnpm, or yarn**.

[Biome](https://biomejs.dev/) enforces the following conventions:

- **No semicolons**
- **Double quotes**
- **Tab indentation**

Additional rules:

- **Named exports only** — no default exports
- **Imports use `.ts` extensions**: `import { foo } from "./bar.ts"`
- **Type imports are separate**: `import type { Foo } from "./bar.ts"`
- **All amounts are in RAO** (`bigint`), never TAO — use the `TAO` constant from `src/rebalance/tao.ts` for conversions

Run `bun check --fix --unsafe` to auto-fix most style issues.

## Quality Gates

All of the following must pass before opening a PR:

```sh
bun check          # lint + format (Biome)
bun typecheck      # TypeScript type checking
bun knip           # dead code detection
bun test           # unit tests
```

CI runs these same checks on every push and PR to `main`.

## Project Structure

| Directory | Purpose |
|-----------|---------|
| `src/strategies/` | Strategy implementations — each strategy lives in its own self-contained subfolder |
| `src/rebalance/` | Shared rebalance pipeline (compute, execute, slippage, MEV shield) |
| `src/scheduling/` | Cron and one-shot runner utilities |
| `scripts/` | CLI tools (preview rebalance, show balances) |

Tests are **co-located** with source files (e.g., `getBalances.test.ts` next to `getBalances.ts`).

## Adding a Strategy

See [docs/custom-strategies.md](docs/custom-strategies.md) for the full guide on creating a new strategy, including the strategy contract, config format, and registration steps.

## Pull Request Process

1. **Fork the repo** and create a feature branch from `main`.
2. **Make your changes** and ensure all [quality gates](#quality-gates) pass locally.
3. **Write tests** for new logic where possible — co-locate them with the source files.
4. **Open a PR** with a clear description of what you changed and why.
5. CI will automatically run lint, typecheck, tests, and dead code detection.
6. A maintainer will review your PR and may request changes.

## Reporting Issues

Please use [GitHub Issues](../../issues) to report bugs or request features.

When filing a bug report, include:

- **Strategy name** (e.g., `root-emission`, `copy-trade`)
- **Error message** and relevant log output
- **Steps to reproduce** if possible

> ⚠️ **Never include secrets, mnemonics, or private keys in issue reports.**

## License

By contributing, you agree that your contributions will be licensed under the [MIT License](LICENSE).
