# SHM — Super-Human Memory

**The right memory, at the right moment.** SHM brings your AI agent the memories that
matter for the task in front of it — ranked, on time, and encrypted on your machine. It
is the layer on top of [SAIHM](https://github.com/SAIHM-Admin/saihm-mcp-server-pro)
that puts that memory to work.

[![npm version](https://img.shields.io/npm/v/@saihm/shm.svg)](https://www.npmjs.com/package/@saihm/shm)
[![license](https://img.shields.io/npm/l/@saihm/shm.svg)](./LICENSE)
[![Star on GitHub](https://img.shields.io/badge/GitHub-Star-181717?logo=github&logoColor=white)](https://github.com/SAIHM-Admin/saihm-shm)
[![Sponsor SAIHM](https://img.shields.io/badge/Sponsor-SAIHM-ea4aaa?logo=githubsponsors&logoColor=white)](https://github.com/sponsors/SAIHM-Admin)
[![Subscribe on YouTube](https://img.shields.io/badge/YouTube-Subscribe-FF0000?logo=youtube&logoColor=white)](https://www.youtube.com/@SAIHM-Memory?sub_confirmation=1)
[![Follow on X](https://img.shields.io/badge/X-Follow-000000?logo=x&logoColor=white)](https://x.com/SAIHMemory)

<table>
  <tr>
    <td width="50%"><a href="https://www.youtube.com/watch?v=yCWfsGnp0rE"><img src="https://img.youtube.com/vi/yCWfsGnp0rE/maxresdefault.jpg" alt="Watch on YouTube: SAIHM Short Overview, 6 minutes" width="100%"></a></td>
    <td width="50%"><a href="https://www.youtube.com/watch?v=t3rXudDKank"><img src="https://img.youtube.com/vi/t3rXudDKank/maxresdefault.jpg" alt="Watch on YouTube: SAIHM Detailed Overview, 30 minutes" width="100%"></a></td>
  </tr>
  <tr>
    <td align="center"><b>▶ SAIHM Short Overview</b><br>6 minutes</td>
    <td align="center"><b>▶ SAIHM Detailed Overview</b><br>30 minutes</td>
  </tr>
</table>

**Enjoyed them?** Like the videos, [subscribe to the SAIHM channel](https://www.youtube.com/@SAIHM-Memory?sub_confirmation=1),
and turn on notifications with the bell 🔔 to hear about new videos and updates.

**Prefer to read?** [The SAIHM manual](https://saihm.net/manual) (PDF) is a
decision-maker's guide to SAIHM and SHM.

## What SHM gives you

SAIHM keeps your agent's memory safe. SHM makes it work efficiently: it organises that
memory and brings the right part of it forward, by meaning, before the agent asks.

- **The right memories, not all of them.** SHM ranks what your agent remembers and
  brings forward only what the current task needs, within a budget you set. The context
  window stays clean and tasks stay apart.
- **Ready before the question.** SHM puts the relevant memories in front of your agent
  as the work begins, and records why each one was chosen.
- **Private by design.** SHM runs on your side, next to your agent. Everything it stores
  is encrypted under a key you hold, and its models run on your own machine.
- **Erasure that reaches every copy SHM holds.** When a memory is erased in SAIHM, SHM removes it
  from its index, its caches and everything it derived from it.
- **Picks up where you left off.** SHM can save an encrypted snapshot of its state and
  resume in a new session or on another device.

## Who it's for

SHM is for teams and builders whose agents hold a paid SAIHM subscription and want their
memory to do more of the work. It runs beside any agent that reaches SAIHM, through the
SAIHM client or an MCP client.

## Get started

```bash
npm install @saihm/shm
```

You need Node.js 20.20 or later, a paid SAIHM subscription, and
[`@saihm/mcp-server-pro`](https://github.com/SAIHM-Admin/saihm-mcp-server-pro) version
0.13.0 or later. The [developer guide](#developer-guide) below takes you from install to
your first ranked answer.

## Support SHM

If SHM is useful to you, here is how to help it reach more people:

- **Star it on [GitHub](https://github.com/SAIHM-Admin/saihm-shm).** Stars help other developers find SHM.
- **Share it** with a colleague, your team, or anyone whose assistant keeps forgetting.
- **Follow [@SAIHMemory on X](https://x.com/SAIHMemory)** for news and updates.
- **Sponsor it** through [GitHub Sponsors](https://github.com/sponsors/SAIHM-Admin), monthly or one-time.
- **Follow along on YouTube:** like the videos, [subscribe to the channel](https://www.youtube.com/@SAIHM-Memory?sub_confirmation=1), and turn on notifications with the bell 🔔 for new videos and updates.

---

## Developer guide

### Quickstart

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

### How access works

Before a session opens, SHM confirms with SAIHM that your account holds a paid tier: `PRO`, `PRO_FAST`, `ENTERPRISE` or `ENTERPRISE_FAST`. The session opens as soon as the check passes; any other answer, an error or a timeout keeps it closed, and nothing is locked, written or read until then. The check waits up to 15 seconds by default (`entitlementTimeoutMs`). The first start of the SAIHM MCP server after an install or upgrade can take longer while it downloads, so start it once beforehand or raise the timeout.

SHM takes the tier straight from your account status as SAIHM reports it, never from an environment variable or configuration file. The [licence](#licence) sets the terms of use.

### What's inside

- **Hybrid ranking.** Semantic and lexical retrieval fused with Reciprocal Rank Fusion, with an optional local cross-encoder reranker (`CrossEncoderReranker`). If the reranker's model cannot load, SHM keeps answering with the base ranking.
- **Proactive context.** `session.proactiveInjector()` assembles the memories relevant to the current task within a budget you set, and records why each one was chosen.
- **Encryption at rest.** The index and any persisted memory bodies are encrypted with AES-256-GCM under a key you hold.
- **Your sources.** SHM ranks whatever its read port supplies: a folder of Markdown (`MarkdownDirPort`), your own adapter over another store, or several sources federated together (`FederatedReadPort`). Through `McpSaihmClient` it reads and writes SAIHM cells: recall by query, cells shared with you, and the knowledge SHM derives.
- **Resident service.** A resident service (`ResidentSession`, `serveHttp`) keeps the index warm, and host hooks (`HostHookAdapter`) bring relevant memories into a coding session.

The embedder and the reranker run on your machine. On first use they download their pretrained models from the Hugging Face Hub and cache them.

### SHM and the SAIHM MCP server

SHM builds on [`@saihm/mcp-server-pro`](https://github.com/SAIHM-Admin/saihm-mcp-server-pro), version 0.13.0 or later. The MCP server keeps SHM in step with your SAIHM memory:

- **The change feed** tells SHM which of your memories were written, so SHM reads them again.
- **The erasure feed** tells SHM which memories were erased, so SHM removes them and everything it derived from them.
- **Share states** tell SHM which memories other agents have shared with you, and which of those shares have ended.
- **Structured tool results** give SHM each answer in a form it checks before acting on it.
- **Warm start** lets SHM save an encrypted snapshot of its state and pick up where it left off in a new session or on another device.

### Your own endpoint

You can run SHM against your own SAIHM endpoint. SAIHM is not responsible for, and has no comment regarding, endpoints developed and run by others.

## Licence

SHM is licensed under the [Business Source License 1.1](LICENSE). Production use is granted to holders of a paid SAIHM subscription who use SHM with the SAIHM account that holds it. For any other production use, a commercial licence is available through [GitHub Sponsors](https://github.com/sponsors/SAIHM-Admin). Each version converts to the Apache License, Version 2.0 on its Change Date, stated in LICENSE.

See [NOTICE](NOTICE) for third-party notices and [CONTRIBUTING.md](CONTRIBUTING.md) for contributions and security reports.

---

SHM is developed by SAIHM Project.
