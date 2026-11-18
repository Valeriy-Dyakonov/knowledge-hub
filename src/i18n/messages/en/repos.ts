import type { repos as ru } from "../ru/repos";

export const repos: typeof ru = {
  title: "Repositories",
  tip: "Service repositories analysed by the hub. The hub only reads them and never writes to them.",
  add: "Add repository…",
  pickTitle: "Service repository folder",
  empty: "No repositories yet.",
  select: "Open",
  selected: "Selected",
  serviceId: "Folder in the knowledge base",
  serviceIdTip: "Name of the service folder inside the knowledge base. Better not to change it after the first analysis.",
  name: "Name",
  commit: (c, b) => `commit ${c.slice(0, 7)}${b ? ` · ${b}` : ""}`,
  duplicate: "This repository is already added",
};
