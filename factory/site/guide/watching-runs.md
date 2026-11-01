# Watch runs

The fork's web app has a Factory page, reached from the sidebar. It shows every connected environment that runs a factory, the primary environment first: a belt at the top with the runs of all of them, and below it one table of their runs. In the desktop app the primary is the LaunchAgent server once you have [paired it](/guide/install#install-the-desktop-app). Reading needs a normal paired session. Pausing claims, stopping a run and dismissing an item need the `orchestration:operate` scope, which a normal pairing carries.

The pages work in a phone's browser too, paired over your tailnet as described in [remote access](https://github.com/pingdotgg/t3code/tree/main/docs/user/remote-access.md). The T3 mobile app is upstream's build and has no Factory screen.

## The Factory page

<img class="screenshot light-only" src="/screenshots/factory-page-light.png" alt="The Factory page: the belt with one run each at Claimed, Building, Gate and PR open and none done today, the Building post open on its run and its issue title, then the Needs attention, Needs info and Stuck bins, and the runs table with every run's state, step, age and pull request" />
<img class="screenshot dark-only" src="/screenshots/factory-page-dark.png" alt="The Factory page: the belt with one run each at Claimed, Building, Gate and PR open and none done today, the Building post open on its run and its issue title, then the Needs attention, Needs info and Stuck bins, and the runs table with every run's state, step, age and pull request" />

Use it to see what the factory is doing now. The belt at the top has five posts, one per station a run passes: Claimed, Building, Gate, PR open and Done. Each unfinished run is a tile under its post, showing its issue number and how long it has been there; click a tile to open the run. Click a post to open a table of its runs under the rail, with each run's title, step and pull request and a Stop button. Done counts the runs whose pull request was merged or closed today. The belt reads status every 5 seconds while the page is open.

Under the belt, the runs table lists every unfinished run and the runs that finished in the last week, newest first under a heading for each day, with each run's title, repo, issue, state, current step, age and pull request. A run that ended because its pull request was merged or closed shows `merged` or `closed` as its state. The chips above it (Active, Needs a person, Merged, Closed) narrow the list to one state and count the runs in each; the chip is in the URL. Type in the search box to keep the runs whose title, repo or run id holds every word, or `#20` for one issue or pull request. Show all runs to read the full history. It refreshes every 30 seconds. With several environments or repos, narrow the page to one with the Environment and Repo selects in its header; the choice is in the URL, so a reload or a shared link keeps it.

With several environments, pick one in the belt's Environment control. Its tiles are solid and the others' are hollow, and the control bar above the rail acts on it: its claims switch, the countdown to its next pass, and its slots. The counters beside them (runs today, merged today, stuck) cover every environment. The Environment control also says when a factory is idle and why (no machine config, or one that failed to load), with a link to Settings → Factory.

Turn the claims switch off to pause claims in the picked environment. While claims are paused the factory takes no new `factory:ready` issues in any repo. Runs already under way carry on: sessions, gates and feedback all continue. Turn the switch back on to start claiming again.

Claims also stop while autodeploy has a new build waiting to install. The belt then shows an **Update waiting** banner naming the build and when it installs at the latest, and the Claimed post says `claims held for update`. **Snooze 1 hour** lets claims go on for an hour and holds the install; **Update now** installs it at once, over the runs in progress. Snoozing needs the `orchestration:operate` scope and Update now the `environment:maintain` scope. See [Follow main](/guide/install#follow-main).

## A run's page

<img class="screenshot light-only" src="/screenshots/run-page-light.png" alt="A pr-open run's page: its state and step, the links to its thread, issue and pull request, the last gate's commands with exit code 0, and the ledger, where gate attempt 1 failed and was sent back before attempt 2 passed" />
<img class="screenshot dark-only" src="/screenshots/run-page-dark.png" alt="A pr-open run's page: its state and step, the links to its thread, issue and pull request, the last gate's commands with exit code 0, and the ledger, where gate attempt 1 failed and was sent back before attempt 2 passed" />

Open a run from the list to see why it is where it is. The page shows the run's state and step, and links to its issue, its pull request and its T3 thread, where you can read the session. A stuck run's page gives the reason it stopped, and a needs-info run's page the questions it posted on the issue. Below that is the run's timeline: what happened, in plain words, timed from the claim. Each gate run is one step with its commands, each agent session links to its own thread, and the summary above it says how long the run took and how many gate runs failed. Then comes the last gate: each command with its exit code and duration, and the failure output the factory sent back to the session. Last is the raw ledger, every event the factory recorded for the run, closed until you open it.

A run in `factory:building` can be stopped from here. See [Stopping a run by hand](/guide/when-a-run-stops#stopping-a-run-by-hand).

## Needs attention

<img class="screenshot light-only" src="/screenshots/needs-attention-light.png" alt="The bins under the belt: Needs attention with a stuck item and a needs-info item, each with View run and Dismiss, beside the Needs info bin with the run's questions and the Stuck bin with the reason it stopped" />
<img class="screenshot dark-only" src="/screenshots/needs-attention-dark.png" alt="The bins under the belt: Needs attention with a stuck item and a needs-info item, each with View run and Dismiss, beside the Needs info bin with the run's questions and the Stuck bin with the reason it stopped" />

Under the belt, the Factory page lists what needs a person in three bins: Needs attention, Needs info and Stuck. Needs info and Stuck list each run's issue with the questions it asked or the reason it stopped. The sidebar's Factory item shows how many items need attention. An item is raised when:

- a run went to `factory:stuck` or `factory:needs-info`,
- a run is holding a slot but nothing will move it, for example its label was changed by hand,
- the machine config failed to load,
- free disk space is below `min_free_gib`, so nothing is claimed or gated until there is room,
- a build autodeploy has waiting has waited longer than `deploy_wait_minutes`, while the factory claims nothing; it clears once the build is installed, which the belt's update banner can start at once,
- three passes in a row failed,
- a stopped session's worktree was deleted or is no longer a git checkout, so the factory archived the threads still on it.

An item for a stuck or held run links to it, and one for a config problem links to Settings → Factory; the archived-worktree item names its run in the message. Each new item also posts a macOS notification, as does a run abandoned because its issue was closed, on the server's Mac, unless `notify` is `false` in the [machine config](/guide/machine-config).

An item clears itself when its cause goes away: the config loads, a pass succeeds, the issue is claimed again, the disk has room again. An archived-worktree item stays until its issue is claimed again, so dismiss it once you've looked. Dismiss an item to hide it once you've dealt with it. A dismissed item stays hidden until its cause clears and comes back.

## Settings → Factory

<img class="screenshot light-only" src="/screenshots/settings-factory-light.png" alt="Settings, Factory: the machine config form with the GitHub config directory, poll seconds and the run and gate limits, then Watched repos, empty because no T3 project here has a factory block" />
<img class="screenshot dark-only" src="/screenshots/settings-factory-dark.png" alt="Settings, Factory: the machine config form with the GitHub config directory, poll seconds and the run and gate limits, then Watched repos, empty because no T3 project here has a factory block" />

Use it to change the [machine config](/guide/machine-config) and to check which repos are watched. The form edits the GitHub config directory, the poll interval and the run and gate limits, and saves to `~/.config/t3fac/factory/config.yml`. Saving needs a session that may change settings.

Below the form, each watched repo is shown with its T3 project's folder and its `factory` block as the last pass read it (from GitHub, or from the checkout when GitHub has no copy), including any errors that stop the factory using it. Repos the factory couldn't settle on its last read are listed separately with the reason. [Add a repo](/guide/add-a-repo) explains what makes a repo watched.
