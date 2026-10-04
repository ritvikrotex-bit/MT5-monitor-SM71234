"""Provision and manage one portable MT5 terminal per trading account.

The MetaTrader5 Python package can only be attached to a single terminal (and
therefore a single account) per OS process. A copier needs several accounts
live at once, so every account gets:

  * its own copy of the terminal, under ``settings.terminals_root/<slug>``
  * its own worker process (see :mod:`copier.worker`)

Two terminal copies at different install paths keep separate data folders, so
they never fight over the same files. We also run them with ``/portable`` so
everything (config, logs, history) stays inside the copy and the whole thing
can be deleted by removing one directory.

Only the files a headless terminal actually needs are copied: MetaEditor, the
strategy tester agent and the uninstaller are skipped, which takes an install
from ~381 MB down to ~230 MB.
"""
from __future__ import annotations

import logging
import os
import re
import shutil
import subprocess
import time
from pathlib import Path

log = logging.getLogger(__name__)

# Copied from the source install. Anything not listed is left behind.
INSTALL_ITEMS = ("terminal64.exe", "Bases", "Profiles", "Sounds")

# terminal64.exe is the only mandatory one.
REQUIRED_ITEMS = ("terminal64.exe",)

# Pulled from the *data* folder of the reference install so a fresh portable
# terminal already knows the broker server names (e.g. "WyncrestCapital-Trade").
# Without servers.dat the terminal can only be reached by IP:port.
DATA_ITEMS = ("config/servers.dat",)

_SLUG_RE = re.compile(r"[^A-Za-z0-9_.-]+")


def slugify(server: str, login: int) -> str:
    """Directory name for an account's terminal: stable, unique, filesystem-safe."""
    return f"{_SLUG_RE.sub('-', server).strip('-')}-{int(login)}"


def find_source_install() -> Path:
    """Locate an installed MT5 terminal to clone from."""
    candidates = [
        Path(r"C:\Program Files\MetaTrader 5"),
        Path(r"C:\Program Files (x86)\MetaTrader 5"),
    ]
    for path in candidates:
        if (path / "terminal64.exe").is_file():
            return path
    raise FileNotFoundError(
        "No MetaTrader 5 install found. Install the terminal, or set MT5_SOURCE_INSTALL."
    )


def _terminal_data_roots() -> list[Path]:
    r"""Every place an MT5 data folder might live, most specific first.

    As a Windows service the copier runs as LocalSystem, whose home is
    C:\Windows\System32\config\systemprofile. The terminal that knows the
    broker server names was set up by a person, so its data folder sits under
    that person's profile instead. Looking only at our own home would find
    nothing on the server and leave every named server unreachable.
    """
    roots: list[Path] = []
    override = os.environ.get("MT5_DATA_DIR")
    if override:
        roots.append(Path(override))
    roots.append(Path.home() / "AppData" / "Roaming" / "MetaQuotes" / "Terminal")
    users = Path(os.environ.get("SystemDrive", "C:") + "\\") / "Users"
    if users.is_dir():
        for profile in users.iterdir():
            roots.append(profile / "AppData" / "Roaming" / "MetaQuotes" / "Terminal")
    return roots


def find_source_data_dir(install: Path) -> Path | None:
    r"""Best-effort: the most recently used MT5 data folder on this machine.

    Used only to borrow ``servers.dat``. Returns None when it cannot be found,
    in which case accounts must be configured with an IP:port server address.
    Set MT5_DATA_DIR to point at a specific ``...\MetaQuotes\Terminal`` folder.
    """
    best: tuple[float, Path] | None = None
    for root in _terminal_data_roots():
        try:
            children = list(root.iterdir()) if root.is_dir() else []
        except OSError:
            continue  # another user's profile we are not allowed to read
        for child in children:
            # Data folders are named with a 32-char hex hash of the install path.
            if not child.is_dir() or len(child.name) != 32:
                continue
            servers = child / "config" / "servers.dat"
            try:
                stamp = servers.stat().st_mtime
            except OSError:
                continue
            if best is None or stamp > best[0]:
                best = (stamp, child)
    return best[1] if best else None


