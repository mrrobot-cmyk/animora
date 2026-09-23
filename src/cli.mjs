import path from "node:path";
import { fileURLToPath } from "node:url";
import { readdir } from "node:fs/promises";
import { loadModule } from "./runtime.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MODULES = path.join(ROOT, "modules");

async function resolveModule(name) {
  const dirs = await readdir(MODULES, { withFileTypes: true });
  const needle = name.toLowerCase();
  const dir = dirs.find(d => d.isDirectory() && d.name.toLowerCase().startsWith(needle));
  if (!dir) throw new Error(`Module not found: ${name}`);
  return path.join(MODULES, dir.name);
}

async function main() {
  const [, , command, moduleName, ...args] = process.argv;

  if (!command || command === "help") {
    console.log(`
Usage:
  node src/cli.mjs list
  node src/cli.mjs search <module> <query>
  node src/cli.mjs details <module> <id-or-url>
  node src/cli.mjs episodes <module> <id-or-url>
  node src/cli.mjs stream <module> <episode-id-or-url> [language]
  node src/cli.mjs discovery <module> [feedId] [page]
`);
    return;
  }

  if (command === "list") {
    const dirs = await readdir(MODULES, { withFileTypes: true });
    for (const d of dirs.filter(x => x.isDirectory())) {
      try {
        const { manifest } = await loadModule(path.join(MODULES, d.name));
        console.log(`${manifest.name} ${manifest.moduleVersion} [contract ${manifest.contractVersion}]`);
      } catch (e) {
        console.log(`${d.name} [load error: ${e.message}]`);
      }
    }
    return;
  }

  const moduleDir = await resolveModule(moduleName);
  const { manifest, exported, runtime } = await loadModule(moduleDir);

  const dump = value => console.log(JSON.stringify(value, null, 2));

  switch (command) {
    case "search":
      if (typeof exported.searchResults !== "function") throw new Error("Module has no searchResults()");
      dump(await exported.searchResults(args.join(" ")));
      break;

    case "details":
      if (typeof exported.extractDetails !== "function") throw new Error("Module has no extractDetails()");
      dump(await exported.extractDetails(args[0]));
      break;

    case "episodes":
      if (typeof exported.extractEpisodes !== "function") throw new Error("Module has no extractEpisodes()");
      dump(await exported.extractEpisodes(args[0]));
      break;

    case "stream":
      if (typeof exported.extractStreamUrl !== "function") throw new Error("Module has no extractStreamUrl()");
      dump(await exported.extractStreamUrl(args[0], args[1] || "sub"));
      break;

    case "discovery": {
      if (typeof exported.discoveryHome === "function" && !args[0]) {
        dump(await exported.discoveryHome());
      } else if (typeof exported.discoveryFeed === "function") {
        dump(await exported.discoveryFeed(args[0], Number(args[1] || 1)));
      } else {
        throw new Error("Module has no discovery API");
      }
      break;
    }

    default:
      throw new Error(`Unknown command: ${command}`);
  }

  console.error(`\nLoaded: ${manifest.name} ${manifest.moduleVersion}`);
  // Machine-readable request statistics for the desktop app (stderr only).
  console.error(`HOSTSTATS ${JSON.stringify(runtime.stats)}`);
}

main().catch(err => {
  console.error(`ERROR: ${err.stack || err}`);
  process.exitCode = 1;
});
