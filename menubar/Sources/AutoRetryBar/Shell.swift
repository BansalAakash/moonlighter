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
    @discardableResult
    static func run(_ launchPath: String, _ args: [String], timeout: TimeInterval = 10) -> (out: String, status: Int32) {
        let p = Process()
        p.executableURL = URL(fileURLWithPath: launchPath)
        p.arguments = args
        let pipe = Pipe()
        p.standardOutput = pipe
        p.standardError = Pipe()
        do { try p.run() } catch { return ("", -1) }

        // Read BEFORE waiting: a child that fills the 64KB pipe buffer blocks forever on write
        // while the parent blocks in waitUntilExit — the classic deadlock. Reading to EOF is
        // itself the join, so waitUntilExit afterwards returns immediately.
        let data = pipe.fileHandleForReading.readDataToEndOfFile()
        let deadline = Date().addingTimeInterval(timeout)
        while p.isRunning && Date() < deadline { usleep(20_000) }
        if p.isRunning { p.terminate() }
        p.waitUntilExit()
        return (String(data: data, encoding: .utf8) ?? "", p.terminationStatus)
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

    /// pane id → session/socket, across every pane of the default server.
    static func panes() -> [String: PaneInfo] {
        guard let tmux = binary else { return [:] }
        // pane_title LAST: Claude Code sets it to a description of what the session is about
        // ("✳ Claude-auto-retry review"), which is the only identifier here that means anything
        // to a person — session names are minted as claude-retry-<pid>-<timestamp>, and two
        // sessions often share a working directory. It is free-form text, so it goes at the end
        // where a stray separator cannot shift the other fields.
        let (out, status) = Shell.run(tmux, ["list-panes", "-a", "-F",
            "#{pane_id}\t#{session_name}\t#{socket_path}\t#{pane_current_path}\t#{pane_title}"])
        guard status == 0 else { return [:] }   // no server running is exit 1, not a crash
        var map: [String: PaneInfo] = [:]
        for line in out.split(separator: "\n") {
            let f = line.split(separator: "\t", omittingEmptySubsequences: false).map(String.init)
            guard f.count >= 5 else { continue }
            map[f[0]] = PaneInfo(session: f[1], socket: f[2], path: f[3],
                                 title: f[4...].joined(separator: "\t"))
        }
        return map
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
        let (out, _) = Shell.login("unset TMUX_PANE; claude-auto-retry reconcile --dry-run 2>&1", timeout: 15)
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
