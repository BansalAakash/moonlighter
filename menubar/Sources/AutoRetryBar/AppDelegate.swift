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

        refresh(full: true)
        // 5s matches the monitor's own default poll, so the bar is never more than one tick
        // behind what the daemon knows. Cheap: a directory read plus one pgrep. Every 12th tick
        // (once a minute) is a FULL load, which also finds the sessions that are switched off —
        // see offSessions for why the menu needs that kept fresh in the background.
        var tick = 0
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 5, repeats: true) { [weak self] _ in
            tick += 1
            self?.refresh(full: tick % 12 == 0)
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
    ///
    /// The load runs OFF the main thread. It shells out (tmux, pgrep, and for `full` a login
    /// shell running node), and doing that inline meant any slow or hung child froze the whole
    /// menu bar — including opening the menu. The heartbeat stays here, on the main thread, on
    /// purpose: the watchdog treats it as proof the UI thread and timer are alive, which a
    /// background load completing could not tell it.
    private var loading = false
    private var fullPending = false

    /// The sessions that are switched off (no monitor, so no status file) as of the last FULL
    /// load. Finding them costs a login shell running node, so the 5-second refresh skips it —
    /// but the menu is drawn from whatever the last refresh produced, and an open NSMenu does
    /// not reliably redraw when its items are replaced a moment later. Without this, opening
    /// the menu showed only the monitored sessions and a switched-off one simply was not there.
    private var offSessions: [Session] = []

    /// Adds back the remembered switched-off sessions to a quick load, as long as their pane
    /// still exists and the quick load did not already find them (a session switched back on
    /// has a monitor again and arrives through the normal path).
    static func mergeOff(loaded: [Session], cachedOff: [Session], livePanes: Set<String>) -> [Session] {
        var out = loaded
        for s in cachedOff where livePanes.contains(s.pane) && !out.contains(where: { $0.pane == s.pane }) {
            out.append(s)
        }
        return out.sorted { $0.pane.compare($1.pane, options: .numeric) == .orderedAscending }
    }

    private func refresh(full: Bool = false) {
        Snapshot.writeHeartbeat()
        // One load at a time. A request that arrives mid-load is remembered (a full one must not
        // be dropped, or the menu would open without the switched-off sessions) and run after.
        if loading { fullPending = fullPending || full; return }
        loading = true
        let cachedOff = offSessions
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            var loaded = full ? Snapshot.loadFull() : Snapshot.load()
            if !full && !cachedOff.isEmpty {
                loaded = Self.mergeOff(loaded: loaded, cachedOff: cachedOff, livePanes: Set(Tmux.panes().keys))
            }
            DispatchQueue.main.async {
                guard let self else { return }
                self.loading = false
                if full { self.offSessions = loaded.filter { !$0.autoResume } }
                self.apply(loaded)
                if self.fullPending { self.fullPending = false; self.refresh(full: true) }
            }
        }
    }

    private func apply(_ loaded: [Session]) {
        sessions = loaded
        guard let button = statusItem?.button else { return }

        let (image, label) = Self.face(for: sessions)

        button.image = image
        button.imagePosition = label.isEmpty ? .imageOnly : .imageLeading
        button.title = label.isEmpty ? "" : " \(label)"

        if isMenuOpen, let menu = statusItem?.menu { rebuild(menu) }
    }

    /// What the bar shows for a set of sessions: the mark plus the text beside it. Static so
    /// `--dump` can print exactly what the live bar computes.
    ///
    /// The mark is constant — it is the app's identity, and an icon that morphs is hard to
    /// find again in a crowded menu bar. State rides on the label next to it, plus colour
    /// for the one case that needs to interrupt you.
    static func face(for sessions: [Session]) -> (NSImage, String) {
        let live = sessions.filter { $0.isLive }
        let attention = live.filter { $0.health == .attention }
        let waiting = live.filter { $0.health == .waiting }
        let busy = live.filter { $0.health == .working }
        let dead = sessions.filter { !$0.isLive }

        if !attention.isEmpty { return (Icon.attention, "\(attention.count)") }
        if !busy.isEmpty { return (Icon.normal, "…") }                       // compacting / backing off
        if let soonest = waiting.compactMap({ $0.deadline }).min() {
            return (Icon.normal, Session.short(soonest))                     // "3h12m"
        }
        // No active incident, but the passively-learned account-wide usage is available (see
        // sessionResetDeadline). Shown once here, not per session, so it never disappears just
        // because nothing is wrong.
        if let s = live.filter({ $0.sessionResetDeadline != nil })
            .min(by: { $0.sessionResetDeadline! < $1.sessionResetDeadline! }) {
            let d = s.sessionResetDeadline!
            if let used = s.status.sessionUsedPercent {
                return (Icon.normal, "\(max(0, 100 - used))% left · \(Session.short(d))")
            }
            return (Icon.normal, Session.short(d))
        }
        if !live.isEmpty { return (Icon.normal, live.count > 1 ? "\(live.count)" : "") }
        // Nothing being watched — whether that is "no sessions" or "monitors died" is a
        // distinction the menu makes; the bar just recedes.
        return (Icon.dimmed, dead.isEmpty ? "" : "!")
    }

    // MARK: - Menu

    func menuWillOpen(_ menu: NSMenu) {
        isMenuOpen = true
        refresh(full: true)
        rebuild(menu)
    }

    func menuDidClose(_ menu: NSMenu) { isMenuOpen = false }

    /// The whole menu: one plain-language line per session (its controls tucked in a submenu,
    /// see sessionSubmenu) and two app settings. There is deliberately no log line: the app is
    /// meant to run unattended, and an event nobody can act on is just noise. The reconcile timer is
    /// deliberately absent — it is plumbing, not a preference — and the repair action lives
    /// behind the Option key rather than in front of someone who only wants to know whether
    /// their work is still moving.
    private func rebuild(_ menu: NSMenu) {
        menu.removeAllItems()
        // Drop seeded-but-unedited session prompts before drawing, so "Custom Prompt" is
        // unticked for a session that only ever had the editor opened on it.
        SessionPrompt.pruneUnedited(sessions)

        // 1. Every Claude session and what it is doing right now.
        if sessions.isEmpty {
            let empty = NSMenuItem(title: "No Claude sessions running", action: nil, keyEquivalent: "")
            empty.isEnabled = false
            menu.addItem(empty)
        } else {
            for session in sessions {
                menu.addItem(sessionItem(session))
            }
        }

        menu.addItem(.separator())

        // 2. The one real setting.
        add(menu, "Edit Shared Prompt…", #selector(openConfig),
            tooltip: "Sent when a session resumes, unless that session has its own "
                   + "(~/.claude-auto-retry.json). Edits reach running sessions within a few seconds.")

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

    /// One line per session, purely informational: what it is doing, and (via the checkmark)
    /// whether it will be picked back up automatically. Nothing here is a click target — a row
    /// whose visible text is "Custom printer utility — running" gave no hint that clicking it
    /// actually flipped an unrelated setting, which is exactly the kind of thing a first-time
    /// user has no way to guess. The actual controls live one level down, in the submenu, each
    /// spelled out as a full sentence rather than a term ("auto-resume") nobody was told the
    /// meaning of.
    private func sessionItem(_ s: Session) -> NSMenuItem {
        let title = s.headline.isEmpty ? s.displayName : "\(s.displayName) — \(s.headline)"
        let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
        item.state = s.autoResume ? .on : .off
        if s.health == .attention {
            // The one state that should catch the eye. Colour is an addition to the wording,
            // never the only carrier of it — "stuck — needs you" already says so.
            item.attributedTitle = NSAttributedString(
                string: item.title,
                attributes: [.foregroundColor: NSColor.systemRed])
        }
        item.submenu = sessionSubmenu(s)
        return item
    }

    /// This session's controls, spelled out as sentences a first-time user can act on without
    /// having read a README: whether it resumes itself, and (only once there's a Claude process
    /// to send a prompt to) which prompt it gets and a one-click way back to the shared one.
    private func sessionSubmenu(_ s: Session) -> NSMenu {
        let sub = NSMenu()

        let resume = NSMenuItem(title: "Continue Automatically When Limit Resets",
                                action: #selector(toggleAutoResume(_:)), keyEquivalent: "")
        resume.target = self
        resume.representedObject = s
        resume.state = s.autoResume ? .on : .off
        sub.addItem(resume)

        if s.claudePid != nil {
            sub.addItem(.separator())
            let isCustom = SessionPrompt.isCustom(for: s)
            let prompt = NSMenuItem(title: isCustom ? "Custom Prompt" : "Shared Prompt",
                                    action: #selector(editSessionPrompt(_:)), keyEquivalent: "")
            prompt.target = self
            prompt.representedObject = s
            prompt.state = isCustom ? .on : .off
            prompt.toolTip = isCustom
                ? "This session is sent its own prompt, not the shared one, when it resumes. "
                + "Click to edit it."
                : "This session is sent the shared prompt when it resumes. Click to give it its own."
            sub.addItem(prompt)

            // Only offered once a session actually IS customised — the way back to the shared
            // prompt, without having to know (or retype) its exact text.
            if isCustom {
                let revert = NSMenuItem(title: "Use Shared Prompt Instead",
                                        action: #selector(revertSessionPrompt(_:)), keyEquivalent: "")
                revert.target = self
                revert.representedObject = s
                revert.toolTip = "Discard this session's own prompt; it goes back to the shared one."
                sub.addItem(revert)
            }
        }

        return sub
    }

    // MARK: - Actions

    @objc private func restartAll() {
        // Kills the monitors, waits, and re-arms them through a login shell — seconds of work
        // that must not run on the main thread.
        DispatchQueue.global(qos: .userInitiated).async {
            Controller.restartAllMonitors()
            DispatchQueue.main.async { self.refresh() }
        }
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

    @objc private func revertSessionPrompt(_ sender: NSMenuItem) {
        guard let s = sender.representedObject as? Session else { return }
        SessionPrompt.revert(for: s)
        refresh(full: true)
    }

    @objc private func openConfig() { Controller.openConfig() }
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