def write_portable_config(term_dir: Path) -> None:
    """Enable algorithmic trading in the portable terminal.

    ``order_send`` is rejected while the AutoTrading toggle is off — that is
    what ``terminal_info().trade_allowed`` reports. In portable mode the
    setting lives in ``<install>/config/common.ini``. MT5 writes these files as
    UTF-16LE, and will not read them otherwise.
    """
    config = term_dir / "config"
    config.mkdir(parents=True, exist_ok=True)
    common = config / "common.ini"

    section = "[Experts]"
    desired = {
        "AllowLiveTrading": "1",  # the AutoTrading toggle
        "Enabled": "1",
        "Account": "0",  # do not re-confirm on account change
        "Profile": "0",  # do not re-confirm on profile change
        "AllowDllImport": "0",  # we never load DLLs; keep this off
    }

    lines: list[str] = []
    if common.is_file():
        try:
            lines = common.read_text(encoding="utf-16-le").splitlines()
        except (UnicodeDecodeError, OSError):
            lines = []

    out: list[str] = []
    seen: set[str] = set()
    in_section = False
    for line in lines:
        stripped = line.strip()
        if stripped.startswith("["):
            if in_section:
                # leaving [Experts] — append whatever we have not written yet
                out.extend(f"{k}={v}" for k, v in desired.items() if k not in seen)
            in_section = stripped.lower() == section.lower()
            out.append(line)
            continue
        if in_section and "=" in stripped:
            key = stripped.split("=", 1)[0].strip()
            if key in desired:
                out.append(f"{key}={desired[key]}")
                seen.add(key)
                continue
        out.append(line)

    if in_section:
        out.extend(f"{k}={v}" for k, v in desired.items() if k not in seen)
    elif section not in [line.strip() for line in out]:
        out.append(section)
        out.extend(f"{k}={v}" for k, v in desired.items())

    common.write_text("\n".join(out) + "\n", encoding="utf-16-le")


def provision(server: str, login: int, *, root: Path, source: Path | None = None) -> Path:
    """Create (or reuse) the portable terminal for one account.

    Returns the path to its ``terminal64.exe``. Safe to call on every start:
    an existing, complete terminal is left alone apart from its config.
    """
    source = source or find_source_install()
    term_dir = root / slugify(server, login)
    exe = term_dir / "terminal64.exe"

    if not exe.is_file():
        log.info("provisioning terminal for %s/%s at %s", server, login, term_dir)
        term_dir.mkdir(parents=True, exist_ok=True)
        for item in INSTALL_ITEMS:
            src = source / item
            dst = term_dir / item
            if not src.exists():
                if item in REQUIRED_ITEMS:
                    raise FileNotFoundError(f"{src} is missing from the MT5 install")
                continue
            if dst.exists():
                continue
            if src.is_dir():
                shutil.copytree(src, dst)
            else:
                shutil.copy2(src, dst)

        data_dir = find_source_data_dir(source)
        if data_dir:
            for rel in DATA_ITEMS:
                src = data_dir / rel
                dst = term_dir / rel
                if src.is_file() and not dst.exists():
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(src, dst)
        else:
            log.warning(
                "no reference MT5 data folder found; terminal %s will only reach "
                "servers given as IP:port",
                term_dir,
            )

    write_portable_config(term_dir)
    return exe


def current_session() -> int | None:
    """This process's Windows session; 0 is where services run, with no desktop."""
    try:
        import ctypes

        session = ctypes.c_ulong()
        if ctypes.windll.kernel32.ProcessIdToSessionId(os.getpid(), ctypes.byref(session)):
            return int(session.value)
    except (AttributeError, OSError):
        pass
    return None


