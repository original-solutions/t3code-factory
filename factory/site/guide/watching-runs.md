# Watch runs

The fork's web app has a Factory page, reached from the sidebar. It shows every connected environment that runs a factory, the primary environment first: what needs you and what happened while you were away at the top, then a belt with the runs of all of them, and below it one table of their runs. In the desktop app the primary is the LaunchAgent server once you have [paired it](/guide/install#install-the-desktop-app). Reading needs a normal paired session. Pausing claims, stopping a run and dismissing an item need the `orchestration:operate` scope, which a normal pairing carries.

The pages work in a phone's browser too, paired over your tailnet as described in [remote access](https://github.com/pingdotgg/t3code/tree/main/docs/user/remote-access.md). The T3 mobile app is upstream's build and has no Factory screen.

## The Factory page

<img class="screenshot light-only" src="/screenshots/factory-page-light.png" alt="The Factory page: a tile per repo, one stuck and one waiting on an answer; the control bar with claims running and the next pass; what happened in the last day with the stuck and needs-info runs; the Today strip; and the belt with one run each at Claimed, Building, Gate and PR open, the Building post open on its run" />
<img class="screenshot dark-only" src="/screenshots/factory-page-dark.png" alt="The Factory page: a tile per repo, one stuck and one waiting on an answer; the control bar with claims running and the next pass; what happened in the last day with the stuck and needs-info runs; the Today strip; and the belt with one run each at Claimed, Building, Gate and PR open, the Building post open on its run" />

Read the page from the top down. Each part answers one question.

### Is anything waiting on me?

With runs in more than one repo, the page opens on a tile for each repo, the ones that need you first: stuck, then waiting on an answer, then with a run in flight, then flowing (something merged in the last seven days), then quiet. Each tile says what else is going on and when it last merged, and draws its last seven days as bars, green for what merged and red for what stopped. Click a tile to show only that repo on the whole page, the belt and its bins included. Click it again, or **Show everything**, to see every repo. It is the same filter as the repo in the **Showing** line.

Until the factory has run anything, the page opens on what stands between it and its first run instead: a watched repo, a config it can build from, claims on, and an issue labelled `factory:ready`. Each step says where it stands, with the first config error or a **Turn claims on** button where that is what is missing.

### What happened while I was away?

Under the control bar, the catch-up says what the factory did since you last caught up, or in the last day before you ever have. It counts what merged, closed and was claimed, lists the runs that stopped for you (stuck or needs info, unless a later attempt took over) with why, and lists the merged and closed issues. Each one opens its run. Press **Mark caught up** and your next visit counts from there. The mark is kept in this browser, and the catch-up follows the **Showing** line.

The **Today** strip under it draws each run that touched today as a bar from its claim to its end (to now while it runs), coloured by its post or by how it ended. Click a bar to open the run.

### What is the factory doing now?

The belt has five posts, one per station a run passes: Claimed, Building, Gate, PR open and Done. Each unfinished run is a tile under its post, showing its issue number and how long it has been there. Click a tile to open the run. When its agent's thread is on this device, the tile's dot wears what the agent is doing (teal working, amber waiting on you, red failed, grey idle), its top strip fades while the agent is idle, and a light runs once along the strip when the agent changes state, such as starting work or stopping to wait on you. The post says the same as a count, such as `1 needs you · 2 working`. Paused claims grey out only the Claimed lane; runs already on the belt keep their colours. Click a post to open a table of its runs under the rail, with each run's title and step and the actions that can work on it: its thread, its pull request, and **Stop** while it is building. Done counts the runs whose pull request was merged or closed today. The belt reads status every 5 seconds while the page is open.

### Every run, searchable

Under the belt and its bins, the runs table lists every unfinished run and the runs that finished in the last week, newest first under a heading for each day. Each row has the run's title, repo, issue, state, current step, age and pull request, and the state wears its post's colour. A run that ended because its pull request was merged or closed says Merged or Closed. The newest attempt of a stuck issue gets **Next step**, and of a needs-info issue **Answer**.

