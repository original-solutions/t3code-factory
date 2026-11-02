# Watch runs

The fork's web app has a Factory page, reached from the sidebar. It shows every connected environment that runs a factory, the primary environment first: what needs you and what happened while you were away at the top, then a belt with the runs of all of them, and below it one table of their runs. In the desktop app the primary is the LaunchAgent server once you have [paired it](/guide/install#install-the-desktop-app). Reading needs a normal paired session. Pausing claims, stopping a run and dismissing an item need the `orchestration:operate` scope, which a normal pairing carries.

The pages work in a phone's browser too, paired over your tailnet as described in [remote access](https://github.com/pingdotgg/t3code/tree/main/docs/user/remote-access.md). On a narrow screen the repo tiles, the control bar's dials and the belt's posts stack in one column, in the same order. The T3 mobile app is upstream's build and has no Factory screen.

<img class="screenshot light-only" src="/screenshots/factory-phone-light.jpg" width="300" alt="The Factory page in a phone's browser: the Live, Queue and Trends switch, the two repo tiles side by side, then the control bar's dials one under another, claims running on build-mac with 2 of 2 slots, the machine healthy, and the last day with 2 runs that need you, then the Today strip and the Claimed post" />
<img class="screenshot dark-only" src="/screenshots/factory-phone-dark.jpg" width="300" alt="The Factory page in a phone's browser: the Live, Queue and Trends switch, the two repo tiles side by side, then the control bar's dials one under another, claims running on build-mac with 2 of 2 slots, the machine healthy, and the last day with 2 runs that need you, then the Today strip and the Claimed post" />

## The Factory page

<img class="screenshot light-only" src="/screenshots/factory-page-light.jpg" alt="The Factory page: a tile per repo, both with stuck runs; the control bar's row of dials, claims running on build-mac with the next pass, the machine healthy with small disk, load and gate gauges, and the last day's counts with 2 that need you beside Mark caught up; the Today strip; the belt with one run each at Claimed, Building, Gate and PR open, the Building post open on its run; and the Needs attention, Needs info and Stuck bins" />
<img class="screenshot dark-only" src="/screenshots/factory-page-dark.jpg" alt="The Factory page: a tile per repo, both with stuck runs; the control bar's row of dials, claims running on build-mac with the next pass, the machine healthy with small disk, load and gate gauges, and the last day's counts with 2 that need you beside Mark caught up; the Today strip; the belt with one run each at Claimed, Building, Gate and PR open, the Building post open on its run; and the Needs attention, Needs info and Stuck bins" />

Read the page from the top down. Each part answers one question.

### Is anything waiting on me?

With runs in more than one repo, the page opens on a tile for each repo, the ones that need you first: stuck, then waiting on an answer, then with a run in flight, then flowing (something merged in the last seven days), then quiet. Each tile says what else is going on and when it last merged, and draws its last seven days as bars, green for what merged and red for what stopped. Click a tile to show only that repo on the whole page, the belt and its bins included. Click it again, or **Show everything**, to see every repo. It is the same filter as the repo in the **Showing** line.

Until the factory has run anything, the page opens on what stands between it and its first run instead: a watched repo, a config it can build from, claims on, and an issue labelled `factory:ready`. Each step says where it stands, with the first config error or a **Turn claims on** button where that is what is missing.

### Is the machine OK?

The control bar reads in one row: the claims switch with the machine's slots and next pass, the **Machine** dial, and the catch-up. Click a dial to open its detail under the row, and click it again to fold it; one opens at a time, and the browser keeps it open for your next visit.

<img class="screenshot light-only" src="/screenshots/machine-dial-light.jpg" alt="The control bar with the Machine dial open: under the row of dials, a full gauge each for Disk with the free space and the disk's size, Load with a tick where it would hold claims, and Gates, none running" />
<img class="screenshot dark-only" src="/screenshots/machine-dial-dark.jpg" alt="The control bar with the Machine dial open: under the row of dials, a full gauge each for Disk with the free space and the disk's size, Load with a tick where it would hold claims, and Gates, none running" />

