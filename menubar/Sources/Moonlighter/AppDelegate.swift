import SwiftUI
import AppKit
import ServiceManagement

/// A session's row in the menu: a real checkbox. A menu item backed by a VIEW does not dismiss the
/// menu when it is clicked (a plain item always does), which is what lets several sessions be
/// switched on or off in a row without reopening the menu each time.
final class SessionCheckbox: NSButton {
    var session: Session?
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSMenuDelegate {
    private var statusItem: NSStatusItem?
    private var refreshTimer: Timer?
    private var sessions: [Session] = []
    /// Menu items are rebuilt on open, but the TITLE has to stay honest while the menu is
    /// closed — a "waiting 3h12m" that froze an hour ago is worse than no countdown at all.
    private var isMenuOpen = false
    /// Account-wide usage for the card and the bar. Refreshed by the app itself (not by a watched
    /// session's monitor), so it is there even when nothing is being watched.
    private var usage: Usage?
    private var usageLoading = true
    private var usageRefreshing = false
    private let model = PanelModel()
    private let popover = NSPopover()
    private let contextMenu = NSMenu()

    func applicationDidFinishLaunching(_ notification: Notification) {
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
        contextMenu.delegate = self
        statusItem = item
        // Left click opens the panel; right click (or ctrl-click) opens the plain menu.
        item.button?.target = self
        item.button?.action = #selector(statusClicked(_:))
        item.button?.sendAction(on: [.leftMouseUp, .rightMouseUp])
        setUpPanel()

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
        refreshUsage()
        Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in self?.refreshUsage() }
        ensureAlwaysOnPieces()
    }