- The chips above the table (Active, Needs a person, Merged, Closed) narrow it to one state and count the runs in each. The chip is in the URL.
- Type in the search box to keep the runs whose title, repo or run id holds every word, or `#20` for one issue or pull request.
- The table shows 50 runs at a time. **Show more** adds the next 50, and `j` past the last run does it for you. **Show all runs** reads the full history.

It refreshes every 30 seconds.

### Finding a run from anywhere

Open the command palette (`⌘K`, or `Ctrl+K`) on any screen and type an issue number, a repo or words from a title: `294`, `watchalong` or `pkce` lists the matching runs and repos under Suggestions. Choose **Factory** in the palette to search every run on every machine, including by state, why it stopped and when it ran, such as `lint` or `stuck last week`. A run opened this way steps through its repo's runs with `j` and `k`, and Back opens the Factory page on that repo.

### Several repos or machines

With several environments or repos, narrow the page with the **Showing** line under its title: pick a repo, each listed with how it is doing, and with several environments a machine, each with its state. The line stays in view as you scroll, **Show everything** clears both, and the choice is in the URL, so a reload or a shared link keeps it.

With several environments, the control bar lists every machine on its own row: its claims switch, whether it is running, paused (since when), held for an update or idle (and why, with a link to Settings → Factory), its slots, the countdown to its next pass, and **Update waiting** when a build waits to install. A paused or held machine shows without being picked. Pick a machine by its name: its tiles on the rail turn solid while the others' are hollow, the Claimed post says when its claims are held, its update banner shows, and the Today strip shades the time its claims have been held. The catch-up, the Today strip's bars, Done and the Stuck and Needs info bins don't change with the pick. With one environment, its slots are beside its name above the control bar, and an idle factory says why there.

### Pausing claims

Turn a claims switch off to pause claims on that machine. While claims are paused the factory takes no new `factory:ready` issues in any repo. Runs already under way carry on: sessions, gates and feedback all continue. Turn the switch back on to start claiming again.

