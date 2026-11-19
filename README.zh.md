# DeepSeek Harness

[English](README.md) | 中文

DeepSeek Harness（`dsh`）是由 [DeepSeek AI](https://deepseek.com) 开发的开源 agent harness（智能体框架）。

它构建于**一切皆插件**的架构之上，由 [Cordis](https://github.com/cordiverse/cordis) 驱动，其设计参见论文 [_A Programming Paradigm for Spatiotemporal Composability_](https://arxiv.org/abs/2608.25512)。

文档：[https://deepseek-harness.github.io/deepseek-harness/](https://deepseek-harness.github.io/deepseek-harness/)

## 开发者预览

DeepSeek Harness 处于 _开发者预览_ 阶段，正在快速迭代。**未来将出现破坏兼容性的变更。**

运行本项目前，请阅读[安全说明](SAFETY.zh.md)。

## 与上游 `deepseek-ai/deepseek-harness` 的差异

本仓库（`dsh-mistral-compat`）在上游基础上增加：

- **全面使用 Bun。** 运行时、脚本与 CI 均改用 [Bun](https://bun.sh)；profile 模块解析物化为 `node_modules` 符号链接。主入口为 `bunx @deepseek-ai/dsh …`。Bun 宿主会把入口脚本之后的第一个 `--` 当作自己的选项终止符并吞掉，托管子进程运行器因此丢失了必需的私有分隔符——所有 `bash`、`glob`、`grep` 调用都报 `subprocess runner requires target argv after a private -- delimiter`。运行器入口现在会在 Bun 宿主上补回该分隔符。
- **默认 Mistral 模型。** web、headless 与 ACP profile 默认使用原生 Mistral provider（`mistral-large-latest`，目录中还有 medium/flash）。首次运行会提示输入 `MISTRAL_API_KEY`（https://console.mistral.ai）并保存到 `~/.dsh/.env`（0600）；直接设置环境变量可跳过提示。同一个 key 也可用于任何指向 `https://api.mistral.ai/v1` 的 OpenAI 兼容客户端。
- **默认支持 ACP，并聚合各客户端的 agent 会话历史。** `acp` profile 通过 JSON-RPC stdio 提供 Agent Client Protocol。`session/list` 会标记活动会话（`_meta.active`），并按项目（`_meta.category`）和 SSH 主机（`_meta.host`）自动归类。`scripts/import-acp.mjs` 可导入任意 ACP 客户端的对话（`--cwd`、`--host`），`scripts/import-vibe.mjs` 可导入 Mistral Vibe CLI 历史；导入的会话会归入对应项目分组，标题即时显示。
- **按 SSH 主机分隔会话。** 采用 Zed 式但与具体工具无关的设计：SSH 下创建的会话存放在 `--<host>@<project>--` 目录，并在 Web UI 中按主机分组；可用 `DSH_SESSION_REMOTE_HOST` 显式标记。v4 会话格式新增可选的 `remoteHost` 头字段。
- **每次启动都会对齐工作区分组。** 之后才出现在历史中的项目路径也能获得独立分组（此前仅首次启动会引导）；删除的工作区留下墓碑不会被恢复，手动排序在重启后保持。
- **Helium PWA 启动器。** `scripts/helium-pwa.sh` 与 `assets/linux/deepseek-harness.desktop` 可把 Web UI 作为独立 Helium 应用窗口打开（`dsh-helium-pwa install` 注册桌面入口和图标）。Web manifest 同时提供栅格 `favicon.ico`。
- **`rust-migration` 分支。** 原生 Rust 应用迁移位于 `rust-migration` 分支。

<a id="run"></a>

## 运行

### 通过 `npm` 运行

安装 `Bun`，然后运行：

```sh
bunx @deepseek-ai/dsh web
```

该命令默认会在 `http://127.0.0.1:3080` 启动 Web UI，本机启动时还会用默认浏览器打开页面。通过 SSH 启动时只打印宿主机 URL，因为本地转发地址由 SSH 客户端或编辑器持有。传入 `--no-open` 可仅运行服务器而不打开浏览器。详见 [Web UI 指南](docs/user/guide/index.zh.md)。

<a id="run-from-source"></a>

### 从源码运行

如需从仓库源码运行：

```sh
git clone https://github.com/richard523/dsh-mistral-compat.git
cd dsh-mistral-compat
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` 会准备仓库产物。`pnpm dsh web` 会直接使用这些已构建产物，不会重新构建。

## 社区与支持

- 通过 [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions) 提交反馈或 bug 报告。
- 为你的插件仓库添加 [`dsh-plugin`](https://github.com/topics/dsh-plugin) 话题，便于被发现。
- 欢迎加入 DeepSeek Harness 企微群！扫描下方二维码填写入群问卷，小助手会定期发送入群邀请。

<table>
  <thead>
    <tr>
      <th align="center">入群问卷</th>
      <th align="center">微信公众号</th>
    </tr>
  </thead>
  <tbody>
    <tr>
      <td align="center"><a href="https://trtgsjkv6r.feishu.cn/share/base/form/shrcnIt5twSVdLGD52KJBckGCgg"><img src="https://cdn.deepseek.com/harness/readme/community-wecom-survey.png" alt="DeepSeek Harness 入群问卷二维码" width="180" height="180"></a></td>
      <td align="center"><img src="https://cdn.deepseek.com/harness/readme/community-wechat-official-account.png" alt="DeepSeek Harness 团队微信公众号二维码" width="180" height="180"></td>
    </tr>
  </tbody>
</table>

## 参与贡献

参见 [CONTRIBUTING.md](CONTRIBUTING.zh.md)。

## 开发

请先阅读[开发指南](docs/development.zh.md)与[架构文档](docs/architecture.zh.md)。

`pnpm run dev:web` 会在一个终端里完成构建、启动，并在源码修改时重建 client bundle；`make help` 列出 Web 与 Desktop 对应的 Make target。完整表格见开发指南的「应用命令」一节。

面向 agent：请遵循 [AGENTS.md](AGENTS.md)。

## 引用

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## 许可证

[MIT](LICENSE)

第三方依赖及其许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