    /// Reads the shared cache, asking the CLI for a fresh reading when it is older than `maxAge`
    /// (a headless `claude -p /usage`, about three seconds, no model call). Off the main thread.
    private func refreshUsage(maxAge: Int = 300) {
        if usageRefreshing { return }
        usageRefreshing = true
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let r = Controller.cli(["usage", "--max-age", "\(maxAge)"], timeout: 45)
            let parsed = r.status == 0 ? Usage.parse(r.out.split(separator: "\n").last.map(String.init) ?? "") : nil
            DispatchQueue.main.async {
                guard let self else { return }
                self.usageRefreshing = false
                self.usageLoading = false
                if let parsed {
                    for w in Usage.resetWindows(old: self.usage, new: parsed) {
                        Controller.banner("Claude \(w) limit reset", "Your \(w) limit is available again.")
                    }
                    self.usage = parsed
                }
                self.model.usage = self.usage
                self.model.loading = false
                self.apply(self.sessions)
            }
        }
    }

    // MARK: - Panel

    private func setUpPanel() {
        model.onToggle = { [weak self] s, on in self?.setAutoResume(s, on) }
        model.onToggleAll = { [weak self] in self?.toggleAll() }
        model.onRefresh = { [weak self] in self?.refresh(full: true); self?.refreshUsage(maxAge: 1) }
        model.onQuit = { NSApp.terminate(nil) }
        model.onEditSharedPrompt = { Controller.openConfig() }
        model.onEditSessionPrompt = { Controller.openSessionPrompt($0) }
        model.onFixMonitoring = { [weak self] in self?.restartAll() }
        model.onLaunchAtLogin = { [weak self] on in
            if let problem = Controller.setLaunchAtLogin(on) { Controller.notify("Open at Login", problem) }
            self?.model.launchAtLogin = Controller.launchAtLoginEnabled
        }
        let host = NSHostingController(rootView: PanelView(model: model))
        host.sizingOptions = [.preferredContentSize]
        popover.contentViewController = host
        popover.behavior = .transient
        popover.animates = true
    }

    @objc private func statusClicked(_ sender: NSStatusBarButton) {
        guard let button = statusItem?.button else { return }
        let event = NSApp.currentEvent
        if event?.type == .rightMouseUp || event?.modifierFlags.contains(.control) == true {
            popover.performClose(nil)
            statusItem?.menu = contextMenu
            button.performClick(nil)
            statusItem?.menu = nil
            return
        }
        if popover.isShown { popover.performClose(nil); return }
        model.launchAtLogin = Controller.launchAtLoginEnabled
        model.usage = usage
        model.loading = usageLoading
        refresh(full: true)
        refreshUsage(maxAge: 90)
        popover.show(relativeTo: button.bounds, of: button, preferredEdge: .minY)
        popover.contentViewController?.view.window?.makeKey()
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
            if let outcome = Controller.runSetup() {
                // Packaged app: setup did the wiring (shell function, timer, watchdog, command).
                if !outcome.tmuxFound { DispatchQueue.main.async { self.tmuxMissing = true; self.offerTmux() } }
            } else if !Controller.timerInstalled {
                _ = Controller.setTimer(enabled: true)   // source build: just keep the timer
            }

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

    /// tmux is what Moonlighter watches sessions through. Without it nothing works, so this is
    /// said plainly — once as a dialog at launch, and for as long as it stays true, as a menu row.
    private var tmuxMissing = false
    private var installingTmux = false

    // The open menu's session rows, so a refresh can update them IN PLACE. Replacing items under
    // an open menu is unreliable (and would yank a checkbox out from under the pointer).
    private var rowBoxes: [String: SessionCheckbox] = [:]
    private var rowPanes: [String] = []
    private var bulkItem: NSMenuItem?
    /// Panes with a toggle still being applied: a refresh arriving before the change lands would
    /// otherwise flip the checkbox back for a moment.
    private var pendingToggles: Set<String> = []

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
        model.sessions = loaded
        for (pane, _) in model.pending where !pendingToggles.contains(pane) { model.pending[pane] = nil }
        guard let button = statusItem?.button else { return }

        let (image, label) = Self.face(for: sessions, usage: usage)

        button.image = image
        button.imagePosition = label.isEmpty ? .imageOnly : .imageLeading
        let hot = (usage?.isHot ?? false) && sessions.allSatisfy { $0.health != .attention }
        button.attributedTitle = label.isEmpty ? NSAttributedString(string: "") : NSAttributedString(
            string: " \(label)", attributes: [.foregroundColor: hot ? NSColor.systemRed : NSColor.controlTextColor,
                                              .font: NSFont.menuBarFont(ofSize: 0)])

        if isMenuOpen, let menu = statusItem?.menu { refreshOpenMenu(menu) }
    }

    /// Updates an open menu without replacing its items when the set of sessions is unchanged.
    private func refreshOpenMenu(_ menu: NSMenu) {
        guard sessions.map(\.pane) == rowPanes else { rebuild(menu); return }
        for s in sessions {
            guard let box = rowBoxes[s.pane] else { continue }
            box.session = s
            if !pendingToggles.contains(s.pane) { style(box, for: s) }
        }
        bulkItem?.title = Self.bulkTitle(for: sessions)
    }

    /// What the bar shows for a set of sessions: the mark plus the text beside it. Static so
    /// `--dump` can print exactly what the live bar computes.
    ///
    /// The mark is constant — it is the app's identity, and an icon that morphs is hard to
    /// find again in a crowded menu bar. State rides on the label next to it, plus colour
    /// for the one case that needs to interrupt you.
    static func face(for sessions: [Session], usage: Usage? = nil) -> (NSImage, String) {
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
        // Nothing wrong: show how much of the limit is used (and the weekly figure once it
        // matters), whether or not any session is being watched.
        if let u = usage, !u.isEmpty {
            return (live.isEmpty ? Icon.dimmed : Icon.normal, u.barLabel)
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
        refreshUsage(maxAge: 90)
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

        if tmuxMissing {
            let warn = NSMenuItem(title: installingTmux ? "Installing tmux…" : "tmux isn't installed — click to fix",
                                  action: installingTmux ? nil : #selector(offerTmux), keyEquivalent: "")
            warn.target = self
            warn.attributedTitle = NSAttributedString(string: warn.title, attributes: [.foregroundColor: NSColor.systemRed])
            menu.addItem(warn)
            menu.addItem(.separator())
        }

        // 1. Terminal sessions — only the part of Moonlighter that watches `claude` in tmux. With none
        // being watched it steps back into a submenu, so the menu is just the usage card.
        rowBoxes = [:]
        rowPanes = sessions.map(\.pane)
        bulkItem = nil
        let anyLive = sessions.contains { $0.isLive }
        let sessionItems = NSMenu()
        let sessionTarget = anyLive ? menu : sessionItems
        if !sessions.isEmpty {
            let width = rowWidth(for: sessions)
            for session in sessions {
                sessionTarget.addItem(sessionItem(session, width: width))
            }
            if sessions.count > 1 {
                let all = NSMenuItem(title: Self.bulkTitle(for: sessions), action: #selector(toggleAll), keyEquivalent: "")
                all.target = self
                all.toolTip = "Switch automatic resume on (or off) for every session at once."
                sessionTarget.addItem(all)
                bulkItem = all
            }
            if let prompts = promptsItem() { sessionTarget.addItem(prompts) }
            if !anyLive {
                let parent = NSMenuItem(title: "Terminal Sessions (\(sessions.count)) — not watched", action: nil, keyEquivalent: "")
                parent.submenu = sessionItems
                menu.addItem(parent)
            }
        }

        if !sessions.isEmpty {
            menu.addItem(.separator())

            // 2. The one real setting.
            add(menu, "Edit Shared Prompt…", #selector(openConfig),
                tooltip: "Sent when a session resumes, unless that session has its own "
                       + "(~/.claude-auto-retry.json). Edits reach running sessions within a few seconds.")
        }

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

    /// "Dir — resumes in 3h12m", or just the name when there is nothing worth saying.
    private func rowTitle(_ s: Session) -> String {
        s.headline.isEmpty ? s.displayName : "\(s.displayName) — \(s.headline)"
    }

    private func rowWidth(for sessions: [Session]) -> CGFloat {
        let font = NSFont.menuFont(ofSize: 0)
        let widest = sessions.map { (rowTitle($0) as NSString).size(withAttributes: [.font: font]).width }.max() ?? 0
        return min(max(300, ceil(widest) + 58), 520)
    }

    private func style(_ box: SessionCheckbox, for s: Session) {
        box.state = s.autoResume ? .on : .off
        // Red is the one state that should catch the eye — never the only carrier of it: the
        // wording already says "stuck — needs you".
        let color: NSColor = s.health == .attention ? .systemRed : .labelColor
        box.attributedTitle = NSAttributedString(string: rowTitle(s), attributes: [
            .font: NSFont.menuFont(ofSize: 0), .foregroundColor: color,
        ])
    }

    /// One checkbox per session. See SessionCheckbox for why it is a view rather than a plain item.
    private func sessionItem(_ s: Session, width: CGFloat) -> NSMenuItem {
        let box = SessionCheckbox(frame: NSRect(x: 12, y: 1, width: width - 24, height: 20))
        box.setButtonType(.switch)
        box.target = self
        box.action = #selector(sessionToggled(_:))
        box.lineBreakMode = .byTruncatingTail
        box.toolTip = "Tick to pick this session back up automatically when a usage limit resets."
        box.session = s
        style(box, for: s)
        rowBoxes[s.pane] = box

        let row = NSView(frame: NSRect(x: 0, y: 0, width: width, height: 22))
        row.addSubview(box)
        let item = NSMenuItem()
        item.view = row
        return item
    }

    /// Which way "all" goes, and which sessions it needs to touch: any session that is off →
    /// turn everything ON; otherwise turn everything OFF.
    static func bulkPlan(for sessions: [Session]) -> (on: Bool, targets: [Session]) {
        let on = sessions.contains { !$0.autoResume }
        return (on, sessions.filter { $0.autoResume != on })
    }

    static func bulkTitle(for sessions: [Session]) -> String {
        bulkPlan(for: sessions).on ? "Resume All Sessions" : "Pause All Sessions"
    }

    /// Per-session prompts, in one submenu: with the sessions themselves now being checkbox rows
    /// there is no per-session submenu to hang them from. Only sessions with a Claude process
    /// can be sent a prompt.
    private func promptsItem() -> NSMenuItem? {
        let eligible = sessions.filter { $0.claudePid != nil }
        guard !eligible.isEmpty else { return nil }
        let sub = NSMenu()
        for s in eligible {
            let isCustom = SessionPrompt.isCustom(for: s)
            let edit = NSMenuItem(title: "\(s.displayName) — \(isCustom ? "Custom Prompt…" : "Shared Prompt…")",
                                  action: #selector(editSessionPrompt(_:)), keyEquivalent: "")
            edit.target = self
            edit.representedObject = s
            edit.state = isCustom ? .on : .off
            edit.toolTip = isCustom
                ? "This session is sent its own prompt, not the shared one, when it resumes. Click to edit it."
                : "This session is sent the shared prompt when it resumes. Click to give it its own."
            sub.addItem(edit)
            // Only offered once a session actually IS customised — the way back to the shared
            // prompt without having to retype its text.
            if isCustom {
                let revert = NSMenuItem(title: "     Use the shared prompt for \(s.displayName) instead",
                                        action: #selector(revertSessionPrompt(_:)), keyEquivalent: "")
                revert.target = self
                revert.representedObject = s
                sub.addItem(revert)
            }
        }
        let item = NSMenuItem(title: "Session Prompts", action: nil, keyEquivalent: "")
        item.submenu = sub
        return item
    }

    // MARK: - tmux

    /// Offers to install tmux with Homebrew when it can, and says exactly what to run when it can't.
    @objc private func offerTmux() {
        guard tmuxMissing, !installingTmux else { return }
        let alert = NSAlert()
        alert.messageText = "Moonlighter needs tmux"
        alert.alertStyle = .warning
        if Controller.brewPath != nil {
            alert.informativeText = "Moonlighter watches your Claude sessions through tmux, which isn't installed yet. "
                + "It can install it for you with Homebrew (about a minute)."
            alert.addButton(withTitle: "Install tmux")
            alert.addButton(withTitle: "Later")
            NSApp.activate(ignoringOtherApps: true)
            guard alert.runModal() == .alertFirstButtonReturn else { return }
            installingTmux = true
            DispatchQueue.global(qos: .userInitiated).async {
                let ok = Controller.installTmuxWithHomebrew()
                DispatchQueue.main.async {
                    self.installingTmux = false
                    if ok {
                        self.tmuxMissing = false
                        _ = Controller.reconcile()      // sessions already running can be picked up now
                        self.refresh(full: true)
                    } else {
                        Controller.notify("Couldn't install tmux", "Run this in Terminal, then reopen Moonlighter:\n\nbrew install tmux")
                    }
                }
            }
        } else {
            alert.informativeText = "Moonlighter watches your Claude sessions through tmux, which isn't installed. "
                + "Install Homebrew from brew.sh, then run this in Terminal:\n\nbrew install tmux\n\nand reopen Moonlighter."
            alert.addButton(withTitle: "OK")
            NSApp.activate(ignoringOtherApps: true)
            alert.runModal()
        }
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

    @objc private func sessionToggled(_ sender: SessionCheckbox) {
        guard let s = sender.session else { return }
        setAutoResume(s, sender.state == .on)     // the click already flipped it; this is the wish
    }

    private func setAutoResume(_ s: Session, _ on: Bool) {
        pendingToggles.insert(s.pane)
        model.pending[s.pane] = on
        // Both directions shell out (exclude-self, or reconcile after the file edit), which is
        // slow enough to freeze the menu bar if done inline. The menu stays open throughout.
        DispatchQueue.global(qos: .userInitiated).async {
            Controller.setAutoResume(on, for: [s])
            DispatchQueue.main.async {
                self.pendingToggles.remove(s.pane)
                self.refresh(full: true)
            }
        }
    }

    @objc private func toggleAll() {
        let plan = Self.bulkPlan(for: sessions)
        guard !plan.targets.isEmpty else { return }
        DispatchQueue.global(qos: .userInitiated).async {
            Controller.setAutoResume(plan.on, for: plan.targets)
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
