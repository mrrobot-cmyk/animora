// Animora.exe – Starter als Einzeldatei.
// Am Ende dieser EXE hängt ein ZIP mit der App (Oberfläche, Server, Module,
// node.exe). Beim ersten Start wird es nach %LOCALAPPDATA%\Animora\app-<ver>
// entpackt, danach startet der Server ohne Konsolenfenster und öffnet das
// App-Fenster. Spätere Starts gehen direkt los.

#ifndef UNICODE
#define UNICODE
#endif
#define _UNICODE
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <stdio.h>
#include <string.h>
#include "miniz.h"

#ifndef ANIMORA_VERSION
#define ANIMORA_VERSION "0.0.0"
#endif
#define WIDEN2(x) L##x
#define WIDEN(x) WIDEN2(x)
#define MAGIC "ANIMORA\x01"

static wchar_t g_self[MAX_PATH * 4];
static wchar_t g_base[MAX_PATH * 4];   // ...\Animora
static wchar_t g_app[MAX_PATH * 4];    // ...\Animora\app-<ver>
static wchar_t g_tmp[MAX_PATH * 4];    // ...\Animora\app-<ver>.tmp
static volatile LONG g_done = 0;
static volatile LONG g_ok = 0;
static wchar_t g_err[512];
static HWND g_splash;

static void fail(const wchar_t *msg) {
  MessageBoxW(NULL, msg, L"Animora", MB_ICONERROR | MB_OK);
}

static int exists(const wchar_t *p) { return GetFileAttributesW(p) != INVALID_FILE_ATTRIBUTES; }

static char *to_utf8(const wchar_t *w) {
  int n = WideCharToMultiByte(CP_UTF8, 0, w, -1, NULL, 0, NULL, NULL);
  char *s = (char *)malloc(n);
  WideCharToMultiByte(CP_UTF8, 0, w, -1, s, n, NULL, NULL);
  return s;
}

static wchar_t *to_wide(const char *s) {
  int n = MultiByteToWideChar(CP_UTF8, 0, s, -1, NULL, 0);
  wchar_t *w = (wchar_t *)malloc(n * sizeof(wchar_t));
  MultiByteToWideChar(CP_UTF8, 0, s, -1, w, n);
  return w;
}

// Legt alle Ordner eines Pfads an (Pfad endet mit Dateiname oder '\').
static void mkdirs_for(wchar_t *path) {
  for (wchar_t *p = path + 3; *p; p++) {
    if (*p == L'\\' || *p == L'/') {
      wchar_t c = *p; *p = 0;
      CreateDirectoryW(path, NULL);
      *p = c;
    }
  }
}

static void rmtree(const wchar_t *dir) {
  // SHFileOperation braucht doppelt nullterminierte Pfade.
  size_t n = wcslen(dir);
  wchar_t *buf = (wchar_t *)calloc(n + 2, sizeof(wchar_t));
  wcscpy(buf, dir);
  SHFILEOPSTRUCTW op = {0};
  op.wFunc = FO_DELETE; op.pFrom = buf;
  op.fFlags = FOF_NO_UI;
  SHFileOperationW(&op);
  free(buf);
}

// Liest den Anhang-Trailer: [zip ...][u64 offset][8 Byte MAGIC]
static int find_payload(unsigned long long *ofs, unsigned long long *size) {
  HANDLE h = CreateFileW(g_self, GENERIC_READ, FILE_SHARE_READ, NULL, OPEN_EXISTING, 0, NULL);
  if (h == INVALID_HANDLE_VALUE) return 0;
  LARGE_INTEGER total; GetFileSizeEx(h, &total);
  unsigned char tail[16]; DWORD got = 0;
  LARGE_INTEGER pos; pos.QuadPart = total.QuadPart - 16;
  SetFilePointerEx(h, pos, NULL, FILE_BEGIN);
  ReadFile(h, tail, 16, &got, NULL);
  CloseHandle(h);
  if (got != 16 || memcmp(tail + 8, MAGIC, 8) != 0) return 0;
  memcpy(ofs, tail, 8);
  *size = (unsigned long long)total.QuadPart - 16 - *ofs;
  return 1;
}

