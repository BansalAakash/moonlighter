import Foundation

/// Two ways to run something, on purpose.
///
/// A GUI app inherits launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin), not the login shell's —
/// so Homebrew's tmux and an fnm-managed node are both invisible to it. The status poll runs
/// every few seconds and must stay cheap, so it calls absolute paths directly. The menu
/// ACTIONS run through a login shell instead, which is slower (~100ms) but resolves
/// `claude-auto-retry` exactly the way the user's own terminal would — including whatever
/// node their fnm/nvm setup selects. Actions are user-initiated and rare; the poll is not.
enum Shell {
    /// Output collected from the reader thread, behind a lock the waiting side shares.
    private final class Collected: @unchecked Sendable {
        private let lock = NSLock()
        private var data = Data()
        func set(_ d: Data) { lock.lock(); data = d; lock.unlock() }
        func get() -> Data { lock.lock(); defer { lock.unlock() }; return data }
    }

    /// Runs a command and returns its stdout and exit status. `timeout` is ENFORCED: a child
    /// still running when it expires is terminated (then killed) and the call returns whatever
    /// it had printed, with status -1. The previous version read to EOF BEFORE looking at the
    /// clock, so the deadline only ever applied to a process that had already finished — a hung
    /// child blocked the caller indefinitely, and on the main thread that froze the menu bar.
    @discardableResult
    static func run(_ launchPath: String, _ args: [String], timeout: TimeInterval = 10,
                    environment: [String: String]? = nil) -> (out: String, status: Int32) {
        let p = Process()
        if let environment { p.environment = environment }
        p.executableURL = URL(fileURLWithPath: launchPath)
        p.arguments = args
        let pipe = Pipe()
        p.standardOutput = pipe
        // Never read, so it must never be a pipe: a child writing more than the pipe buffer to
        // an undrained stderr blocks forever.
        p.standardError = FileHandle.nullDevice

        let exited = DispatchSemaphore(value: 0)
        p.terminationHandler = { _ in exited.signal() }
        do { try p.run() } catch { return ("", -1) }

        // Drain stdout on its own thread, concurrently with the wait: a child that fills the
        // 64KB pipe would otherwise block on write while we block waiting for it to exit.
        let collected = Collected()
        let drained = DispatchSemaphore(value: 0)
        let reader = pipe.fileHandleForReading
        DispatchQueue.global(qos: .utility).async {
            collected.set(reader.readDataToEndOfFile())
            drained.signal()
        }

        var timedOut = false
        if exited.wait(timeout: .now() + timeout) == .timedOut {
            timedOut = true
            p.terminate()
            if exited.wait(timeout: .now() + 2) == .timedOut {
                kill(p.processIdentifier, SIGKILL)
                _ = exited.wait(timeout: .now() + 1)
            }
        }
        // EOF normally arrives with the exit. A grandchild that inherited the pipe can hold it
        // open past that, so this wait is bounded too — we return what we have.
        _ = drained.wait(timeout: .now() + 2)

        let out = String(data: collected.get(), encoding: .utf8) ?? ""
        let status: Int32 = (timedOut || p.isRunning) ? -1 : p.terminationStatus
        return (out, status)
    }

    /// Run a command the way the user's terminal would (login shell, so rc files set PATH).
    @discardableResult
    static func login(_ command: String, timeout: TimeInterval = 60) -> (out: String, status: Int32) {
        run("/bin/zsh", ["-lc", command], timeout: timeout)
    }

    /// First existing path from a candidate list — used to find tools launchd can't see.
    static func firstExisting(_ paths: [String]) -> String? {
        paths.first { FileManager.default.isExecutableFile(atPath: $0) }
    }
}

enum Tmux {
    struct PaneInfo { var session: String; var socket: String; var path: String; var title: String }
    struct MonitorInfo { var monitorPid: Int; var claudePid: Int }

    static var binary: String? {
        Shell.firstExisting(["/opt/homebrew/bin/tmux", "/usr/local/bin/tmux", "/usr/bin/tmux"])
    }

