# Working in this fork

`original-solutions/t3code-factory` is `pingdotgg/t3code` plus a software factory. Every day `factory/scripts/sync.sh` merges upstream's newest nightly tag into `main`. The rules below keep that merge clean. [README.md](README.md) describes the seam and boundary checks; this file is how to write code that passes them and survives the next sync.

## Put code in fork-owned paths

Factory code lives in `apps/server/src/factory/`, `apps/web/src/factory/`, `apps/desktop/src/factory/`, `apps/mobile/src/factory/`, `apps/web/src/routes/factory*`, `apps/web/src/routes/_chat.settings.factory*`, `factory/`, `.dw/` and `.github/workflows/factory-*`. New files go there, tests included: a test for a seam hook sits in `apps/web/src/factory/`, `apps/desktop/src/factory/`, `apps/mobile/src/factory/` or `apps/server/src/factory/` next to the fork code it exercises, not beside the upstream file. A new file at an upstream path becomes a seam the sync has to carry forever.

## A seam is a hook, not a feature

A seam is an upstream file listed in [SEAMS](SEAMS). Edit one only to call fork-owned code, and keep the edit to the smallest hook that works:

- One import and one call, or one entry in a list. `pathname === "/factory" || pathname.startsWith("/factory/")` belongs in a fork file as `isFactoryPage(pathname)`, and the upstream function calls it. Settings search entries and nav links live in a fork-owned list that the upstream file spreads in.
- Append the hook after upstream's lines. Leave upstream's text, comments, order and formatting exactly as they are. The one conflict in the first sync, `v0.1.1-nightly.20261017.3238`, was a comment the fork had reworded and upstream then deleted.
- When upstream has to change for the hook to fit, send that change upstream and add the fork hook once it lands.

## Adding a seam

Reach for a fork-owned path first. When a hook must touch a new upstream file, add the path to `SEAMS` in the same commit and say in the pull request why no fork-owned path worked. These stay upstream's: `apps/server/src/ws.ts`, `apps/server/src/rpc.ts`, `packages/contracts/`, `apps/server/src/persistence/Migrations.ts`, `package.json`, `pnpm-lock.yaml`, `AGENTS.md`, and every workflow under `.github/workflows/` other than `factory-*`. The factory has its own HTTP route layer, config file and workflows so that it never needs them.

## Resolving a sync conflict

A sync branch merges the tag; it is never rebased. In a conflicted seam, take upstream's side and re-add the fork hook below it. A conflicted `apps/web/src/routeTree.gen.ts` is regenerated with `factory/scripts/regenerate-routes.sh`, never edited by hand. Then write `<tag> <sha>` to [UPSTREAM](UPSTREAM) and run `factory/scripts/check.sh`.