The **Machine** dial says whether the machine under the factory is fine, and if not, what holds claims, with a small gauge each for the disk, load and gates. Open it for the full gauges: **Disk**, the free space where worktrees and gates write, with a tick at `min_free_gib`; **Load**, the 1-minute load with a tick at `max_load_per_core` times the cores; and **Gates**, how many run and how long the oldest has. A bar past its tick holds claims, and an amber one is getting close. Each hold is listed with what lifts it: the Claims switch for a pause, the install for a waiting update, free space for a low disk, **Sign in** for a signed-out `gh`. A low disk says how much to free, copies a command that lists the biggest folders there, and links to Factory settings. The gauges read again with every status, so once you free enough space the line says the next pass claims again. Set the two limits in Settings → Factory or the [machine config](/guide/machine-config).

### What happened while I was away?

The control bar's catch-up dial says what the factory did since you last caught up, or in the last day before you ever have. It counts what merged, closed and was claimed and how many runs need you; open it for the runs that stopped for you (stuck or needs info, unless a later attempt took over) with why, and the merged and closed issues. Each one opens its run. Press **Mark caught up**, beside the dial, and your next visit counts from there. The mark is kept in this browser, and the catch-up follows the **Showing** line.

The **Today** strip under the row draws each run that touched today as a bar from its claim to its end (to now while it runs), coloured by its post or by how it ended. Click a bar to open the run.

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

With several environments, the control bar lists every machine on its own row: its claims switch, whether it is running, paused (since when), held for an update, a low disk, a high load or a signed-out `gh`, or idle (and why, with a link to Settings → Factory), its slots, the countdown to its next pass, and **Update waiting** when a build waits to install. A paused or held machine shows without being picked. Pick a machine by its name: its tiles on the rail turn solid while the others' are hollow, the Claimed post says when its claims are held, its update banner shows, and the Today strip shades the time its claims have been held. The catch-up, the Today strip's bars, Done and the Stuck and Needs info bins don't change with the pick. With one environment, its name and slots sit over its claims switch, and an idle factory says why above the control bar.

### Pausing claims

Turn a claims switch off to pause claims on that machine. While claims are paused the factory takes no new `factory:ready` issues in any repo. Runs already under way carry on: sessions, gates and feedback all continue. Turn the switch back on to start claiming again.

