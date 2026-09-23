# mpv

Dieser Ordner muss die Windows-Version von mpv enthalten (`mpv.exe`, `mpv.com`,
`d3dcompiler_43.dll` …). Die Dateien sind nicht im Repository, weil `mpv.exe`
größer als die 100-MB-Grenze von GitHub ist.

1. mpv für Windows herunterladen: <https://mpv.io/installation/> (Windows-Builds;
   getestet mit mpv v0.41, x86_64).
2. Den Inhalt des Archivs in diesen Ordner entpacken, sodass `mpv/mpv.exe` existiert.

Die Entwicklungs-App (`npm start`) und der Build (`npm run dist`) verwenden diesen
Ordner; der Build packt ihn als `resources\mpv` in die App.

Die fertige `Animora.exe` aus den GitHub-Releases enthält mpv bereits.
