# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It is built on an **everything-is-a-plugin** architecture and powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512).

Documentation: [https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## Developer preview

DeepSeek Harness is in _developer preview_ and iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

Review the [safety notice](SAFETY.md) before running the project.

## Differences from upstream `deepseek-ai/deepseek-harness`

This fork (`dsh-mistral-compat`) layers the following on top of upstream:

- **Bun everywhere.** Runtime, scripts, and CI run on [Bun](https://bun.sh); profile module resolution is materialized as `node_modules` symlinks. `bunx @deepseek-ai/dsh …` is the primary entrypoint.
- **Mistral models by default.** Web, headless, and ACP profiles default to the native Mistral provider (`mistral-large-latest`, with medium/flash in the model catalog). On first run the CLI prompts for a `MISTRAL_API_KEY` (https://console.mistral.ai) and stores it in `~/.dsh/.env` (0600); set the env var to skip the prompt. The same key also works with any OpenAI-compatible client pointed at `https://api.mistral.ai/v1`.
- **ACP by default, with cross-client agent history.** The `acp` profile speaks the Agent Client Protocol over JSON-RPC stdio. `session/list` marks the active session (`_meta.active`) and autocategorizes every entry by project (`_meta.category`) and SSH host (`_meta.host`). `scripts/import-acp.mjs` imports any ACP client's transcript (`--cwd`, `--host`), and `scripts/import-vibe.mjs` pulls in Mistral Vibe CLI histories; imported chats land in their project group in the sidebar with titles shown immediately.
- **Sessions separated by SSH host.** Zed-style but producer-agnostic: sessions created over SSH are stored under `--<host>@<project>--` and grouped per host in the web UI; stamp explicitly with `DSH_SESSION_REMOTE_HOST`. The v4 session format carries an optional `remoteHost` header field.
- **Workspace groups reconcile on every boot.** A project path that first appears in history later still gets its own workspace group (previously only the first boot bootstrapped); deleted workspaces leave tombstones and are not resurrected, and manual group order survives restarts.
- **Helium PWA launcher.** `scripts/helium-pwa.sh` plus `assets/linux/deepseek-harness.desktop` open the web UI as a standalone Helium app window (`dsh-helium-pwa install` registers the desktop entry and icon). The web manifest also ships a raster `favicon.ico`.
- **`rust-migration` branch.** A native Rust app migration lives on the `rust-migration` branch.

## Run

### Run from `npm`

Install `Bun`, then run:

```sh
bunx @deepseek-ai/dsh web
```

The command starts the Web UI at `http://127.0.0.1:3080` by default and opens it in the default browser for a local launch. An SSH launch only prints the host URL because the SSH client or editor owns the local forwarded address. Pass `--no-open` to run the server without opening a browser. See [Web UI guide](docs/user/guide/index.md).

### ACP (agent chats from any client)

The `acp` profile speaks the Agent Client Protocol over JSON-RPC stdio, so any ACP-capable client or editor (Zed, other agents, scripts) can spawn it and create/list/resume/close agent sessions:

```sh
bunx @deepseek-ai/dsh acp
```

Both the web and ACP profiles default to Mistral models (`mistral-large-latest`); on first run the CLI prompts for a `MISTRAL_API_KEY` (from https://console.mistral.ai) and stores it in `~/.dsh/.env` (0600). Set the env var instead to skip the prompt.

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/richard523/dsh-mistral-compat.git
cd dsh-mistral-compat
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts. `pnpm dsh web` uses those built artifacts without rebuilding.

## Community and support

- Submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/4MrtZUhpxg">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

`pnpm run dev:web` builds, serves, and rebuilds client bundles on source edits in one terminal, and `make help` lists the matching Make targets for Web and Desktop; the guide's application commands section owns the full table.

For agents, follow [AGENTS.md](AGENTS.md).

## Citation

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
