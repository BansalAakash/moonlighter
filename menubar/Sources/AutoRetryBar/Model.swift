import Foundation

// The monitor already publishes everything this app needs. src/status-file.js writes one
// JSON snapshot per pane on every tick, atomically (tmp + rename), specifically so an
// external reader can render an indicator without talking to the daemon — bin/tmux-status.sh
// is the shell reader, this is the GUI one. So the app never inspects a monitor's memory and
// never needs to be launched by it: it polls a directory.
//
// Timestamps in those files are epoch SECONDS (BSD `date` has no %N, so the shell reader
// needed seconds), and `pollIntervalSeconds` travels with every snapshot so a reader can
// derive its own staleness threshold instead of assuming a fixed cadence.

struct PaneStatus: Decodable {
    var status: String
    var waitUntil: Int?
    var overloadWaitUntil: Int?
    var safeguardWaitUntil: Int?
    var contextWaitUntil: Int?
    var attempts: Int?
    var overloadAttempts: Int?
    var safeguardAttempts: Int?
    var contextAttempts: Int?
    var pollIntervalSeconds: Int?
    var gaveUp: Bool?
    var updatedAt: Int
}

/// One monitored pane: the published snapshot, plus the live tmux/process facts the snapshot
/// cannot know (which session the pane belongs to, whether a monitor is actually running).
struct Session {
    var pane: String              // "%0"
    var socket: String            // "/private/tmp/tmux-501/default"
    var status: PaneStatus
    var sessionName: String?
    var title: String = ""
    var path: String = ""
    var claudePid: Int?
    var monitorPid: Int?
    /// Whether this session gets picked back up after a limit reset. The single per-session
    /// setting; everything else the app knows is read-only status.
    var autoResume: Bool = true

    /// A monitor that stopped ticking. The file outlives the process (SIGKILL, host crash),
    /// so freshness is what separates "being watched" from "a leftover file". Three missed
    /// ticks is the same tolerance bin/tmux-status.sh uses, floored so a 1s poll doesn't make
    /// every snapshot look stale on a busy machine.
    var isStale: Bool {
        let poll = max(status.pollIntervalSeconds ?? 5, 5)
        return Int(Date().timeIntervalSince1970) - status.updatedAt > poll * 3
    }

    /// Freshness alone decides liveness, NOT the presence of a matching process. Only a
    /// running monitor writes this file, so a recent `updatedAt` is direct evidence one is
    /// ticking; the pgrep match is a second-hand signal that can go missing for reasons that
    /// have nothing to do with the monitor (a pgrep pattern that stops matching after a path
    /// change, a sandbox). Requiring both meant one flaky signal could report every healthy
    /// session as unmonitored. The pid is still needed to ACT on a monitor — stopping and
    /// restarting are gated on having one — but not to believe in it.
    var isLive: Bool { !isStale }

    /// The deadline this session is currently counting down to, if any. The monitor keeps
    /// each family's deadline in its own field so they can't be confused for one another.
    var deadline: Date? {
        let epoch: Int?
        switch status.status {
        case "waiting":   epoch = status.waitUntil
        case "overload":  epoch = status.overloadWaitUntil
        case "safeguard": epoch = status.safeguardWaitUntil
        case "context":   epoch = status.contextWaitUntil
        default:          epoch = nil
        }
        guard let e = epoch, e > 0 else { return nil }
        let d = Date(timeIntervalSince1970: TimeInterval(e))
        return d > Date() ? d : nil
    }

    enum Health { case waiting, working, attention, idle, dead, off }

    var health: Health {
        if !autoResume { return .off }
        if !isLive { return .dead }
        if status.gaveUp == true { return .attention }
        switch status.status {
        case "waiting":                          return .waiting
        case "overload", "safeguard", "context": return .working
        default:                                 return .idle
        }
    }

    /// Plain English, describing what the SESSION is doing — not what the daemon is doing.
    /// "monitoring" is true of the monitor and meaningless to someone who just wants to know
    /// whether their work is still moving.
    var headline: String {
        if !autoResume { return "auto-resume off" }
        if isStale { return "not being watched" }
        if status.gaveUp == true { return "stuck — needs you" }
        switch status.status {
        case "waiting":
            return deadline.map { "resumes in \(Self.short($0))" } ?? "waiting for the limit to reset"
        case "overload":
            return "API busy — retrying"
        case "safeguard":
            return "retrying"
        case "context":
            return "compacting, then resuming"
        default:
            return "running"
        }
    }

