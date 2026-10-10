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

    /// Several sessions at once: one reconcile for the lot when switching ON, rather than one per
    /// session (each is a login shell plus node).
    static func setAutoResume(_ on: Bool, for sessions: [Session]) {
        if on {
            for s in sessions { ExcludeList.include(pane: s.pane, claudePid: s.claudePid) }
            _ = reconcile()
        } else {
            for s in sessions { _ = Shell.login("TMUX_PANE=\(s.pane) claude-auto-retry exclude-self 2>&1") }
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
