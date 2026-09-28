// Animora.exe – eigenständige App als Einzeldatei.
// Am Ende dieser EXE hängt ein ZIP mit der App (Oberfläche, Server, Module,
// node.exe, WebView2Loader.dll). Beim ersten Start wird es nach
// %LOCALAPPDATA%\Animora\app-<ver> entpackt. Danach startet der lokale Server
// unsichtbar und die Oberfläche erscheint in einem eigenen Fenster (WebView2).
// Ohne WebView2-Runtime: Rückfall auf das Browser-App-Fenster.

#ifndef UNICODE
#define UNICODE
#endif
#define _UNICODE
#include <windows.h>
#include <shellapi.h>
#include <shlobj.h>
#include <stdio.h>
#include <string.h>
#include <dwmapi.h>
#define COBJMACROS
#include "WebView2.h"
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
    const wchar_t *mine = wcsrchr(g_app, L'\\');
    if (mine && _wcsicmp(fd.cFileName, mine + 1) == 0) continue;
    wchar_t full[MAX_PATH * 4];
    _snwprintf(full, MAX_PATH * 4, L"%s\\%s", g_base, fd.cFileName);
    rmtree(full);
  } while (FindNextFileW(f, &fd));
  FindClose(f);
}

// ======================================================================
// WebView2-Fenster
// ======================================================================

#define WM_APP_URL   (WM_APP + 1)
#define WM_APP_FAIL  (WM_APP + 2)
#define WINDOW_CLASS L"AnimoraWindow"

static const IID IID_Controller2 = {0xc979903e, 0xd4ca, 0x4228, {0x92, 0xeb, 0x47, 0xee, 0x3f, 0xa9, 0x6e, 0xab}};

typedef HRESULT (STDAPICALLTYPE *PFN_CreateEnv)(PCWSTR, PCWSTR, ICoreWebView2EnvironmentOptions *, ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler *);
typedef HRESULT (STDAPICALLTYPE *PFN_GetVersion)(PCWSTR, LPWSTR *);

static HWND g_hwnd;
static ICoreWebView2Controller *g_controller;
static ICoreWebView2 *g_webview;
static wchar_t *g_url;           // Server-Adresse, sobald bekannt
static HANDLE g_server;          // Serverprozess
static HANDLE g_job;             // beendet den Server mit dem Fenster
static int g_fullscreen;
static WINDOWPLACEMENT g_placement = { sizeof(WINDOWPLACEMENT) };
static LONG_PTR g_style;

static void navigate_if_ready(void) {
  if (g_webview && g_url) ICoreWebView2_Navigate(g_webview, g_url);
}

static void resize_webview(void) {
  if (!g_controller) return;
  RECT r; GetClientRect(g_hwnd, &r);
  ICoreWebView2Controller_put_Bounds(g_controller, r);
}

static void set_fullscreen(int on) {
  if (on == g_fullscreen) return;
  g_fullscreen = on;
  if (on) {
    GetWindowPlacement(g_hwnd, &g_placement);
    g_style = GetWindowLongPtrW(g_hwnd, GWL_STYLE);
    MONITORINFO mi = { sizeof mi };
    GetMonitorInfoW(MonitorFromWindow(g_hwnd, MONITOR_DEFAULTTONEAREST), &mi);
    SetWindowLongPtrW(g_hwnd, GWL_STYLE, (g_style & ~WS_OVERLAPPEDWINDOW) | WS_POPUP);
    SetWindowPos(g_hwnd, HWND_TOP, mi.rcMonitor.left, mi.rcMonitor.top,
                 mi.rcMonitor.right - mi.rcMonitor.left, mi.rcMonitor.bottom - mi.rcMonitor.top,
                 SWP_NOOWNERZORDER | SWP_FRAMECHANGED);
  } else {
    SetWindowLongPtrW(g_hwnd, GWL_STYLE, g_style);
    SetWindowPlacement(g_hwnd, &g_placement);
    SetWindowPos(g_hwnd, NULL, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_FRAMECHANGED);
  }
  resize_webview();
}