static DWORD WINAPI extract_thread(LPVOID arg) {
  (void)arg;
  unsigned long long ofs, size;
  if (!find_payload(&ofs, &size)) { wcscpy(g_err, L"Die App-Daten in Animora.exe fehlen oder sind beschädigt."); goto out; }
  if (exists(g_tmp)) rmtree(g_tmp);
  CreateDirectoryW(g_tmp, NULL);

  mz_zip_archive zip; memset(&zip, 0, sizeof zip);
  char *self8 = to_utf8(g_self);
  if (!mz_zip_reader_init_file_v2(&zip, self8, 0, ofs, size)) {
    free(self8); wcscpy(g_err, L"Die App-Daten konnten nicht gelesen werden."); goto out;
  }
  free(self8);
  mz_uint count = mz_zip_reader_get_num_files(&zip);
  for (mz_uint i = 0; i < count; i++) {
    mz_zip_archive_file_stat st;
    if (!mz_zip_reader_file_stat(&zip, i, &st)) continue;
    if (strstr(st.m_filename, "..")) continue;
    wchar_t *rel = to_wide(st.m_filename);
    wchar_t full[MAX_PATH * 4];
    _snwprintf(full, MAX_PATH * 4, L"%s\\%s", g_tmp, rel);
    free(rel);
    for (wchar_t *p = full; *p; p++) if (*p == L'/') *p = L'\\';
    if (mz_zip_reader_is_file_a_directory(&zip, i)) {
      wcscat(full, L"\\"); mkdirs_for(full); continue;
    }
    mkdirs_for(full);
    char *full8 = to_utf8(full);
    int ok = mz_zip_reader_extract_to_file(&zip, i, full8, 0);
    free(full8);
    if (!ok) {
      mz_zip_reader_end(&zip);
      _snwprintf(g_err, 512, L"Entpacken fehlgeschlagen (Datei %u). Ist genug Speicherplatz frei?", i);
      goto out;
    }
  }
  mz_zip_reader_end(&zip);
  if (exists(g_app)) rmtree(g_app);
  if (!MoveFileW(g_tmp, g_app)) { wcscpy(g_err, L"Der App-Ordner konnte nicht angelegt werden."); goto out; }
  wchar_t marker[MAX_PATH * 4];
  _snwprintf(marker, MAX_PATH * 4, L"%s\\.installed", g_app);
  HANDLE m = CreateFileW(marker, GENERIC_WRITE, 0, NULL, CREATE_ALWAYS, FILE_ATTRIBUTE_HIDDEN, NULL);
  if (m != INVALID_HANDLE_VALUE) CloseHandle(m);
  InterlockedExchange(&g_ok, 1);
out:
  InterlockedExchange(&g_done, 1);
  if (g_splash) PostMessageW(g_splash, WM_CLOSE, 0, 0);
  return 0;
}

