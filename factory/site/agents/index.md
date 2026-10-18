# For agents

Reference for an agent that files work for the factory or operates it. Facts only; the [Guide](/guide/) explains them.

| Page                                     | Use it to                                                 |
| ---------------------------------------- | --------------------------------------------------------- |
| [Issue contract](/agents/issue-contract) | File an issue the factory can build.                      |
| [Repo config](/agents/repo-config)       | Write or check a repo's `.dw/config.yml` `factory` block. |
| [Machine config](/agents/machine-config) | Write or check `~/.config/t3fac/factory/config.yml`.      |
| [Runs and result line](/agents/runs)     | Read run states, end a build session, read the HTTP API.  |
| [Scripts](/agents/scripts)               | Run `factory/scripts/*` and read their exit codes.        |

Paths in these pages are the defaults of the LaunchAgent install:

| Thing              | Path                                                             |
| ------------------ | ---------------------------------------------------------------- |
| T3 base dir        | `~/.config/t3fac`                                                |
| Factory data dir   | `~/.config/t3fac/factory`                                        |
| Machine config     | `~/.config/t3fac/factory/config.yml`                             |
| Run ledgers        | `~/.config/t3fac/factory/runs/<run id>.jsonl`                    |
| Machine log        | `~/.config/t3fac/factory/events.jsonl`                           |
| Server log         | `~/Library/Logs/t3fac/t3fac.log`                                 |
| Installed versions | `~/.local/share/t3fac/versions/<version>`, `current`, `previous` |
| Server port        | `3876`                                                           |
| LaunchAgents       | `io.github.rawphp.t3fac`, `io.github.rawphp.t3fac.logrotate`     |

```text
~/.config/t3fac/
├── env
├── gh/
└── factory/
    ├── config.yml
    ├── runs/
    ├── stop-requests/
    └── events.jsonl
~/.local/share/t3fac/
├── versions/<version>
├── current -> versions/<version>
├── previous -> versions/<version>
└── rotate-log.sh
~/Library/Logs/t3fac/
├── t3fac.log
└── logrotate.log
~/Library/LaunchAgents/
├── io.github.rawphp.t3fac.plist
└── io.github.rawphp.t3fac.logrotate.plist
```

`env` is optional and `stop-requests/` appears when a stop is requested. `previous` exists only after installing a different version and is removed by a rollback.

The whole site as plain text: [llms.txt](https://t3code-factory-docs.originalsolutions.com.au/llms.txt), [llms-full.txt](https://t3code-factory-docs.originalsolutions.com.au/llms-full.txt).