// --- minimale COM-Handler (statische Objekte, keine Referenzzählung nötig) ---
#define HANDLER_BASE(T)                                                                     \
  static HRESULT STDMETHODCALLTYPE T##_h_QI(T *This, REFIID riid, void **out) { (void)riid; *out = This; return S_OK; } \
  static ULONG STDMETHODCALLTYPE T##_h_AddRef(T *This) { (void)This; return 1; }                \
  static ULONG STDMETHODCALLTYPE T##_h_Release(T *This) { (void)This; return 1; }

HANDLER_BASE(ICoreWebView2ContainsFullScreenElementChangedEventHandler)
static HRESULT STDMETHODCALLTYPE fullscreen_invoke(ICoreWebView2ContainsFullScreenElementChangedEventHandler *This, ICoreWebView2 *sender, IUnknown *args) {
  (void)This; (void)args;
  BOOL full = FALSE;
  ICoreWebView2_get_ContainsFullScreenElement(sender, &full);
  set_fullscreen(full);
  return S_OK;
}
static ICoreWebView2ContainsFullScreenElementChangedEventHandlerVtbl fullscreen_vtbl = {
  ICoreWebView2ContainsFullScreenElementChangedEventHandler_h_QI, ICoreWebView2ContainsFullScreenElementChangedEventHandler_h_AddRef,
  ICoreWebView2ContainsFullScreenElementChangedEventHandler_h_Release, fullscreen_invoke };
static ICoreWebView2ContainsFullScreenElementChangedEventHandler fullscreen_handler = { &fullscreen_vtbl };

// Links nach außen (neue Fenster) im Standardbrowser öffnen.
HANDLER_BASE(ICoreWebView2NewWindowRequestedEventHandler)
static HRESULT STDMETHODCALLTYPE newwindow_invoke(ICoreWebView2NewWindowRequestedEventHandler *This, ICoreWebView2 *sender, ICoreWebView2NewWindowRequestedEventArgs *args) {
  (void)This; (void)sender;
  LPWSTR uri = NULL;
  ICoreWebView2NewWindowRequestedEventArgs_put_Handled(args, TRUE);
  if (SUCCEEDED(ICoreWebView2NewWindowRequestedEventArgs_get_Uri(args, &uri)) && uri) {
    if (!wcsncmp(uri, L"http://", 7) || !wcsncmp(uri, L"https://", 8))
      ShellExecuteW(NULL, L"open", uri, NULL, NULL, SW_SHOWNORMAL);
    CoTaskMemFree(uri);
  }
  return S_OK;
}
static ICoreWebView2NewWindowRequestedEventHandlerVtbl newwindow_vtbl = {
  ICoreWebView2NewWindowRequestedEventHandler_h_QI, ICoreWebView2NewWindowRequestedEventHandler_h_AddRef,
  ICoreWebView2NewWindowRequestedEventHandler_h_Release, newwindow_invoke };
static ICoreWebView2NewWindowRequestedEventHandler newwindow_handler = { &newwindow_vtbl };

// Esc und F11 abfangen, bevor WebView2 sie verschluckt:
// Esc schließt den Player (außer im Vollbild, dort beendet Esc das Vollbild),
// F11 schaltet das Fenster randlos.
HANDLER_BASE(ICoreWebView2AcceleratorKeyPressedEventHandler)
static HRESULT STDMETHODCALLTYPE accel_invoke(ICoreWebView2AcceleratorKeyPressedEventHandler *This, ICoreWebView2Controller *sender, ICoreWebView2AcceleratorKeyPressedEventArgs *args) {
  (void)This; (void)sender;
  COREWEBVIEW2_KEY_EVENT_KIND kind; UINT key = 0;
  ICoreWebView2AcceleratorKeyPressedEventArgs_get_KeyEventKind(args, &kind);
  ICoreWebView2AcceleratorKeyPressedEventArgs_get_VirtualKey(args, &key);
  if (kind != COREWEBVIEW2_KEY_EVENT_KIND_KEY_DOWN) return S_OK;
  if (key == VK_ESCAPE && g_webview && !g_fullscreen) {
    ICoreWebView2_ExecuteScript(g_webview,
      L"document.body.classList.contains('web-player-open') && !document.fullscreenElement && window.synthetiq && window.synthetiq.player.stop()", NULL);
  } else if (key == VK_F11) {
    ICoreWebView2AcceleratorKeyPressedEventArgs_put_Handled(args, TRUE);
    set_fullscreen(!g_fullscreen);
  }
  return S_OK;
}
static ICoreWebView2AcceleratorKeyPressedEventHandlerVtbl accel_vtbl = {
  ICoreWebView2AcceleratorKeyPressedEventHandler_h_QI, ICoreWebView2AcceleratorKeyPressedEventHandler_h_AddRef,
  ICoreWebView2AcceleratorKeyPressedEventHandler_h_Release, accel_invoke };
