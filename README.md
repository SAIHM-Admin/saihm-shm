# SHM — Super-Human Memory

**Ranked recall of the memories that live outside an AI agent's context window — a local-first add-on to [SAIHM](https://github.com/SAIHM-Admin).**

SHM brings an agent the handful of its stored memories that matter for the task at hand. It ranks them with hybrid retrieval and an optional local reranker, keeps what it stores encrypted on your machine, and makes sure that a memory erased in SAIHM is erased from everything SHM derived from it.

## Who can use SHM

SHM is for paid SAIHM subscribers. Before a session opens, SHM confirms with SAIHM that your account holds a paid tier: `PRO`, `PRO_FAST`, `ENTERPRISE` or `ENTERPRISE_FAST`. The session opens as soon as the check passes; any other answer, an error or a timeout keeps it closed, and nothing is locked, written or read until then. The check waits up to 15 seconds by default (`entitlementTimeoutMs`). The first start of the SAIHM MCP server after an install or upgrade can take longer while it downloads, so start it once beforehand or raise the timeout.

SHM takes the tier straight from your account status as SAIHM reports it, never from an environment variable or configuration file. The check keeps default use to accounts with a paid tier; the [licence](#licence) sets the terms of use.

## Requirements

- Node.js 20.20 or later
- A paid SAIHM subscription, and a way for SHM to ask SAIHM for your account status: your SAIHM client ([saihm-client-pro](https://github.com/SAIHM-Admin/saihm-client-pro)), or an MCP client connected to the SAIHM MCP server ([saihm-mcp-server-pro](https://github.com/SAIHM-Admin/saihm-mcp-server-pro))

## Install

```bash
npm install @saihm/shm
```

## Quickstart

Point SHM at a folder of Markdown notes and ask it for the most relevant ones:

```js
import { randomBytes } from "node:crypto";
import { openMemorySession } from "@saihm/shm/session";
import { MarkdownDirPort } from "@saihm/shm/adapter";
import { LocalMiniLmEmbedder } from "@saihm/shm/embed";
import { EncryptedIndexStore } from "@saihm/shm/store";

// Your SAIHM connection: any object whose status() returns your account status as SAIHM reports it —
// your SAIHM client, or SHM's McpSaihmClient (below).
const saihm = yourSaihmClient;

const session = await openMemorySession({
  entitlement: saihm,                              // checked first: a paid tier, or the session does not open
  port: new MarkdownDirPort({ dir: "./notes" }),   // the memories to rank
  embedder: new LocalMiniLmEmbedder(),             // runs locally
  store: new EncryptedIndexStore({ dir: "./.shm", keyBytes: randomBytes(32) }),
});

const ids = await session.answerRetriever.select("What did we decide about the launch?", { maxK: 5 });
console.log(ids);
await session.close();
```

Keep the 32-byte key to reuse the encrypted index between runs; give SHM a new key and it builds a fresh index.

### Reaching SAIHM through MCP

If your agent talks to SAIHM through MCP, use SHM's `McpSaihmClient` as the status source. Give it a `callTool` function that runs one SAIHM tool through your MCP client and returns the result as the client gives it; SHM reads the result's `structuredContent`. With the official MCP SDK:

```js
import { McpSaihmClient } from "@saihm/shm/saihm";

// `mcp` is your connected MCP SDK client.
const callTool = (name, args) => mcp.callTool({ name, arguments: args });
const saihm = new McpSaihmClient({ endpoint: "saihm", tenantId: "my-agent", callTool });
// saihm.status() runs the saihm_status tool; pass `saihm` as `entitlement`.
```

## What SHM does

- **Ranks, not dumps.** Semantic and lexical retrieval fused with Reciprocal Rank Fusion, with an optional local cross-encoder reranker (`CrossEncoderReranker`). If the reranker's model cannot load, SHM keeps answering with the base ranking.
- **Pushes context proactively.** `session.proactiveInjector()` assembles the memories relevant to the current task within a budget you set, and records why each one was chosen.
- **Keeps what it stores encrypted.** The index and any persisted memory bodies are encrypted at rest with AES-256-GCM under a key you hold.
- **Honours erasure.** When a memory is erased in SAIHM, SHM removes it from its index, caches and everything it derived from it.
- **Works with your sources.** SHM ranks whatever its read port supplies: a folder of Markdown (`MarkdownDirPort`), your own adapter over another store, or several sources federated together (`FederatedReadPort`). Through `McpSaihmClient` it reads and writes SAIHM cells: recall by query, cells shared with you, and the knowledge SHM derives.
- **Runs beside your agent.** A resident service (`ResidentSession`, `serveHttp`) keeps the index warm, and host hooks (`HostHookAdapter`) bring relevant memories into a coding session.

The embedder and the reranker run on your machine. On first use they download their pretrained models from the Hugging Face Hub and cache them.

## SHM and the SAIHM MCP server

SHM builds on [`@saihm/mcp-server-pro`](https://github.com/SAIHM-Admin/saihm-mcp-server-pro), version 0.13.0 or later. The MCP server keeps SHM in step with your SAIHM memory:

- **The change feed** tells SHM which of your memories were written, so SHM reads them again.
- **The erasure feed** tells SHM which memories were erased, so SHM removes them and everything it derived from them.
- **Share states** tell SHM which memories other agents have shared with you, and which of those shares have ended.
- **Structured tool results** give SHM each answer in a form it checks before acting on it.

## Learn more

[![SAIHM Short Overview (video)](https://img.youtube.com/vi/yCWfsGnp0rE/hqdefault.jpg)](https://youtu.be/yCWfsGnp0rE) [![SAIHM Detailed Overview (video)](https://img.youtube.com/vi/t3rXudDKank/hqdefault.jpg)](https://youtu.be/t3rXudDKank)

- **Videos:** [SAIHM Short Overview](https://youtu.be/yCWfsGnp0rE) for a quick start, and [SAIHM Detailed Overview](https://youtu.be/t3rXudDKank) for SAIHM and SHM in depth.
- **Manual:** [A decision-maker's guide to SAIHM and SHM](https://saihm.net/manual) (PDF): what SHM adds, its levers and recipes, and why to choose SAIHM with SHM.

## Support SHM

If SHM is useful to you, here is how to help it reach more people:

- **Star it on [GitHub](https://github.com/SAIHM-Admin/saihm-shm).** Stars help other developers find SHM.
- **Share it** with a colleague, your team, or anyone whose assistant keeps forgetting.
- **Follow [@SAIHMemory on X](https://x.com/SAIHMemory)** for news and updates.
- **Sponsor it** through [GitHub Sponsors](https://github.com/sponsors/SAIHM-Admin), monthly or one-time.
- **Follow along on YouTube:** like the videos, [subscribe to the channel](https://www.youtube.com/@SAIHM-Memory?sub_confirmation=1), and turn on notifications with the bell 🔔 for new videos and updates.

## Your own endpoint

You can run SHM against your own SAIHM endpoint. SAIHM is not responsible for, and has no comment regarding, endpoints developed and run by others.

## Licence

SHM is licensed under the [Business Source License 1.1](LICENSE). Production use is granted to holders of a paid SAIHM subscription who use SHM with the SAIHM account that holds it. For any other production use, a commercial licence is available through [GitHub Sponsors](https://github.com/sponsors/SAIHM-Admin). Each version converts to the Apache License, Version 2.0 on its Change Date (for this version, 2030-10-03).

See [NOTICE](NOTICE) for third-party notices and [CONTRIBUTING.md](CONTRIBUTING.md) for contributions and security reports.

---

SHM is developed by SAIHM Project.
