// Baut das Release-Paket release-app/Animora-<version>-win-x64.zip:
// Oberfläche + Server + Module + das offizielle node.exe. node.exe ist von der
// OpenJS Foundation signiert, deshalb startet das Paket auch mit aktivem
// Windows Smart App Control. Aufruf: npm run dist:web
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
const OUT = path.join(ROOT, "release-app");
const STAGE = path.join(OUT, "Animora");
const ZIP = path.join(OUT, `Animora-${version}-win-x64.zip`);
const NODE_VERSION = process.version; // Node-Version des Build-Rechners
const NODE_DIST = `https://nodejs.org/dist/${NODE_VERSION}`;

const sha256 = (buffer) => crypto.createHash("sha256").update(buffer).digest("hex");

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Offizielles win-x64 node.exe: das installierte nehmen, wenn es Byte für Byte
// dem offiziellen Build entspricht, sonst herunterladen. Beides wird gegen
// SHASUMS256.txt von nodejs.org geprüft.
async function officialNodeExe() {
  const sums = (await download(`${NODE_DIST}/SHASUMS256.txt`)).toString("utf8");
  const line = sums.split("\n").find((l) => l.trim().endsWith(" win-x64/node.exe"));
  if (!line) throw new Error(`Keine Prüfsumme für win-x64/node.exe in ${NODE_VERSION}`);
  const expected = line.trim().split(/\s+/)[0];

  if (process.platform === "win32" && process.arch === "x64") {
    const local = fs.readFileSync(process.execPath);
    if (sha256(local) === expected) {
      console.log(`node.exe ${NODE_VERSION}: lokale Installation (offizieller Build)`);
      return local;
    }
  }
  console.log(`node.exe ${NODE_VERSION}: lade offiziellen Build …`);
  const exe = await download(`${NODE_DIST}/win-x64/node.exe`);
  if (sha256(exe) !== expected) throw new Error("Prüfsumme von node.exe stimmt nicht – Abbruch.");
  return exe;
}

async function nodeLicense() {
  const local = path.join(path.dirname(process.execPath), "LICENSE");
  if (fs.existsSync(local)) return fs.readFileSync(local);
  return download(`https://raw.githubusercontent.com/nodejs/node/${NODE_VERSION}/LICENSE`);
}

async function main() {
  fs.rmSync(STAGE, { recursive: true, force: true });
  fs.rmSync(ZIP, { force: true });
  fs.mkdirSync(path.join(STAGE, "runtime"), { recursive: true });

  for (const item of ["app", "src", "modules", "web", "package.json", "Animora.cmd", "README.md", "LICENSE", "THIRD_PARTY_NOTICES.md"]) {
    fs.cpSync(path.join(ROOT, item), path.join(STAGE, item), { recursive: true });
  }
  // Nur für die Electron-Variante nötig.
  for (const file of ["app/main.cjs", "app/preload.cjs", "app/lib/player.cjs"]) {
    fs.rmSync(path.join(STAGE, file), { force: true });
  }

  fs.writeFileSync(path.join(STAGE, "runtime", "node.exe"), await officialNodeExe());
  fs.writeFileSync(path.join(STAGE, "runtime", "LICENSE"), await nodeLicense());

  // Windows-eigenes tar (bsdtar) erzeugt ZIP-Dateien; Git-Bash-tar kann das nicht.
  const tar = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe");
  execFileSync(tar, ["-a", "-c", "-f", ZIP, "-C", OUT, "Animora"], { stdio: "inherit" });
  fs.rmSync(STAGE, { recursive: true, force: true });

  const size = (fs.statSync(ZIP).size / 1024 / 1024).toFixed(1);
  console.log(`Fertig: ${path.relative(ROOT, ZIP)} (${size} MB)`);
}

main().catch((error) => {
  console.error(`Build fehlgeschlagen: ${error.message}`);
  process.exitCode = 1;
});