static ICoreWebView2AcceleratorKeyPressedEventHandler accel_handler = { &accel_vtbl };

HANDLER_BASE(ICoreWebView2CreateCoreWebView2ControllerCompletedHandler)
static HRESULT STDMETHODCALLTYPE controller_invoke(ICoreWebView2CreateCoreWebView2ControllerCompletedHandler *This, HRESULT hr, ICoreWebView2Controller *controller) {
  (void)This;
  if (FAILED(hr) || !controller) { PostMessageW(g_hwnd, WM_APP_FAIL, 0, (LPARAM)hr); return S_OK; }
  g_controller = controller;
  ICoreWebView2Controller_AddRef(controller);
  ICoreWebView2Controller_get_CoreWebView2(controller, &g_webview);

  ICoreWebView2Controller2 *c2 = NULL;
  if (SUCCEEDED(ICoreWebView2Controller_QueryInterface(controller, &IID_Controller2, (void **)&c2)) && c2) {
    COREWEBVIEW2_COLOR bg = { 255, 16, 14, 24 };
    ICoreWebView2Controller2_put_DefaultBackgroundColor(c2, bg);
    ICoreWebView2Controller2_Release(c2);
  }

  ICoreWebView2Settings *settings = NULL;
  if (SUCCEEDED(ICoreWebView2_get_Settings(g_webview, &settings)) && settings) {
    ICoreWebView2Settings_put_IsStatusBarEnabled(settings, FALSE);
    ICoreWebView2Settings_put_IsZoomControlEnabled(settings, TRUE);
    ICoreWebView2Settings_Release(settings);
  }

  EventRegistrationToken token;
  ICoreWebView2_add_ContainsFullScreenElementChanged(g_webview, &fullscreen_handler, &token);
  ICoreWebView2_add_NewWindowRequested(g_webview, &newwindow_handler, &token);
  ICoreWebView2Controller_add_AcceleratorKeyPressed(controller, &accel_handler, &token);

  resize_webview();
  ICoreWebView2Controller_put_IsVisible(controller, TRUE);
  navigate_if_ready();
  return S_OK;
}
static ICoreWebView2CreateCoreWebView2ControllerCompletedHandlerVtbl controller_vtbl = {
  ICoreWebView2CreateCoreWebView2ControllerCompletedHandler_h_QI, ICoreWebView2CreateCoreWebView2ControllerCompletedHandler_h_AddRef,
  ICoreWebView2CreateCoreWebView2ControllerCompletedHandler_h_Release, controller_invoke };
static ICoreWebView2CreateCoreWebView2ControllerCompletedHandler controller_handler = { &controller_vtbl };

HANDLER_BASE(ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler)
static HRESULT STDMETHODCALLTYPE env_invoke(ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler *This, HRESULT hr, ICoreWebView2Environment *env) {
  (void)This;
  if (FAILED(hr) || !env) { PostMessageW(g_hwnd, WM_APP_FAIL, 0, (LPARAM)hr); return S_OK; }
  ICoreWebView2Environment_CreateCoreWebView2Controller(env, g_hwnd, &controller_handler);
  return S_OK;
}
static ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandlerVtbl env_vtbl = {
  ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler_h_QI, ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler_h_AddRef,
  ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler_h_Release, env_invoke };
static ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler env_handler = { &env_vtbl };