Claims also stop while autodeploy has a new build waiting to install. The belt then shows an **Update waiting** banner naming the build, how long it has waited and when it installs at the latest, and what it waits for: each run in progress (a link to it), a factory pass running, and threads with an agent at work. It installs within 10 minutes of the last of those finishing. The Claimed post says `claims held for update`. **Snooze 1 hour** lets claims go on for an hour and holds the install. **Update now** installs it at once, over the runs in progress. Snoozing needs the `orchestration:operate` scope and Update now the `environment:maintain` scope. See [Follow main](/guide/install#follow-main).

### Trends

To see whether a change to how you write issues, or to a repo's config, is helping, switch the page header from **Live** to **Trends**. It counts every run by the week it was claimed, for up to eight weeks: a bar per week split by how its runs came out, and for each week how many merged, the share of ended runs that got stuck or needed info, and the median time from claim to merge. The top row sets this week against the four weeks before it, and **Why runs got stuck** lists the causes with a count per week, so a cause you fixed should fade. Pick a week's bar or row to narrow the causes to that week, and open a cause to list its runs; each opens its run page, where `j` and `k` step through the rest of that cause's runs. Trends follow the **Showing** line and read the full runs list once, as Show all runs does.

## A run's page

<img class="screenshot light-only" src="/screenshots/run-page-light.png" alt="A PR open run's page: the run card with its repo and issue, the PR open chip and step, links to its thread, issue and pull request, and the five-post track filled up to PR open; then the timeline, where gate attempt 1 failed on npm test and was sent back before attempt 2 passed, and the last gate output" />
<img class="screenshot dark-only" src="/screenshots/run-page-dark.png" alt="A PR open run's page: the run card with its repo and issue, the PR open chip and step, links to its thread, issue and pull request, and the five-post track filled up to PR open; then the timeline, where gate attempt 1 failed on npm test and was sent back before attempt 2 passed, and the last gate output" />

Open a run from anywhere it is listed to see why it is where it is. The page's header names the issue, and the run card under it says where the run stands: its repo and issue, its state in the belt's colours with the current step, links to its **Thread**, **Issue** and **PR**, and a track of the five posts filled up to where the run got. A run that stopped shows its post in red or amber with "stuck" or "needs info" beside it.

While a run is unfinished, its Thread link here, on the belt and in the runs list says what the agent is doing (working, needs approval, needs answer, turn ended, failed). On its page the run card adds a line under the track with the same state, since when, how many items its thread holds and when it last changed.

### When it stopped: what to do next

<img class="screenshot light-only" src="/screenshots/run-stuck-light.png" alt="A stuck run's page: the run card with its track red at PR open, then What to do next, headed The gate failed after 3 attempts, with step 1 to read the gate output, naming the command that failed, and step 2 to set factory:ready on the issue again, saying the new run continues the pull request" />
<img class="screenshot dark-only" src="/screenshots/run-stuck-dark.png" alt="A stuck run's page: the run card with its track red at PR open, then What to do next, headed The gate failed after 3 attempts, with step 1 to read the gate output, naming the command that failed, and step 2 to set factory:ready on the issue again, saying the new run continues the pull request" />

A stuck or needs-info run's page opens on **What to do next**. Its heading is the cause in plain words. Step 1 is the fix, with a button to where it starts: the session's thread, the gate output, the pull request's checks, or the issue to answer. Step 2 is the reminder to set `factory:ready` again, and says what the new run will build on. The reason in full sits under the steps. For a needs-info run, step 1 holds the session's questions with a box to answer each; see [needs-info](/guide/when-a-run-stops#needs-info).

### When it merged: how it went

<img class="screenshot light-only" src="/screenshots/run-merged-light.png" alt="A merged run's page: the run card with its track full to Merged, then How it went: 5h 49m from claim to merge, First try, and a bar split into agent building, gate and waiting on review with the time and share of each" />
<img class="screenshot dark-only" src="/screenshots/run-merged-dark.png" alt="A merged run's page: the run card with its track full to Merged, then How it went: 5h 49m from claim to merge, First try, and a bar split into agent building, gate and waiting on review with the time and share of each" />

A run whose pull request was merged or closed opens on **How it went**: the time from claim to merge or close, and a bar of where that time went (the agent building, the gate, the pull request waiting on review). Dots on the bar mark where the run went back to the agent (a gate failure, review feedback) or the base branch moved. **First try** means it merged with nothing sent back.

### The timeline, the gate and the ledger

Below the card is the run's timeline: what happened, in plain words, timed from the claim. Each gate run is one step with its commands, each agent session links to its own thread, and the summary above it says how long the run took and how many gate runs failed.

Once a gate has run, **Last gate output** comes next: each command with its exit code and duration. When a command failed, it shows the failing lines of its output with a few lines around them, numbered and marked, with the whole output a click away and a button to copy it.

Last is the raw ledger, every event the factory recorded for the run, closed until you open it.

### Moving between runs

A run opened from the runs table or from the Stuck or Needs info bin keeps that list: its header shows where the run sits (`3 of 17`), and the arrows beside it open the previous or next run. Back returns to the list with the same filters and search, on the run you left.

From a keyboard, `j` and `k` step through the runs table and `Enter` opens one. On a run's page `j` and `k` move to the next and previous run and `Esc` goes back. `/` jumps to the search box. `b`, `a`, `n`, `s` and `r` jump to the belt, Needs attention, Needs info, Stuck and the runs table, and the first Tab on the page offers the same jumps. `?` lists every key.

A run in `factory:building` can be stopped from its page. See [Stopping a run by hand](/guide/when-a-run-stops#stopping-a-run-by-hand).

## Needs attention

<img class="screenshot light-only" src="/screenshots/needs-attention-light.png" alt="The bins under the belt: Needs attention with a stuck item and a needs-info item, each with View run and Dismiss, beside the Needs info bin with the run's questions and the Stuck bin with its runs folded under the cause, The gate failed after 3 attempts" />
<img class="screenshot dark-only" src="/screenshots/needs-attention-dark.png" alt="The bins under the belt: Needs attention with a stuck item and a needs-info item, each with View run and Dismiss, beside the Needs info bin with the run's questions and the Stuck bin with its runs folded under the cause, The gate failed after 3 attempts" />

Under the belt, the Factory page lists what needs a person in three bins: Needs attention, Needs info and Stuck. Needs info lists each run's issue with the questions it asked. Stuck sorts its runs by why they stopped: each cause, such as "The run passed its time limit", is a fold with its count and issue numbers, the biggest first, and opening it shows each run with its repo, age and the rest of its reason. The sidebar's Factory item shows how many items need attention, and a dot while runs are in flight or claims are held. Hover it for the runs in flight, each a link to its run, without leaving your thread. An item is raised when:

- a run went to `factory:stuck` or `factory:needs-info`,
- a run is holding a slot but nothing will move it, for example its label was changed by hand,
- the machine config failed to load,
- free disk space is below `min_free_gib`, so nothing is claimed or gated until there is room,
- a build autodeploy has waiting has waited longer than `deploy_wait_minutes`, while the factory claims nothing; it clears once the build is installed, which the belt's update banner can start at once,
- three passes in a row failed,
- a stopped session's worktree was deleted or is no longer a git checkout, so the factory archived the threads still on it.

An item for a stuck or held run links to it, and one for a config problem links to Settings → Factory; the archived-worktree item names its run in the message. Each new item also posts a macOS notification, as does a run abandoned because its issue was closed, on the server's Mac, unless `notify` is `false` in the [machine config](/guide/machine-config).

The app you watch from tells you too, on any machine, following Settings → Notifications: while T3 Code has focus, a toast names the new item with a button to its run (none on a Factory page, which already shows it); while it doesn't, a system notification does the same. Several new items at once arrive as one notice with their count. The app hears of an item at its next status read, every half minute while you're using it.

An item clears itself when its cause goes away: the config loads, a pass succeeds, the issue is claimed again, the disk has room again. An archived-worktree item stays until its issue is claimed again, so dismiss it once you've looked. Dismiss an item to hide it once you've dealt with it. A dismissed item stays hidden until its cause clears and comes back.

## Settings → Factory

<img class="screenshot light-only" src="/screenshots/settings-factory-light.png" alt="Settings, Factory: the Machine config card with the GitHub config directory, poll seconds, the run and gate limits and feedback seconds, each number with its unit, the hand-edited keys as chips, and Save in the card's foot beside the file it writes" />
<img class="screenshot dark-only" src="/screenshots/settings-factory-dark.png" alt="Settings, Factory: the Machine config card with the GitHub config directory, poll seconds, the run and gate limits and feedback seconds, each number with its unit, the hand-edited keys as chips, and Save in the card's foot beside the file it writes" />

Use it to change the [machine config](/guide/machine-config) and to check which repos are watched. Until the factory has a watched repo it can build from, the page opens on the same first-run steps as the Factory page.

The Machine config card edits the GitHub config directory, the poll interval, the run and gate limits and how often to read pull request feedback. The keys you edit by hand in the file are listed as chips under the form, and a save keeps them as written. **Save** is in the card's foot, beside the file it writes (`~/.config/t3fac/factory/config.yml`), and stays in view while you have unsaved changes. Saving needs a session that may change settings.

Below the form, Watched repos lists one line per repo with a coloured dot and its state (Error, Not read yet, Defaults or Ready), repos with errors first and the first error shown on the line. Open a line for its T3 project's folder and its `factory` block as the last pass read it (from GitHub, or from the checkout when GitHub has no copy), including any errors that stop the factory using it. Repos the factory couldn't settle on its last read are listed separately with the reason. [Add a repo](/guide/add-a-repo) explains what makes a repo watched.
