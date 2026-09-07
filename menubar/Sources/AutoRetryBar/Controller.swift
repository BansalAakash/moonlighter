import AppKit
import ServiceManagement

/// Everything the menu can DO. Each action is a thin wrapper over the CLI the package already
/// exposes, rather than a reimplementation: `reconcile` owns the single-instance lock and the
/// pane→claude mapping, `install-timer` owns the launchd plist. Duplicating any of that here
/// would give the app a second, subtly different opinion about the same state.
enum Controller {
    static let launchAgentLabel = "com.claude-auto-retry.reconcile"

    // MARK: - Reconcile / monitors

    /// Re-arm a monitor for every live claude pane that lacks one.
    ///
    /// TMUX_PANE is unset deliberately. reconcile treats $TMUX_PANE as "self" and skips it so
    /// that running it from inside a session doesn't monitor that session — correct for a CLI
    /// typed into a pane, wrong for this app, which is not any pane and wants full coverage.
    /// A GUI app normally has no TMUX_PANE anyway; unsetting makes that independent of how the
    /// app was launched (from a terminal during development, it would inherit one).
    @discardableResult
    static func reconcile() -> String {
        Shell.login("unset TMUX_PANE; claude-auto-retry reconcile 2>&1").out
    }

    /// The one per-session setting: will this session be picked back up after a limit resets?
    ///
    /// OFF is `exclude-self` with TMUX_PANE pointed at the target pane. That command already
    /// does both halves of the job — it records the session by claude PID (the self-expiring
    /// form, so the entry dies with the session and can never mute a later one that inherits
    /// the pid) and stops the monitor covering that pane. The 5-minute reconcile then leaves
    /// it alone, which is what makes OFF stick rather than lasting until the next timer fire.
    ///
    /// ON removes the entry and reconciles, which arms a fresh monitor. There is no `include`
    /// command to lean on, so the file edit lives in ExcludeList.
    static func setAutoResume(_ on: Bool, for session: Session) {
        if on {
            ExcludeList.include(pane: session.pane, claudePid: session.claudePid)
            _ = reconcile()
        } else {
            _ = Shell.login("TMUX_PANE=\(session.pane) claude-auto-retry exclude-self 2>&1")
        }
    }

    static func restartAllMonitors() {
        for s in Snapshot.load() { if let pid = s.monitorPid { kill(pid_t(pid), SIGTERM) } }
        usleep(600_000)
        _ = reconcile()
    }

    // MARK: - Self-healing timer (launchd)

    static var timerInstalled: Bool {
        Shell.run("/bin/launchctl", ["print", "gui/\(getuid())/\(launchAgentLabel)"]).status == 0
    }

    static func setTimer(enabled: Bool) -> String {
        Shell.login("claude-auto-retry \(enabled ? "install-timer" : "uninstall-timer") 2>&1").out
    }

    // MARK: - Launch at login

    // A real preference, unlike the reconcile timer: people legitimately want to decide
    // whether an app starts with their Mac, and every menu bar utility offers it. It defaults
    // to ON (see the first-launch note in AppDelegate) because unattended overnight coverage
    // is the point, but the choice stays the user's.
    //
    // SMAppService (macOS 13+) registers the app bundle itself, so there is no helper to keep
    // in sync — but it needs a stable code identity, which is why build_app.sh ad-hoc signs.

    static var launchAtLoginEnabled: Bool { SMAppService.mainApp.status == .enabled }

    /// The raw status, for --dump. `.notFound` is what an unbundled binary reports, so seeing
    /// it here means the app was run outside its .app rather than that anything is wrong.
    static var launchAtLoginDescription: String {
        switch SMAppService.mainApp.status {
        case .notRegistered:     return "not registered"
        case .enabled:           return "enabled"
        case .requiresApproval:  return "requires approval in System Settings → Login Items"
        case .notFound:          return "not found (running outside the .app bundle?)"
        @unknown default:        return "unknown"
        }
    }

    /// Returns nil on success, or a message worth showing. macOS can put the registration in
    /// `.requiresApproval` when the user has previously disabled the item in System Settings;
    /// that is not an error, but it does mean nothing will happen until they approve it, and
    /// silently reporting success there would be a lie.
    static func setLaunchAtLogin(_ enabled: Bool) -> String? {
        do {
            if enabled {
                try SMAppService.mainApp.register()
                if SMAppService.mainApp.status == .requiresApproval {
                    return "macOS needs you to approve this in System Settings → General → Login Items."
                }
            } else {
                try SMAppService.mainApp.unregister()
            }
            return nil
        } catch {
            return "Could not \(enabled ? "enable" : "disable") launch at login: \(error.localizedDescription)"
        }
    }

    // MARK: - Files and terminals

    /// Open in Sublime Text, falling back to whatever macOS would have used. Searched by path
    /// rather than bundle id because `NSWorkspace.urlForApplication` depends on Launch
    /// Services having indexed the app, and Spotlight indexing is not guaranteed to be on.
    private static let sublimePaths = [
        "/Applications/Sublime Text.app",
        "\(NSHomeDirectory())/Applications/Sublime Text.app",
        "/Applications/Sublime Text 4.app",
        "/Applications/Sublime Text 3.app",
    ]

    static func open(_ url: URL) {
        guard let app = sublimePaths.first(where: { FileManager.default.fileExists(atPath: $0) }) else {
            NSWorkspace.shared.open(url)      // Sublime isn't installed — don't fail, just open
            return
        }
        let config = NSWorkspace.OpenConfiguration()
        config.activates = true
        NSWorkspace.shared.open([url], withApplicationAt: URL(fileURLWithPath: app),
                                configuration: config) { _, error in
            // Sublime is present but refused (damaged bundle, quarantine). Silently losing the
            // click would look like the menu item is broken, so fall back.
            if error != nil { DispatchQueue.main.async { NSWorkspace.shared.open(url) } }
        }
    }

