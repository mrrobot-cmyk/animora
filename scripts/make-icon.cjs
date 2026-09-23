// Renders app/assets/logo.svg to app/assets/icon.png (512×512), used as the
// window icon and converted by electron-builder into the .exe icon.
// Run with: npm run icon
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SIZE = 512;

app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const window = new BrowserWindow({
    width: SIZE,
    height: SIZE,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true },
  });
  await window.loadFile(path.join(ROOT, "app", "assets", "logo.svg"));
  await new Promise((resolve) => setTimeout(resolve, 600));
  let image = await window.webContents.capturePage();
  if (image.getSize().width !== SIZE) image = image.resize({ width: SIZE, height: SIZE, quality: "best" });
  const target = path.join(ROOT, "app", "assets", "icon.png");
  fs.writeFileSync(target, image.toPNG());
  console.log(`Icon geschrieben: ${target} (${image.getSize().width}×${image.getSize().height})`);
  app.quit();
});
