import AppKit
import ServiceManagement

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem?
    private var refreshTimer: Timer?
    private var sessions: [Session] = []
    /// Menu items are rebuilt on open, but the TITLE has to stay honest while the menu is
    /// closed — a "waiting 3h12m" that froze an hour ago is worse than no countdown at all.
    private var isMenuOpen = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        let menu = NSMenu()
        menu.delegate = self
        item.menu = menu
        statusItem = item

        refresh()
        // 5s matches the monitor's own default poll, so the bar is never more than one tick
        // behind what the daemon knows. Cheap: a directory read plus one pgrep.
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            self?.refresh()
        }
        ensureAlwaysOnPieces()
    }

    private static let didFirstRunSetupKey = "didFirstRunSetup"

    /// The reconcile timer is plumbing, not a preference — a monitor that stays dead after it
    /// crashes is nobody's idea of a setting — so it is kept installed on every launch.
    ///
    /// Launch at login is a genuine preference and stays a menu toggle. It is only ever set
    /// HERE on the very first run, because "enable it if it isn't enabled" would run on every
    /// launch and silently undo the user turning it off — the toggle would appear to work and
    /// then revert by morning. A first-run flag is what makes ON a default rather than a
    /// policy. Failures are ignored: the app works without either.
    private func ensureAlwaysOnPieces() {
        DispatchQueue.global(qos: .utility).async {
            if !Controller.timerInstalled { _ = Controller.setTimer(enabled: true) }

            let defaults = UserDefaults.standard
            if !defaults.bool(forKey: Self.didFirstRunSetupKey) {
                defaults.set(true, forKey: Self.didFirstRunSetupKey)
                if SMAppService.mainApp.status == .notRegistered {
                    _ = Controller.setLaunchAtLogin(true)
                }
            }
        }
    }

    // MARK: - Status bar face

    /// `full` adds the sessions that have no monitor at all — the ones switched off. That
    /// costs a reconcile --dry-run, so the 5-second bar refresh does without it and only the
    /// menu (which has to offer their toggle) pays for it.
    private func refresh(full: Bool = false) {
        sessions = full ? Snapshot.loadFull() : Snapshot.load()
        guard let button = statusItem?.button else { return }

        let live = sessions.filter { $0.isLive }
        let attention = live.filter { $0.health == .attention }
        let waiting = live.filter { $0.health == .waiting }
        let busy = live.filter { $0.health == .working }
        let dead = sessions.filter { !$0.isLive }

        // The mark is constant — it is the app's identity, and an icon that morphs is hard to
        // find again in a crowded menu bar. State rides on the label next to it, plus colour
        // for the one case that needs to interrupt you.
        let image: NSImage
        let label: String
        if !attention.isEmpty {
            image = Icon.attention
            label = "\(attention.count)"
        } else if !busy.isEmpty {
            image = Icon.normal
            label = "…"                                   // compacting / backing off
        } else if let soonest = waiting.compactMap({ $0.deadline }).min() {
            image = Icon.normal
            label = Session.short(soonest)                // "3h12m"
        } else if !live.isEmpty {
            image = Icon.normal
            label = live.count > 1 ? "\(live.count)" : ""
        } else {
            // Nothing being watched — whether that is "no sessions" or "monitors died" is a
            // distinction the menu makes; the bar just recedes.
            image = Icon.dimmed
            label = dead.isEmpty ? "" : "!"
        }

        button.image = image
        button.imagePosition = label.isEmpty ? .imageOnly : .imageLeading
        button.title = label.isEmpty ? "" : " \(label)"

        if isMenuOpen, let menu = statusItem?.menu { rebuild(menu) }
    }

    // MARK: - Menu

    func menuWillOpen(_ menu: NSMenu) {
        isMenuOpen = true
        refresh(full: true)
        rebuild(menu)
    }

    func menuDidClose(_ menu: NSMenu) { isMenuOpen = false }

    /// The whole menu: what each session is doing, one checkbox per session for whether it
    /// resumes after a limit, what happened last, and two app settings. The reconcile timer
    /// is deliberately absent — it is plumbing, not a preference — and the repair action
    /// lives behind the Option key rather than in front of someone who only wants to know
    /// whether their work is still moving.
    private func rebuild(_ menu: NSMenu) {
        menu.removeAllItems()
        // Drop seeded-but-unedited session prompts before drawing, so "Custom prompt" is
        // unticked for a session that only ever had the editor opened on it.
        SessionPrompt.pruneUnedited(sessions)

        // 1. Every Claude session, what it is doing, and its one setting.
        if sessions.isEmpty {
            let empty = NSMenuItem(title: "No Claude sessions running", action: nil, keyEquivalent: "")
            empty.isEnabled = false
            menu.addItem(empty)
        } else {
            for session in sessions {
                menu.addItem(sessionItem(session))
                // An indented second line per session, rather than the held-Option alternate
                // this started as. Hiding it behind a modifier kept the menu shorter, but a
                // per-session prompt is no use if nothing tells you it exists. It earns the
                // line by reporting STATE as well as offering the action — which prompt this
                // session will actually be sent is not otherwise visible anywhere.
                if session.claudePid != nil {
                    let item = NSMenuItem(title: "Custom prompt",
                                          action: #selector(editSessionPrompt(_:)), keyEquivalent: "")
                    item.target = self
                    item.representedObject = session
                    item.indentationLevel = 1
                    item.state = SessionPrompt.isCustom(for: session) ? .on : .off
                    item.toolTip = "Click to edit what this session is sent when it resumes. "
                                 + "Unchanged from the shared prompt means it just uses that."
                    menu.addItem(item)
                }
            }
        }

        menu.addItem(.separator())

        // 2. The last thing that happened to your work — the answer to "did it fire while I
        //    was asleep?", which the session rows cannot give because they only show NOW.
        //    It is also the way into the log, so there is no separate "Open Log" item: on a
        //    quiet day this line degrades to exactly that button rather than disappearing and
        //    leaving the menu a different shape each time you open it.
        let event = Controller.lastEvent()
        let log = NSMenuItem(title: event.map { Self.tidy("\($0.age)  ·  \($0.message)") } ?? "Open Log…",
                             action: #selector(openLog), keyEquivalent: "")
        log.target = self
        log.toolTip = event == nil ? "Nothing has happened yet today. Click to open the log."
                                   : "The last thing the monitor did. Click to open the full log."
        menu.addItem(log)

        // 3. The one real setting.
        add(menu, "Edit Shared Prompt…", #selector(openConfig),
            tooltip: "Sent when a session resumes, unless that session has its own "
                   + "(~/.claude-auto-retry.json)")

        // Repair tools, revealed by holding Option. isAlternate swaps an item for the one
        // above it while the modifier is held, so the default menu stays four lines long.
        let fix = NSMenuItem(title: "Fix Monitoring", action: #selector(restartAll), keyEquivalent: "")
        fix.target = self
        fix.isAlternate = true
        fix.keyEquivalentModifierMask = .option
        fix.toolTip = "Restart every monitor. Also how a change to the package's code takes effect."
        menu.addItem(fix)

        menu.addItem(.separator())

        let login = NSMenuItem(title: "Open at Login", action: #selector(toggleLaunchAtLogin), keyEquivalent: "")
        login.target = self
        login.state = Controller.launchAtLoginEnabled ? .on : .off
        menu.addItem(login)

        add(menu, "Quit", #selector(quit), key: "q")
    }

    /// One line per session: what it is doing, and a checkmark for the only per-session
    /// setting there is — whether it gets picked back up after a limit resets. Clicking
    /// toggles that.
    private func sessionItem(_ s: Session) -> NSMenuItem {
        let item = NSMenuItem(title: "\(s.displayName) — \(s.headline)",
                              action: #selector(toggleAutoResume(_:)), keyEquivalent: "")
        item.target = self
        item.representedObject = s
        item.state = s.autoResume ? .on : .off
        item.toolTip = s.autoResume
            ? "Resuming automatically after limits reset. Click to stop."
            : "Left alone. Click to resume it automatically after limits reset."
        if s.health == .attention {
            // The one state that should catch the eye. Colour is an addition to the wording,
            // never the only carrier of it — "stuck — needs you" already says so.
            item.attributedTitle = NSAttributedString(
                string: item.title,
                attributes: [.foregroundColor: NSColor.systemRed])
        }
        return item
    }

    // MARK: - Actions

    @objc private func restartAll() {
        Controller.restartAllMonitors()
        refresh()
    }

    @objc private func toggleAutoResume(_ sender: NSMenuItem) {
        guard let s = sender.representedObject as? Session else { return }
        // Both directions shell out (exclude-self, or reconcile after the file edit), which is
        // slow enough to freeze the menu bar if done inline. Refresh from the real state when
        // it finishes rather than optimistically flipping the checkmark.
        DispatchQueue.global(qos: .userInitiated).async {
            Controller.setAutoResume(!s.autoResume, for: s)
            DispatchQueue.main.async { self.refresh(full: true) }
        }
    }

    @objc private func toggleLaunchAtLogin() {
        // Report only the case the user has to act on: macOS can park the registration in
        // .requiresApproval, where the checkmark would otherwise claim success while nothing
        // actually happens at login.
        if let problem = Controller.setLaunchAtLogin(!Controller.launchAtLoginEnabled) {
            Controller.notify("Open at Login", problem)
        }
    }

    @objc private func editSessionPrompt(_ sender: NSMenuItem) {
        guard let s = sender.representedObject as? Session else { return }
        Controller.openSessionPrompt(s)
    }

    @objc private func openConfig() { Controller.openConfig() }
    @objc private func openLog() { Controller.open(Controller.todayLog) }
    @objc private func quit() { NSApp.terminate(nil) }

    // MARK: - Helpers

    private func add(_ menu: NSMenu, _ title: String, _ action: Selector, key: String = "", tooltip: String? = nil) {
        let item = NSMenuItem(title: title, action: action, keyEquivalent: key)
        item.target = self
        item.toolTip = tooltip
        menu.addItem(item)
    }


    /// Clip to something a menu can show without stretching to the width of a log line.
    /// Splitting the timestamp off is Controller.parse's job now.
    static func tidy(_ line: String) -> String {
        line.count > 90 ? String(line.prefix(89)) + "…" : line
    }
}