Claims also stop while autodeploy has a new build waiting to install. The belt then shows an **Update waiting** banner naming the build, how long it has waited and when it installs at the latest, and what it waits for: each run in progress (a link to it) and threads with an agent at work. It installs within 10 minutes of the last of those finishing. The Claimed post says `claims held for update`. **Snooze 1 hour** lets claims go on for an hour and holds the install. **Update now** installs it at once, over the runs in progress. Snoozing needs the `orchestration:operate` scope and Update now the `environment:maintain` scope. See [Follow main](/guide/install#follow-main).

### Queue

Switch the header to **Queue** for the `factory:ready` issues the factory hasn't claimed yet and why each waits. See [See what waits](/guide/filing-work#see-what-waits).

### Trends

<img class="screenshot light-only" src="/screenshots/trends-light.jpg" alt="Trends: the last 7 weeks as a bar per week split into merged, stuck, needs info and in flight, this week against the four before it, a row per week with its runs, merged, stuck and needs-info shares and time to merge, and Why runs got stuck, with the time limit at 5 runs fading over the weeks and the failed gate at 3" />
<img class="screenshot dark-only" src="/screenshots/trends-dark.jpg" alt="Trends: the last 7 weeks as a bar per week split into merged, stuck, needs info and in flight, this week against the four before it, a row per week with its runs, merged, stuck and needs-info shares and time to merge, and Why runs got stuck, with the time limit at 5 runs fading over the weeks and the failed gate at 3" />

To see whether a change to how you write issues, or to a repo's config, is helping, switch the page header from **Live** to **Trends**. It counts every run by the week it was claimed, for up to eight weeks: a bar per week split by how its runs came out, and for each week how many merged, the share of ended runs that got stuck or needed info, and the median time from claim to merge. The top row sets this week against the four weeks before it, and **Why runs got stuck** lists the causes with a count per week, so a cause you fixed should fade. Pick a week's bar or row to narrow the causes to that week, and open a cause to list its runs; each opens its run page, where `j` and `k` step through the rest of that cause's runs. Trends follow the **Showing** line and read the full runs list once, as Show all runs does.

## A run's page

<img class="screenshot light-only" src="/screenshots/run-page-light.jpg" alt="A PR open run's page: the run card with its repo and issue, the PR open chip and step, links to its thread, issue and pull request, and the five-post track filled up to PR open; then the bar with Timeline, Gate with a green dot, Issue & PR and Ledger with its count, Timeline open: claimed, the agent session, the pull request opened, gate attempt 1 failed on npm test and was sent back, and attempt 2 passed" />
<img class="screenshot dark-only" src="/screenshots/run-page-dark.jpg" alt="A PR open run's page: the run card with its repo and issue, the PR open chip and step, links to its thread, issue and pull request, and the five-post track filled up to PR open; then the bar with Timeline, Gate with a green dot, Issue & PR and Ledger with its count, Timeline open: claimed, the agent session, the pull request opened, gate attempt 1 failed on npm test and was sent back, and attempt 2 passed" />

Open a run from anywhere it is listed to see why it is where it is. The page's header names the issue, and the run card under it says where the run stands: its repo and issue, its state in the belt's colours with the current step, links to its **Thread**, **Issue** and **PR**, and a track of the five posts filled up to where the run got. A run that stopped shows its post in red or amber with "stuck" or "needs info" beside it.

While a run is unfinished, its Thread link here, on the belt and in the runs list says what the agent is doing (working, needs approval, needs answer, turn ended, failed). On its page the run card adds a line under the track with the same state, since when, how many items its thread holds and when it last changed.

### When it stopped: what to do next

<img class="screenshot light-only" src="/screenshots/run-stuck-light.jpg" alt="A stuck run's page: the run card with its track red at PR open, then What to do next, headed The gate failed after 3 attempts, with step 1 to read the gate output, naming the command that failed, and step 2 to set factory:ready on the issue again, saying the new run continues the pull request; below, the bar open on Gate with a red dot, showing attempt 3's commands" />
<img class="screenshot dark-only" src="/screenshots/run-stuck-dark.jpg" alt="A stuck run's page: the run card with its track red at PR open, then What to do next, headed The gate failed after 3 attempts, with step 1 to read the gate output, naming the command that failed, and step 2 to set factory:ready on the issue again, saying the new run continues the pull request; below, the bar open on Gate with a red dot, showing attempt 3's commands" />

A stuck or needs-info run's page opens on **What to do next**. Its heading is the cause in plain words. Step 1 is the fix, with a button to where it starts: the session's thread, the gate output, the pull request's checks, or the issue to answer. Step 2 is the reminder to set `factory:ready` again, and says what the new run will build on. The reason in full sits under the steps. For a needs-info run, step 1 holds the session's questions with a box to answer each; see [needs-info](/guide/when-a-run-stops#needs-info).

### When it merged: how it went

<img class="screenshot light-only" src="/screenshots/run-merged-light.jpg" alt="A merged run's page: the run card with its track full to Merged, then How it went: 5h 49m from claim to merge, First try, and a bar split into agent building, gate and waiting on review with the time and share of each; below, the timeline from the claim to the pull request merged" />
<img class="screenshot dark-only" src="/screenshots/run-merged-dark.jpg" alt="A merged run's page: the run card with its track full to Merged, then How it went: 5h 49m from claim to merge, First try, and a bar split into agent building, gate and waiting on review with the time and share of each; below, the timeline from the claim to the pull request merged" />

A run whose pull request was merged or closed opens on **How it went**: the time from claim to merge or close, and a bar of where that time went (the agent building, the gate, the pull request waiting on review). Dots on the bar mark where the run went back to the agent (a gate failure, review feedback) or the base branch moved. **First try** means it merged with nothing sent back.

### Timeline, Gate, Issue & PR and Ledger

Below the run card and its lead, the rest of the run sits behind one bar: **Timeline**, **Gate**, **Issue & PR** and **Ledger**. The page opens the part that matters for the run's state: the timeline while it builds, the gate output when the gate stopped it, the issue when it asked questions or ran out of time, and the pull request once it has one and the agent is done. Pick another part and it stays picked while the page refreshes. The bar stays at the top as a long part scrolls.

**Timeline** is what happened, in plain words, timed from the claim. Each gate run is one step with its commands, each agent session links to its own thread, and the summary above it says how long the run took and how many gate runs failed.

**Gate**, once a gate has run, is the last gate's output, with a dot for whether it passed: each command with its exit code and duration. When a command failed, it shows the failing lines of its output with a few lines around them, numbered and marked, with the whole output a click away and a button to copy it.

**Issue & PR** (just **Issue** before the run has a pull request) shows what was asked and what the factory made, as GitHub has them now. **The ask** is the issue: its title, who wrote it, its labels and its text. **What it made** is the run's pull request: its state, its review decision, the lines added and removed, the files that changed most, and its description. Long text is folded; **Show all** opens it. The page reads GitHub once, when this part first opens, through the factory's own `gh`, and writes nothing. When that `gh` is not signed in on the run's machine, one line says so, with links to the issue and pull request on GitHub.

**Ledger** is every event the factory recorded for the run, with their count on the bar.

### Moving between runs

A run opened from the runs table or from the Stuck or Needs info bin keeps that list: its header shows where the run sits (`3 of 17`), and the arrows beside it open the previous or next run. Back returns to the list with the same filters and search, on the run you left.

From a keyboard, `j` and `k` step through the runs table and `Enter` opens one. On a run's page `j` and `k` move to the next and previous run and `Esc` goes back. `/` jumps to the search box. `b`, `a`, `n`, `s` and `r` jump to the belt, Needs attention, Needs info, Stuck and the runs table, and the first Tab on the page offers the same jumps. `?` lists every key.

A run in `factory:building` can be stopped from its page. See [Stopping a run by hand](/guide/when-a-run-stops#stopping-a-run-by-hand).

## Needs attention

<img class="screenshot light-only" src="/screenshots/needs-attention-light.jpg" alt="The bins under the belt: Needs attention with a stuck item and a needs-info item, each with View run and Dismiss; the Needs info bin with each run's questions; and the Stuck bin with its 8 runs folded under two causes, The run passed its time limit with 5 and The gate failed after 3 attempts with 3" />
<img class="screenshot dark-only" src="/screenshots/needs-attention-dark.jpg" alt="The bins under the belt: Needs attention with a stuck item and a needs-info item, each with View run and Dismiss; the Needs info bin with each run's questions; and the Stuck bin with its 8 runs folded under two causes, The run passed its time limit with 5 and The gate failed after 3 attempts with 3" />

Under the belt, the Factory page lists what needs a person in three bins: Needs attention, Needs info and Stuck. Needs info lists each run's issue with the questions it asked. Stuck sorts its runs by why they stopped: each cause, such as "The run passed its time limit", is a fold with its count and issue numbers, the biggest first, and opening it shows each run with its repo, age and the rest of its reason. The sidebar's Factory item shows how many items need attention, and a dot while runs are in flight or claims are held. Hover it for the runs in flight, each a link to its run, without leaving your thread. An item is raised when:

- a run went to `factory:stuck` or `factory:needs-info`,
- a run is holding a slot but nothing will move it, for example its label was changed by hand,
- the machine config failed to load,
- free disk space is below `min_free_gib`, so nothing is claimed or gated until there is room,
- a build autodeploy has waiting has waited longer than `deploy_wait_minutes`, while the factory claims nothing; it clears once the build is installed, which the belt's update banner can start at once,
- three passes in a row failed,
- a stopped session's worktree was deleted or is no longer a git checkout, so the factory archived the threads still on it.

An item for a stuck or held run links to it, and one for a config problem links to Settings → Factory; the archived-worktree item names its run in the message. When the factory's `gh` is signed out, every repo it watches and the pass all fail for that one reason, so they show as a single **GitHub sign-in** item: its **Sign in** opens Settings → Factory, whose first-run steps give the `gh auth login` command for the factory's GitHub config directory, and its Quiet hides them all from the count. It counts as one everywhere: the sidebar badge, the notification, the Machine dial's holds and the Queue tell the same sign-in. Each new item also posts a macOS notification, as does a run abandoned because its issue was closed, on the server's Mac, unless `notify` is `false` in the [machine config](/guide/machine-config).

The app you watch from tells you too, on any machine, following Settings → Notifications: while T3 Code has focus, a toast names the new item with a button to its run (none on a Factory page, which already shows it); while it doesn't, a system notification does the same. Several new items at once arrive as one notice with their count. The app hears of an item at its next status read, every half minute while you're using it.

An item clears itself when its cause goes away: the config loads, a pass succeeds, the issue is claimed again, the disk has room again. An archived-worktree item stays until its issue is claimed again, so dismiss it once you've looked. An item about a run has **Dismiss**: you've seen it. An item about a condition that is still true (a config, a sign-in, low disk, a rate limit) has **Quiet** instead: it leaves the count, the sidebar badge and the notifications, but whatever it holds still shows on the Machine dial, the Claimed post and the Queue until it clears. Both go to **Dismissed** at the foot of Needs attention, which says how many are still true; **Bring back** returns one to the list. A dismissed item leaves for good once its cause clears.

## Settings → Factory

<img class="screenshot light-only" src="/screenshots/settings-factory-light.jpg" alt="Settings, Factory: the Machine config card with the GitHub config directory, poll seconds, the run and gate limits and feedback seconds, each number with its unit, the hand-edited keys as chips, and Save in the card's foot beside the file it writes" />
<img class="screenshot dark-only" src="/screenshots/settings-factory-dark.jpg" alt="Settings, Factory: the Machine config card with the GitHub config directory, poll seconds, the run and gate limits and feedback seconds, each number with its unit, the hand-edited keys as chips, and Save in the card's foot beside the file it writes" />

Use it to change the [machine config](/guide/machine-config) and to check which repos are watched. Until the factory has a watched repo it can build from, the page opens on the same first-run steps as the Factory page.

The Machine config card edits the GitHub config directory, the poll interval, the run and gate limits, the disk floor and load limit claims wait on, and how often to read pull request feedback. Each limit has a bar of what the machine is doing now against the value you type, so you see whether a value would hold claims before you save it. The keys you edit by hand in the file are listed as chips under the form, and a save keeps them as written. **Save** is in the card's foot, beside the file it writes (`~/.config/t3fac/factory/config.yml`), and stays in view while you have unsaved changes. Saving needs a session that may change settings.

Below the form, Watched repos lists one line per repo with a coloured dot and its state (Error, Not read yet, Defaults or Ready), repos with errors first and the first error shown on the line. Open a line for its T3 project's folder and its `factory` block as the last pass read it (from GitHub, or from the checkout when GitHub has no copy), including any errors that stop the factory using it. Repos the factory couldn't settle on its last read are listed separately with the reason. [Add a repo](/guide/add-a-repo) explains what makes a repo watched.