    /// `-u` is load-bearing. A GUI app inherits launchd's environment, which has no LANG/LC_*, and
    /// a tmux client that does not believe it is in a UTF-8 locale rewrites every tab and every
    /// non-ASCII character in `-F` output to "_" (observed on tmux 3.7c). The tab-separated
    /// fields below then never split, `panes()` came back empty, and the menu bar listed no
    /// sessions at all while the monitors were running fine. `-u` forces UTF-8 regardless of
    /// the environment.
    static let listPanesArguments = ["-u", "list-panes", "-a", "-F",
        "#{pane_id}\t#{session_name}\t#{socket_path}\t#{pane_current_path}\t#{pane_title}"]

    /// Parses `listPanesArguments` output. pane_title is LAST and may contain anything, tabs
    /// included, so everything past the fourth separator belongs to it.
    static func parsePanes(_ out: String) -> [String: PaneInfo] {
        var map: [String: PaneInfo] = [:]
        for line in out.split(separator: "\n") {
            let f = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
            guard f.count >= 5 else { continue }
            map[f[0]] = PaneInfo(session: f[1], socket: f[2], path: f[3],
                                 title: f[4...].joined(separator: "\t"))
        }
        return map
    }

    /// pane id → session/socket, across every pane of the default server.
    static func panes() -> [String: PaneInfo] {
        guard let tmux = binary else { return [:] }
        // pane_title LAST: Claude Code sets it to a description of what the session is about
        // ("✳ Claude-auto-retry review"), which is the only identifier here that means anything
        // to a person — session names are minted as claude-retry-<pid>-<timestamp>, and two
        // sessions often share a working directory. It is free-form text, so it goes at the end
        // where a stray separator cannot shift the other fields.
        let (out, status) = Shell.run(tmux, listPanesArguments)
        guard status == 0 else { return [:] }   // no server running is exit 1, not a crash
        return parsePanes(out)
    }

    /// Every tmux pane running a Claude session, whether or not it is monitored — including
    /// the ones switched OFF, whose monitor is dead and whose status file was removed with it.
    /// Without this, turning a session off would make it disappear from the menu and there
    /// would be no way to turn it back on.
    ///
    /// Read from `reconcile --dry-run`, which reports exactly this and takes no lock and no
    /// action. Deriving it here instead would mean a second implementation of reconcile's
    /// pane→claude mapping (a pid→ppid walk, print-mode filtering, agent wrappers), free to
    /// drift from the one that actually arms the monitors.
    ///
    ///   "  %0 → claude 27374 (monitor 92080)"
    ///   "  %1 → claude 79121: skipped (already monitored)"
    static func claudePanes() -> [String: Int] {
        let (out, _) = Controller.cli(["reconcile", "--dry-run"], timeout: 15)
        var map: [String: Int] = [:]
        let pattern = try! NSRegularExpression(pattern: #"(%\d+)\s*→\s*claude\s+(\d+)"#)
        for line in out.split(separator: "\n") {
            let s = String(line)
            let range = NSRange(s.startIndex..., in: s)
            guard let m = pattern.firstMatch(in: s, range: range),
                  let paneR = Range(m.range(at: 1), in: s),
                  let pidR = Range(m.range(at: 2), in: s),
                  let pid = Int(s[pidR]) else { continue }
            map[String(s[paneR])] = pid
        }
        return map
    }

    /// pane id → the monitor watching it. Parsed from the monitor's own argv
    /// ("node …/src/monitor.js <pane> <claudePid>"), the same shape src/reconcile.js keys on.
    static func runningMonitors() -> [String: MonitorInfo] {
        let (out, _) = Shell.run("/usr/bin/pgrep", ["-lf", "node .*src/monitor\\.js"])
        var map: [String: MonitorInfo] = [:]
        for line in out.split(separator: "\n") {
            let toks = line.split(separator: " ").map(String.init)
            guard let mpid = Int(toks.first ?? ""),
                  let paneIdx = toks.firstIndex(where: { $0.hasPrefix("%") }),
                  paneIdx + 1 < toks.count,
                  let cpid = Int(toks[paneIdx + 1]) else { continue }
            map[toks[paneIdx]] = MonitorInfo(monitorPid: mpid, claudePid: cpid)
        }
        return map
    }
}