static LRESULT CALLBACK splash_proc(HWND h, UINT msg, WPARAM w, LPARAM l) {
  switch (msg) {
    case WM_PAINT: {
      PAINTSTRUCT ps; HDC dc = BeginPaint(h, &ps);
      RECT r; GetClientRect(h, &r);
      HBRUSH bg = CreateSolidBrush(RGB(16, 14, 24)); FillRect(dc, &r, bg); DeleteObject(bg);
      HICON icon = (HICON)LoadImageW(GetModuleHandleW(NULL), MAKEINTRESOURCEW(1), IMAGE_ICON, 64, 64, 0);
      if (icon) DrawIconEx(dc, 24, (r.bottom - 64) / 2, icon, 64, 64, 0, NULL, DI_NORMAL);
      SetBkMode(dc, TRANSPARENT);
      HFONT big = CreateFontW(-22, 0, 0, 0, FW_BOLD, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
      HFONT small = CreateFontW(-14, 0, 0, 0, FW_NORMAL, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
      SetTextColor(dc, RGB(245, 240, 250));
      SelectObject(dc, big); RECT t1 = {104, r.bottom / 2 - 28, r.right - 16, r.bottom / 2};
      DrawTextW(dc, L"Animora", -1, &t1, DT_LEFT | DT_SINGLELINE | DT_BOTTOM);
      SetTextColor(dc, RGB(190, 180, 205));
      SelectObject(dc, small); RECT t2 = {104, r.bottom / 2 + 4, r.right - 16, r.bottom / 2 + 30};
      DrawTextW(dc, L"Wird eingerichtet \x2026 (nur beim ersten Start)", -1, &t2, DT_LEFT | DT_SINGLELINE | DT_TOP);
      DeleteObject(big); DeleteObject(small);
      EndPaint(h, &ps);
      return 0;
    }
    case WM_CLOSE: DestroyWindow(h); return 0;
    case WM_DESTROY: PostQuitMessage(0); return 0;
  }
  return DefWindowProcW(h, msg, w, l);
}

static void extract_with_splash(HINSTANCE inst) {
  WNDCLASSW wc = {0};
  wc.lpfnWndProc = splash_proc; wc.hInstance = inst; wc.lpszClassName = L"AnimoraSplash";
  wc.hCursor = LoadCursor(NULL, IDC_WAIT); wc.hIcon = LoadIconW(inst, MAKEINTRESOURCEW(1));
  RegisterClassW(&wc);
  int w = 420, h = 130;
  int x = (GetSystemMetrics(SM_CXSCREEN) - w) / 2, y = (GetSystemMetrics(SM_CYSCREEN) - h) / 2;
  g_splash = CreateWindowExW(WS_EX_TOPMOST | WS_EX_TOOLWINDOW, wc.lpszClassName, L"Animora", WS_POPUP | WS_VISIBLE | WS_BORDER,
                             x, y, w, h, NULL, NULL, inst, NULL);
  HANDLE t = CreateThread(NULL, 0, extract_thread, NULL, 0, NULL);
  MSG msg;
  if (g_splash) {
    // Nachrichten verarbeiten, bis das Entpacken fertig ist (Thread schließt das Fenster).
    while (!g_done && GetMessageW(&msg, NULL, 0, 0) > 0) { TranslateMessage(&msg); DispatchMessageW(&msg); }
  }
  WaitForSingleObject(t, INFINITE);
  CloseHandle(t);
  if (IsWindow(g_splash)) DestroyWindow(g_splash);
}

// Alte, nicht mehr benötigte Versionsordner aufräumen.
static void cleanup_old(void) {
  wchar_t pattern[MAX_PATH * 4];
  _snwprintf(pattern, MAX_PATH * 4, L"%s\\app-*", g_base);
  WIN32_FIND_DATAW fd; HANDLE f = FindFirstFileW(pattern, &fd);
  if (f == INVALID_HANDLE_VALUE) return;
  do {
    if (!(fd.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY)) continue;
    if (_wcsicmp(fd.cFileName, L"app-" WIDEN(ANIMORA_VERSION)) == 0) continue;
    wchar_t full[MAX_PATH * 4];
    _snwprintf(full, MAX_PATH * 4, L"%s\\%s", g_base, fd.cFileName);
    rmtree(full);
  } while (FindNextFileW(f, &fd));
  FindClose(f);
}

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE prev, PWSTR cmd, int show) {
  (void)prev; (void)show;
  SetProcessDPIAware();
  GetModuleFileNameW(NULL, g_self, MAX_PATH * 4);

  wchar_t *local = NULL;
  if (FAILED(SHGetKnownFolderPath(&FOLDERID_LocalAppData, 0, NULL, &local))) { fail(L"LocalAppData nicht gefunden."); return 1; }
  _snwprintf(g_base, MAX_PATH * 4, L"%s\\Animora", local);
  CoTaskMemFree(local);
  _snwprintf(g_app, MAX_PATH * 4, L"%s\\app-%s", g_base, WIDEN(ANIMORA_VERSION));
  _snwprintf(g_tmp, MAX_PATH * 4, L"%s.tmp", g_app);
  CreateDirectoryW(g_base, NULL);

  int reinstall = cmd && wcsstr(cmd, L"--reinstall") != NULL;
  wchar_t marker[MAX_PATH * 4], node[MAX_PATH * 4], server[MAX_PATH * 4];
  _snwprintf(marker, MAX_PATH * 4, L"%s\\.installed", g_app);
  _snwprintf(node, MAX_PATH * 4, L"%s\\runtime\\node.exe", g_app);
  _snwprintf(server, MAX_PATH * 4, L"%s\\web\\server.mjs", g_app);

  if (reinstall || !exists(marker) || !exists(node) || !exists(server)) {
    extract_with_splash(inst);
    if (!g_ok) { fail(g_err[0] ? g_err : L"Einrichtung fehlgeschlagen."); return 1; }
    cleanup_old();
  }

  wchar_t cmdline[MAX_PATH * 10];
  _snwprintf(cmdline, MAX_PATH * 10, L"\"%s\" \"%s\"", node, server);
  STARTUPINFOW si = {0}; si.cb = sizeof si;
  si.dwFlags = STARTF_USESHOWWINDOW; si.wShowWindow = SW_HIDE;
  PROCESS_INFORMATION pi = {0};
  // Pfad zur EXE mitgeben, falls der Server ihn braucht (z. B. für Verknüpfungen).
  SetEnvironmentVariableW(L"ANIMORA_LAUNCHER", g_self);
  if (!CreateProcessW(node, cmdline, NULL, NULL, FALSE, CREATE_NO_WINDOW, NULL, g_app, &si, &pi)) {
    wchar_t msg[600];
    _snwprintf(msg, 600, L"Animora konnte nicht gestartet werden (Fehler %lu).\n\nWird Animora von Windows (z. B. Smart App Control) blockiert?", GetLastError());
    fail(msg);
    return 1;
  }
  CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
  return 0;
}