    /// What to call this session in a menu. tmux session names are minted by the launcher as
    /// `claude-retry-<pid>-<timestamp>`, so they identify a session without describing it —
    /// "Claude 79084" tells you nothing about which window it is. Claude Code sets the pane
    /// TITLE to a description of the work ("✳ Claude-auto-retry review"), which is the only
    /// identifier here a person can act on. Falls back to the directory, then the pane id;
    /// the working directory alone is a poor discriminator because several sessions commonly
    /// share one.
    var displayName: String {
        let cleaned = Self.stripGlyph(title)
        if !cleaned.isEmpty, !Self.isPlaceholderTitle(cleaned) { return cleaned }
        let dir = path.split(separator: "/").last.map(String.init) ?? ""
        return dir.isEmpty ? pane : dir
    }

    /// Claude Code prefixes the title with its own status glyph; shells and terminals leave
    /// behind names that describe the program, not the work.
    static func stripGlyph(_ s: String) -> String {
        var t = s.trimmingCharacters(in: .whitespaces)
        while let f = t.unicodeScalars.first,
              !CharacterSet.alphanumerics.contains(f) && f != "/" && f != "~" {
            t = String(t.dropFirst()).trimmingCharacters(in: .whitespaces)
        }
        return t
    }

    static func isPlaceholderTitle(_ s: String) -> Bool {
        let lower = s.lowercased()
        return ["zsh", "bash", "sh", "fish", "tmux", "node", "claude"].contains(lower)
            || lower.hasPrefix("claude-retry-")
    }

    /// "3h12m" / "12m" / "48s" — a countdown short enough for the menu bar itself.
    static func short(_ date: Date) -> String {
        let s = max(0, Int(date.timeIntervalSinceNow))
        if s >= 3600 { return "\(s / 3600)h\((s % 3600) / 60)m" }
        if s >= 60   { return "\(s / 60)m" }
        return "\(s)s"
    }
}

/// `~/.claude-auto-retry/reconcile-exclude` — the durable "don't auto-resume this one" list.
///
/// This app does not invent a preference store. That file is what `reconcile` (and therefore
/// the 5-minute timer) already consults, so it is the only place a per-session setting can
/// live and actually be honoured by the daemon. Entries are one per line, `#` comments
/// allowed:
///   1842917   ← a claude PID. Preferred: unique while alive, and self-expiring, because
///               reconcile prunes dead PIDs on read. Written by `exclude-self`.
///   %2        ← a tmux pane id. Hand-editable, but tmux reuses pane ids, so a stale one can
///               mute an unrelated future session. Never pruned.
enum ExcludeList {
    static var file: URL { Snapshot.home.appending(path: ".claude-auto-retry/reconcile-exclude") }

    struct Entry {
        var token: String       // the first field: a pid or a "%N"
        var pane: String?       // from the "# pane %N," comment exclude-self writes
        var raw: String
    }

    static func isProcessAlive(_ pid: Int) -> Bool {
        kill(pid_t(pid), 0) == 0 || errno == EPERM   // EPERM: exists, just not ours
    }

    static func entries() -> [Entry] {
        guard let text = try? String(contentsOf: file, encoding: .utf8) else { return [] }
        return text.split(separator: "\n", omittingEmptySubsequences: false).compactMap { line in
            let s = line.trimmingCharacters(in: .whitespaces)
            guard !s.isEmpty, !s.hasPrefix("#") else { return nil }
            let token = s.split(whereSeparator: { $0 == " " || $0 == "\t" || $0 == "#" })
                .first.map(String.init) ?? ""
            guard !token.isEmpty else { return nil }
            var pane: String? = nil
            if let r = s.range(of: "pane %[0-9]+", options: .regularExpression) {
                pane = String(s[r].dropFirst("pane ".count))
            }
            return Entry(token: token, pane: pane, raw: String(line))
        }
    }

    /// Does an ACTIVE exclusion cover this pane? "Active" applies reconcile's own pruning
    /// rule: a numeric entry whose process is gone no longer excludes anything, so a stale
    /// line left in the file cannot make a reused pane look switched off.
    static func excludes(pane: String, claudePid: Int?) -> Bool {
        for e in entries() {
            if e.token == pane { return true }                    // %N form, never pruned
            guard let pid = Int(e.token), isProcessAlive(pid) else { continue }
            if pid == claudePid { return true }
            // No monitor running means no pid to compare against — fall back to the pane the
            // entry names. Its own pid is alive, so this is that session, not a stale line.
            if claudePid == nil, e.pane == pane { return true }
        }
        return false
    }