    static func openConfig() {
        // Create it on first open so the editor isn't handed a missing path. The monitor reads
        // this file fresh on every start, and an empty object is a valid config (all defaults).
        if !FileManager.default.fileExists(atPath: Snapshot.configFile.path) {
            try? Data("{\n}\n".utf8).write(to: Snapshot.configFile)
        }
        open(Snapshot.configFile)
    }

    /// Open (creating if needed) the prompt that belongs to just this session.
    ///
    /// Seeded with the global message rather than left blank: the useful edit is almost always
    /// "the standard instruction, but for this project", and starting from an empty buffer
    /// invites sending something half-written. Deleting the contents removes the override —
    /// the daemon treats an empty file as "no override" rather than "send nothing".
    static func openSessionPrompt(_ session: Session) {
        guard let file = SessionPrompt.file(for: session) else { return }
        if !FileManager.default.fileExists(atPath: file.path) {
            try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(),
                                                     withIntermediateDirectories: true)
            let seed = SessionPrompt.globalMessage() ?? ""
            try? Data((seed + "\n").utf8).write(to: file)
        }
        open(file)
    }

    private static let logDateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd"
        // The monitor names its log from `new Date().toISOString()`, which is UTC — so the
        // "today" file can differ from local-midnight today. Matching that keeps the app
        // pointed at the file actually being appended to.
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()

    static func log(daysAgo: Int = 0) -> URL {
        let day = Date().addingTimeInterval(TimeInterval(-86400 * daysAgo))
        return Snapshot.logsDir.appending(path: "\(logDateFormatter.string(from: day)).log")
    }

    static var todayLog: URL { log() }

    /// Lines the daemon writes about ITSELF rather than about your work. A monitor starting,
    /// or shutting down because Claude exited, is bookkeeping — it says nothing about whether
    /// the session is progressing, and it is what the log usually ends with, so an unfiltered
    /// "last line" showed plumbing almost every time.
    ///
    /// Stated as an exclude-list rather than a list of interesting events on purpose: an
    /// include-list silently drops anything the daemon learns to log later, so a new failure
    /// mode would be invisible here exactly when it mattered. Excluding known chatter fails the
    /// other way — something unrecognised still surfaces.
    private static let logChatter = [
        "Monitor started",
        "Monitor shutting down",
        "Claude exited",
        "User already continued",
    ]

    /// One line of the log, already split into when and what.
    struct Event {
        let at: Date?
        let message: String

        /// "just now" / "12m ago" / "7h ago". Deliberately relative rather than the clock time
        /// it used to show: a bare "06:21" in a menu you open at teatime reads as a stray log
        /// line, while "7h ago" answers the question you actually opened the menu with.
        var age: String {
            guard let at else { return "" }
            let s = max(0, Int(Date().timeIntervalSince(at)))
            if s < 90    { return "just now" }
            if s < 3600  { return "\(s / 60)m ago" }
            if s < 86400 { return "\(s / 3600)h ago" }
            return "\(s / 86400)d ago"
        }
    }

    /// "[2026-09-07 02:49:30] [INFO] Sent retry message" → the date, and just the message.
    ///
    /// UTC, because src/logger.js stamps lines with `new Date().toISOString()`. Leaving the
    /// formatter on the system zone silently reads that as local time, which is not a parse
    /// failure — it is a plausible-looking date that is off by the user's UTC offset, so the
    /// age it produces is wrong by hours without ever looking wrong.
    private static let stampParser: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "yyyy-MM-dd HH:mm:ss"
        f.timeZone = TimeZone(identifier: "UTC")
        f.locale = Locale(identifier: "en_US_POSIX")
        return f
    }()

    static func parse(_ line: String) -> Event {
        guard line.hasPrefix("["), let close = line.firstIndex(of: "]") else {
            return Event(at: nil, message: line)
        }
        let stamp = String(line[line.index(after: line.startIndex)..<close])
        var rest = String(line[line.index(after: close)...]).trimmingCharacters(in: .whitespaces)
        for level in ["[INFO]", "[WARN]", "[ERROR]"] where rest.hasPrefix(level) {
            rest = String(rest.dropFirst(level.count)).trimmingCharacters(in: .whitespaces)
        }
        return Event(at: stampParser.date(from: stamp), message: rest)
    }

    /// The most recent thing that happened TO THE WORK, or nil if nothing has.
    ///
    /// Yesterday's file is searched too. Logs are named by UTC date, so for anyone east of
    /// Greenwich the small hours of a local morning — exactly when an overnight retry fires —
    /// land in the previous file, and looking only at "today" would hide the one event the
    /// user opens this menu to check. Scanned from the end; these files rotate daily.
    static func lastEvent() -> Event? {
        for daysAgo in 0...1 {
            guard let text = try? String(contentsOf: log(daysAgo: daysAgo), encoding: .utf8) else { continue }
            if let line = text.split(separator: "\n").map(String.init).reversed()
                .first(where: { line in !logChatter.contains { line.contains($0) } }) {
                return parse(line)
            }
        }
        return nil
    }

    /// Used only where staying silent would be a lie — e.g. macOS parking a login-item
    /// registration in `.requiresApproval`, where nothing happens until the user acts.
    static func notify(_ title: String, _ body: String) {
        let a = NSAlert()
        a.messageText = title
        a.informativeText = body
        a.alertStyle = .informational
        NSApp.activate(ignoringOtherApps: true)
        a.runModal()
    }
}