_LIST_TERMINALS = (
    "Get-CimInstance Win32_Process -Filter \"Name='terminal64.exe'\" | ForEach-Object { "
    "'{0}|{1}|{2}|{3}' -f $_.ProcessId, "
    "([DateTimeOffset]$_.CreationDate).ToUnixTimeMilliseconds(), $_.SessionId, $_.ExecutablePath }"
)


def parse_terminal_list(output: str, exe: Path) -> list[tuple[int, float, int]]:
    """(pid, start time in epoch seconds, session) of each listed process running ``exe``."""
    target = os.path.normcase(os.path.abspath(exe))
    found: list[tuple[int, float, int]] = []
    for line in output.splitlines():
        parts = line.strip().split("|", 3)
        if len(parts) != 4 or not parts[3]:
            continue  # no path: a process we may not inspect
        try:
            pid, started_ms, session = int(parts[0]), float(parts[1]), int(parts[2])
        except ValueError:
            continue
        if os.path.normcase(os.path.abspath(parts[3])) == target:
            found.append((pid, started_ms / 1000.0, session))
    return found


def running_from(exe: Path) -> list[tuple[int, float, int]]:
    """Every running terminal started from ``exe``, in any Windows session."""
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", _LIST_TERMINALS],
            capture_output=True,
            text=True,
            timeout=30,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (OSError, subprocess.SubprocessError) as exc:
        log.warning("could not list running terminals: %s", exc)
        return []
    return parse_terminal_list(result.stdout, exe)


def stop_stale(exe: Path, *, started_before: float, session: int | None = None) -> list[int]:
    """Close terminals from this account's folder that the current worker cannot use.

    That is any started before ``started_before`` (stopping a worker leaves its
    terminal running), and any in a Windows session other than ``session``: IPC
    cannot reach it there, and two terminals must not share one folder.
    """
    stopped: list[int] = []
    for pid, started, in_session in running_from(exe):
        foreign = session is not None and in_session != session
        if not foreign and started >= started_before - 1.0:
            continue
        try:
            os.kill(pid, 15)  # TerminateProcess on Windows
            stopped.append(pid)
        except OSError as exc:
            log.warning("could not close leftover terminal %s: %s", pid, exc)
    return stopped


# Journal sources that say nothing about why a terminal will not connect.
_JOURNAL_NOISE = frozenset({"MCP", "Compiler", "HistoryCenter"})


def journal_tail(exe: Path, *, since: float, limit: int = 3) -> list[str]:
    """The terminal's own journal since ``since``: what it was doing when it stopped answering.

    A portable terminal writes ``logs/YYYYMMDD.log`` (local date, UTF-16) next to
    its executable, one tab-separated line per event: code, level, time, source, text.
    """
    start_day = time.strftime("%Y%m%d", time.localtime(since))
    start_time = time.strftime("%H:%M:%S", time.localtime(since))
    days = sorted({start_day, time.strftime("%Y%m%d")})
    picked: list[str] = []
    for day in days:
        try:
            text = (exe.parent / "logs" / f"{day}.log").read_text(encoding="utf-16")
        except (OSError, UnicodeError):
            continue
        for line in text.splitlines():
            parts = line.split("\t")
            if len(parts) < 5 or parts[3] in _JOURNAL_NOISE:
                continue
            if day == start_day and parts[2][:8] < start_time:
                continue
            picked.append(f"{parts[3]}: {parts[4].strip()}")
    return picked[-limit:]


def window_titles(pids: set[int]) -> list[str]:
    """Titles of the visible windows these processes own, such as a dialog waiting for a click."""
    titles: list[str] = []
    try:
        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32

        @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        def visit(hwnd, _lparam):
            owner = wintypes.DWORD()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
            if owner.value in pids and user32.IsWindowVisible(hwnd):
                length = user32.GetWindowTextLengthW(hwnd)
                if length:
                    buffer = ctypes.create_unicode_buffer(length + 1)
                    user32.GetWindowTextW(hwnd, buffer, length + 1)
                    titles.append(buffer.value)
            return True

        user32.EnumWindows(visit, 0)
    except (AttributeError, OSError):
        pass
    return titles