    /// Drop every entry covering this pane. The counterpart to `exclude-self`, which the CLI
    /// has no inverse for.
    static func include(pane: String, claudePid: Int?) {
        let kept = entries().filter { e in
            if e.token == pane { return false }
            if let pid = Int(e.token) {
                if pid == claudePid { return false }
                if e.pane == pane { return false }
            }
            return true
        }
        let body = kept.map(\.raw).joined(separator: "\n")
        try? (body.isEmpty ? "" : body + "\n").write(to: file, atomically: true, encoding: .utf8)
    }
}

enum Snapshot {
    static let home = FileManager.default.homeDirectoryForCurrentUser
    static var statusDir: URL { home.appending(path: ".claude-auto-retry/status") }
    static var logsDir: URL { home.appending(path: ".claude-auto-retry/logs") }
    static var configFile: URL { home.appending(path: ".claude-auto-retry.json") }

    /// Status filenames are "<sanitized socket>_<sanitized pane>.json" (src/pane-key.js
    /// replaces every character outside [A-Za-z0-9_-] with "_"). Sanitizing is lossy, so the
    /// socket path is NOT reconstructed from the name — the pane id is taken from the last
    /// "_%N"-shaped component and the socket is matched up from live tmux state instead.
    static func paneId(fromFileName name: String) -> String? {
        let base = name.replacingOccurrences(of: ".json", with: "")
        guard let r = base.range(of: "_[0-9]+$", options: .regularExpression) else { return nil }
        return "%" + base[r].dropFirst()
    }

    /// Everything `load()` finds, plus the Claude panes that have no monitor at all — the ones
    /// switched off. Costs a `reconcile --dry-run` (a login shell and a process scan), so it
    /// runs when the menu opens, not on the 5-second bar refresh.
    static func loadFull() -> [Session] {
        var sessions = load()
        let panes = Tmux.panes()
        for (pane, claudePid) in Tmux.claudePanes()
        where !sessions.contains(where: { $0.pane == pane }) {
            guard let info = panes[pane] else { continue }
            sessions.append(Session(
                pane: pane, socket: info.socket,
                // No monitor and no snapshot: stale by construction, which is exactly right —
                // nothing is watching it. Whether that is deliberate is what autoResume says.
                status: PaneStatus(status: "monitoring", updatedAt: 0),
                sessionName: info.session, title: info.title, path: info.path,
                claudePid: claudePid, monitorPid: nil,
                autoResume: ExcludeList.excludes(pane: pane, claudePid: claudePid) == false))
        }
        return sessions.sorted { $0.pane.compare($1.pane, options: .numeric) == .orderedAscending }
    }

    static func load() -> [Session] {
        let fm = FileManager.default
        let files = (try? fm.contentsOfDirectory(at: statusDir, includingPropertiesForKeys: nil)) ?? []
        let panes = Tmux.panes()
        let monitors = Tmux.runningMonitors()

        var out: [Session] = []
        for file in files where file.pathExtension == "json" {
            guard let pane = paneId(fromFileName: file.lastPathComponent),
                  // Only panes that still EXIST. A status file outlives its pane (the monitor
                  // is SIGKILLed, the host crashes, the pane is closed), and listing those
                  // filled the menu with rows for sessions that are simply gone — noise that
                  // looked like a problem. The daemon sweeps them on its own schedule; until
                  // then they are not something to report.
                  let info = panes[pane],
                  let data = try? Data(contentsOf: file),
                  let status = try? JSONDecoder().decode(PaneStatus.self, from: data)
            else { continue }
            out.append(Session(
                pane: pane,
                socket: info.socket,
                status: status,
                sessionName: info.session, title: info.title, path: info.path,
                claudePid: monitors[pane]?.claudePid,
                monitorPid: monitors[pane]?.monitorPid,
                autoResume: !ExcludeList.excludes(pane: pane, claudePid: monitors[pane]?.claudePid)))
        }
        // A monitor armed seconds ago has no snapshot yet and would be invisible for its first
        // tick. Same existence rule: only if the pane is really there.
        for (pane, m) in monitors where !out.contains(where: { $0.pane == pane }) {
            guard let info = panes[pane] else { continue }
            out.append(Session(
                pane: pane, socket: info.socket,
                status: PaneStatus(status: "monitoring", updatedAt: Int(Date().timeIntervalSince1970)),
                sessionName: info.session, title: info.title, path: info.path,
                claudePid: m.claudePid, monitorPid: m.monitorPid,
                autoResume: !ExcludeList.excludes(pane: pane, claudePid: m.claudePid)))
        }
        return out.sorted { $0.pane.compare($1.pane, options: .numeric) == .orderedAscending }
    }
}