static void paint_loading(HWND h) {
  PAINTSTRUCT ps; HDC dc = BeginPaint(h, &ps);
  RECT r; GetClientRect(h, &r);
  HBRUSH bg = CreateSolidBrush(RGB(16, 14, 24)); FillRect(dc, &r, bg); DeleteObject(bg);
  if (!g_controller) {
    SetBkMode(dc, TRANSPARENT); SetTextColor(dc, RGB(190, 180, 205));
    HFONT f = CreateFontW(-16, 0, 0, 0, FW_NORMAL, 0, 0, 0, DEFAULT_CHARSET, 0, 0, CLEARTYPE_QUALITY, 0, L"Segoe UI");
    HGDIOBJ old = SelectObject(dc, f);
    DrawTextW(dc, L"Animora wird gestartet \x2026", -1, &r, DT_CENTER | DT_VCENTER | DT_SINGLELINE);
    SelectObject(dc, old); DeleteObject(f);
  }
  EndPaint(h, &ps);
}

static LRESULT CALLBACK wnd_proc(HWND h, UINT msg, WPARAM w, LPARAM l) {
  switch (msg) {
    case WM_SIZE:
      if (g_controller) {
        ICoreWebView2Controller_put_IsVisible(g_controller, w != SIZE_MINIMIZED);
        resize_webview();
      }
      return 0;
    case WM_MOVE: case WM_MOVING:
      if (g_controller) ICoreWebView2Controller_NotifyParentWindowPositionChanged(g_controller);
      break;
    case WM_SETFOCUS:
      if (g_controller) ICoreWebView2Controller_MoveFocus(g_controller, COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
      return 0;
    case WM_ERASEBKGND: return 1;
    case WM_PAINT: paint_loading(h); return 0;
    case WM_GETMINMAXINFO: {
      MINMAXINFO *mm = (MINMAXINFO *)l; mm->ptMinTrackSize.x = 720; mm->ptMinTrackSize.y = 480; return 0;
    }
    case WM_APP_URL:
      g_url = (wchar_t *)l;
      navigate_if_ready();
      return 0;
    case WM_APP_FAIL: {
      wchar_t text[400];
      if (w == 1) wcscpy(text, L"Der Animora-Server ist nicht gestartet. Details stehen im Log unter %APPDATA%\\Animora\\logs.");
      else _snwprintf(text, 400, L"Das App-Fenster (WebView2) konnte nicht erstellt werden (0x%08lX).", (unsigned long)l);
      MessageBoxW(h, text, L"Animora", MB_ICONERROR | MB_OK);
      DestroyWindow(h);
      return 0;
    }
    case WM_KEYDOWN:
      if (w == VK_F11) { set_fullscreen(!g_fullscreen); return 0; }
      break;
    case WM_DESTROY:
      if (g_controller) { ICoreWebView2Controller_Close(g_controller); }
      PostQuitMessage(0);
      return 0;
  }
  return DefWindowProcW(h, msg, w, l);
}

// Liest die stdout-Ausgabe des Servers, bis "ANIMORA_URL <adresse>" kommt,
// und leert die Leitung danach weiter (sonst könnte der Server blockieren).
static DWORD WINAPI server_reader(LPVOID arg) {
  HANDLE pipe = (HANDLE)arg;
  char buf[4096]; size_t len = 0; int found = 0;
  for (;;) {
    DWORD got = 0;
    if (!ReadFile(pipe, buf + len, (DWORD)(sizeof buf - 1 - len), &got, NULL) || got == 0) break;
    if (found) { len = 0; continue; }
    len += got; buf[len] = 0;
    char *hit = strstr(buf, "ANIMORA_URL ");
    if (hit) {
      char *end = hit + 12;
      while (*end && *end != '\r' && *end != '\n') end++;
      if (*end) {
        *end = 0;
        wchar_t *url = to_wide(hit + 12);
        found = 1; len = 0;
        PostMessageW(g_hwnd, WM_APP_URL, 0, (LPARAM)url);
        continue;
      }
    }
    if (len > sizeof buf / 2) { memmove(buf, buf + len - 64, 64); len = 64; }
  }
  if (!found) PostMessageW(g_hwnd, WM_APP_FAIL, 1, 0);
  CloseHandle(pipe);
  return 0;
}

static int start_server(const wchar_t *node, const wchar_t *server, int embedded) {
  wchar_t cmdline[MAX_PATH * 10];
  _snwprintf(cmdline, MAX_PATH * 10, L"\"%s\" \"%s\"", node, server);
  STARTUPINFOW si = {0}; si.cb = sizeof si;
  si.dwFlags = STARTF_USESHOWWINDOW; si.wShowWindow = SW_HIDE;
  PROCESS_INFORMATION pi = {0};
  SetEnvironmentVariableW(L"ANIMORA_LAUNCHER", g_self);
  SetEnvironmentVariableW(L"ANIMORA_EMBEDDED", embedded ? L"1" : NULL);

  HANDLE read = NULL, write = NULL;
  if (embedded) {
    SECURITY_ATTRIBUTES sa = { sizeof sa, NULL, TRUE };
    if (!CreatePipe(&read, &write, &sa, 0)) return 0;
    SetHandleInformation(read, HANDLE_FLAG_INHERIT, 0);
    si.dwFlags |= STARTF_USESTDHANDLES;
    si.hStdOutput = write; si.hStdError = write; si.hStdInput = NULL;
  }
  BOOL ok = CreateProcessW(node, cmdline, NULL, NULL, embedded, CREATE_NO_WINDOW | CREATE_SUSPENDED, NULL, g_app, &si, &pi);
  if (write) CloseHandle(write);
  if (!ok) {
    if (read) CloseHandle(read);
    wchar_t msg[600];
    _snwprintf(msg, 600, L"Animora konnte nicht gestartet werden (Fehler %lu).\n\nWird Animora von Windows (z. B. Smart App Control) blockiert?", GetLastError());
    fail(msg);
    return 0;
  }
  if (embedded) {
    // Server (und alles, was er startet) endet mit dem Fenster.
    g_job = CreateJobObjectW(NULL, NULL);
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION info = {0};
    info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    SetInformationJobObject(g_job, JobObjectExtendedLimitInformation, &info, sizeof info);
    AssignProcessToJobObject(g_job, pi.hProcess);
    CloseHandle(CreateThread(NULL, 0, server_reader, read, 0, NULL));
  }
  ResumeThread(pi.hThread);
  CloseHandle(pi.hThread);
  g_server = pi.hProcess;
  return 1;
}

static void dark_titlebar(HWND h) {
  BOOL dark = TRUE;
  DwmSetWindowAttribute(h, 20 /* DWMWA_USE_IMMERSIVE_DARK_MODE */, &dark, sizeof dark);
  COLORREF caption = RGB(16, 14, 24);
  DwmSetWindowAttribute(h, 35 /* DWMWA_CAPTION_COLOR */, &caption, sizeof caption);
}

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE prev, PWSTR cmd, int show) {
  (void)prev;
  SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);

  // Nur ein Fenster: läuft Animora schon, dieses nach vorne holen.
  HANDLE mutex = CreateMutexW(NULL, TRUE, L"Local\\AnimoraApp");
  if (GetLastError() == ERROR_ALREADY_EXISTS) {
    HWND other = FindWindowW(WINDOW_CLASS, NULL);
    if (other) {
      if (IsIconic(other)) ShowWindow(other, SW_RESTORE);
      SetForegroundWindow(other);
    }
    return 0;
  }

  GetModuleFileNameW(NULL, g_self, MAX_PATH * 4);
  wchar_t *local = NULL;
  if (FAILED(SHGetKnownFolderPath(&FOLDERID_LocalAppData, 0, NULL, &local))) { fail(L"LocalAppData nicht gefunden."); return 1; }
  _snwprintf(g_base, MAX_PATH * 4, L"%s\\Animora", local);
  CoTaskMemFree(local);
  // Ordnername enthält die Payload-Größe: jede neue EXE (auch gleiche Version)
  // bekommt so frische Dateien statt eines alten Stands.
  unsigned long long pofs = 0, psize = 0;
  find_payload(&pofs, &psize);
  _snwprintf(g_app, MAX_PATH * 4, L"%s\\app-%s-%I64x", g_base, WIDEN(ANIMORA_VERSION), psize);
  _snwprintf(g_tmp, MAX_PATH * 4, L"%s.tmp", g_app);
  CreateDirectoryW(g_base, NULL);

  int reinstall = cmd && wcsstr(cmd, L"--reinstall") != NULL;
  int browser_mode = cmd && wcsstr(cmd, L"--browser") != NULL;
  wchar_t marker[MAX_PATH * 4], node[MAX_PATH * 4], server[MAX_PATH * 4], loader[MAX_PATH * 4], profile[MAX_PATH * 4];
  _snwprintf(marker, MAX_PATH * 4, L"%s\\.installed", g_app);
  _snwprintf(node, MAX_PATH * 4, L"%s\\runtime\\node.exe", g_app);
  _snwprintf(server, MAX_PATH * 4, L"%s\\web\\server.mjs", g_app);
  _snwprintf(loader, MAX_PATH * 4, L"%s\\runtime\\WebView2Loader.dll", g_app);
  _snwprintf(profile, MAX_PATH * 4, L"%s\\webview", g_base);

  if (reinstall || !exists(marker) || !exists(node) || !exists(server)) {
    extract_with_splash(inst);
    if (!g_ok) { fail(g_err[0] ? g_err : L"Einrichtung fehlgeschlagen."); return 1; }
    cleanup_old();
  }

  // WebView2 verfügbar? Sonst wie bisher im Browser-App-Fenster starten.
  PFN_CreateEnv create_env = NULL;
  if (!browser_mode) {
    HMODULE dll = LoadLibraryW(loader);
    PFN_GetVersion get_version = dll ? (PFN_GetVersion)GetProcAddress(dll, "GetAvailableCoreWebView2BrowserVersionString") : NULL;
    create_env = dll ? (PFN_CreateEnv)GetProcAddress(dll, "CreateCoreWebView2EnvironmentWithOptions") : NULL;
    LPWSTR version = NULL;
    if (!get_version || FAILED(get_version(NULL, &version)) || !version) create_env = NULL;
    if (version) CoTaskMemFree(version);
  }
  if (!create_env) {
    ReleaseMutex(mutex);
    return start_server(node, server, 0) ? 0 : 1;
  }

  CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);

  WNDCLASSEXW wc = { sizeof wc };
  wc.lpfnWndProc = wnd_proc; wc.hInstance = inst; wc.lpszClassName = WINDOW_CLASS;
  wc.hCursor = LoadCursor(NULL, IDC_ARROW);
  wc.hIcon = (HICON)LoadImageW(inst, MAKEINTRESOURCEW(1), IMAGE_ICON, GetSystemMetrics(SM_CXICON), GetSystemMetrics(SM_CYICON), 0);
  wc.hIconSm = (HICON)LoadImageW(inst, MAKEINTRESOURCEW(1), IMAGE_ICON, GetSystemMetrics(SM_CXSMICON), GetSystemMetrics(SM_CYSMICON), 0);
  RegisterClassExW(&wc);

  // Startgröße: 1280×800 (skaliert), höchstens 90 % des Arbeitsbereichs.
  RECT work; SystemParametersInfoW(SPI_GETWORKAREA, 0, &work, 0);
  UINT dpi = GetDpiForSystem();
  int ww = MulDiv(1280, dpi, 96), wh = MulDiv(800, dpi, 96);
  int maxw = (work.right - work.left) * 9 / 10, maxh = (work.bottom - work.top) * 9 / 10;
  if (ww > maxw) ww = maxw;
  if (wh > maxh) wh = maxh;
  int x = work.left + ((work.right - work.left) - ww) / 2, y = work.top + ((work.bottom - work.top) - wh) / 2;

  g_hwnd = CreateWindowExW(0, WINDOW_CLASS, L"Animora", WS_OVERLAPPEDWINDOW, x, y, ww, wh, NULL, NULL, inst, NULL);
  if (!g_hwnd) { fail(L"Das Fenster konnte nicht erstellt werden."); return 1; }
  dark_titlebar(g_hwnd);
  ShowWindow(g_hwnd, show == SW_SHOWMINIMIZED ? SW_SHOWMINIMIZED : SW_SHOWNORMAL);
  UpdateWindow(g_hwnd);

  if (!start_server(node, server, 1)) return 1;
  HRESULT hr = create_env(NULL, profile, NULL, &env_handler);
  if (FAILED(hr)) PostMessageW(g_hwnd, WM_APP_FAIL, 0, (LPARAM)hr);

  MSG msg;
  while (GetMessageW(&msg, NULL, 0, 0) > 0) { TranslateMessage(&msg); DispatchMessageW(&msg); }

  if (g_job) CloseHandle(g_job);  // beendet den Server
  CoUninitialize();
  return 0;
}