# Windows a terminal opens that wait for a click, and block the Python API until closed. After
# updating itself MT5 shows "Welcome to LiveUpdate"; on a server nobody is there to click it.
BLOCKING_DIALOGS = frozenset({"Welcome to LiveUpdate"})


def dialogs_to_close(windows: list[tuple[int, str, str | None]], exe: Path) -> list[int]:
    """Of (hwnd, title, process path) triples, the blocking dialogs owned by ``exe``."""
    target = os.path.normcase(os.path.abspath(exe))
    return [
        hwnd
        for hwnd, title, path in windows
        if title in BLOCKING_DIALOGS and path and os.path.normcase(os.path.abspath(path)) == target
    ]


def visible_windows() -> list[tuple[int, str, str | None]]:
    """(hwnd, title, owning process path) of every visible titled window on this desktop."""
    found: list[tuple[int, str, str | None]] = []
    try:
        import ctypes
        from ctypes import wintypes

        user32, kernel32 = ctypes.windll.user32, ctypes.windll.kernel32

        def process_path(pid: int) -> str | None:
            handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
            if not handle:
                return None
            try:
                size = wintypes.DWORD(1024)
                buffer = ctypes.create_unicode_buffer(size.value)
                if kernel32.QueryFullProcessImageNameW(handle, 0, buffer, ctypes.byref(size)):
                    return buffer.value
                return None
            finally:
                kernel32.CloseHandle(handle)

        @ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
        def visit(hwnd, _lparam):
            if user32.IsWindowVisible(hwnd):
                length = user32.GetWindowTextLengthW(hwnd)
                if length:
                    buffer = ctypes.create_unicode_buffer(length + 1)
                    user32.GetWindowTextW(hwnd, buffer, length + 1)
                    owner = wintypes.DWORD()
                    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner))
                    found.append((int(hwnd), buffer.value, process_path(owner.value)))
            return True

        user32.EnumWindows(visit, 0)
    except (AttributeError, OSError):
        pass
    return found


def dismiss_dialogs(exe: Path) -> int:
    """Close blocking dialogs this terminal shows; the number closed."""
    handles = dialogs_to_close(visible_windows(), exe)
    try:
        import ctypes

        for hwnd in handles:
            ctypes.windll.user32.PostMessageW(hwnd, 0x0010, 0, 0)  # WM_CLOSE, as clicking X
    except (AttributeError, OSError):
        return 0
    return len(handles)


def keep_dismissing(exe: Path, interval: float = 3.0) -> None:
    """Run for the worker's lifetime: an update can open a dialog at any time."""
    while True:
        closed = dismiss_dialogs(exe)
        if closed:
            log.warning("closed %d MT5 dialog(s) blocking %s", closed, exe)
        time.sleep(interval)


def describe_failure(exe: Path, *, since: float) -> str:
    """What the terminal itself shows, for an error that otherwise only says 'IPC timeout'."""
    processes = running_from(exe)
    if not processes:
        what = "no terminal process is running from this folder: it closes as soon as it starts"
    else:
        what = "terminal running (pid {})".format(", ".join(str(p[0]) for p in processes))
        titles = window_titles({p[0] for p in processes})
        if titles:
            what += "; its windows: " + " | ".join(f'"{t}"' for t in titles[:3])
    lines = journal_tail(exe, since=since)
    journal = (
        "its journal: " + " | ".join(f'"{line}"' for line in lines)
        if lines
        else "nothing in its journal since the copier started it"
    )
    return f"{what}; {journal}"


def launch(exe: Path) -> subprocess.Popen:
    """Start a portable terminal detached from our console."""
    flags = 0
    if hasattr(subprocess, "CREATE_NO_WINDOW"):
        flags = subprocess.CREATE_NO_WINDOW  # type: ignore[attr-defined]
    return subprocess.Popen(
        [str(exe), "/portable"],
        cwd=str(exe.parent),
        creationflags=flags,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
