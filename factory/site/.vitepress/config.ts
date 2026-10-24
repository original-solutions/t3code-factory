import { defineConfig, type DefaultTheme } from "vitepress";
import { withMermaid } from "vitepress-plugin-mermaid";

import { writeLlmsFiles } from "./llms.ts";

const SITE_URL = "https://t3code-factory-docs.originalsolutions.com.au";
const REPO_URL = "https://github.com/original-solutions/t3code-factory";
const UPSTREAM_DOCS_URL = "https://github.com/pingdotgg/t3code/tree/main/docs/user";

const guide: DefaultTheme.SidebarItem[] = [
  { text: "What the factory is", link: "/guide/" },
  { text: "Install and run", link: "/guide/install" },
  { text: "Add a repo", link: "/guide/add-a-repo" },
  { text: "The machine config", link: "/guide/machine-config" },
  { text: "File work", link: "/guide/filing-work" },
  { text: "Watch runs", link: "/guide/watching-runs" },
  { text: "Design a pipeline", link: "/guide/pipelines" },
  { text: "When a run stops", link: "/guide/when-a-run-stops" },
];

const agents: DefaultTheme.SidebarItem[] = [
  { text: "Overview", link: "/agents/" },
  { text: "Issue contract", link: "/agents/issue-contract" },
  { text: "Repo config", link: "/agents/repo-config" },
  { text: "Machine config", link: "/agents/machine-config" },
  { text: "Runs and result line", link: "/agents/runs" },
  { text: "Scripts", link: "/agents/scripts" },
];

const config = defineConfig({
  title: "t3code factory",
  description:
    "A software factory inside a fork of T3 Code: GitHub issues in, draft pull requests out.",
  base: "/",
  cleanUrls: true,
  // The site's own maintainer notes, not a page.
  srcExclude: ["README.md"],
  themeConfig: {
    siteTitle: "t3code factory",
    nav: [
      { text: "Guide", link: "/guide/", activeMatch: "^/guide/" },
      { text: "For agents", link: "/agents/", activeMatch: "^/agents/" },
      { text: "T3 Code docs", link: UPSTREAM_DOCS_URL },
    ],
    sidebar: {
      "/guide/": [{ text: "Guide", items: guide }],
      "/agents/": [{ text: "For agents", items: agents }],
    },
    socialLinks: [{ icon: "github", link: REPO_URL }],
    search: { provider: "local" },
    outline: [2, 3],
  },
  async buildEnd(site) {
    await writeLlmsFiles({
      title: "t3code factory",
      siteUrl: SITE_URL,
      srcDir: site.srcDir,
      outDir: site.outDir,
      sections: [
        { title: "Guide", links: guide },
        { title: "For agents", links: agents },
      ],
    });
  },
});

// Renders ```mermaid blocks in the page markdown as diagrams.
export default withMermaid(config);
