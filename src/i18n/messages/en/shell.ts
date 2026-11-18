import type { shell as ru } from "../ru/shell";

export const shell: typeof ru = {
  titlebar: { settings: "Settings", closeSettings: "Close settings", minimize: "Minimize", maximize: "Maximize", restore: "Restore", close: "Close" },
  nav: { repos: "Repositories", run: "Analysis", features: "Features", review: "Review" },
  noRepo: "Select a repository",
  noRepoHint: "Add a service repository on the Repositories tab to run an analysis.",
};
