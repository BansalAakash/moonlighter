import AppKit

// `AutoRetryBar --dump` prints what the menu would show, then exits. The app is a menu-bar
// agent with no window, so without this there is no way to see what it actually read — an
// empty menu could equally mean "no sessions" or "the status directory moved". It is also how
// the reader is re-checked after any change to the daemon's status-file format.
// `AutoRetryBar --login-item on|off` is the menu toggle, without the menu. It exists because
// the interesting property of that toggle is what happens on the NEXT launch (turning it off
// must survive one), and a GUI-only switch cannot be exercised in a scripted check.
if let i = CommandLine.arguments.firstIndex(of: "--login-item") {
    let want = CommandLine.arguments.count > i + 1 ? CommandLine.arguments[i + 1] : ""
    guard want == "on" || want == "off" else {
        FileHandle.standardError.write(Data("usage: --login-item on|off\n".utf8))
        exit(2)
    }
    if let problem = Controller.setLaunchAtLogin(want == "on") {
        print(problem)
        exit(1)
    }
    print("login item: \(Controller.launchAtLoginDescription)")
    exit(0)
}

// `AutoRetryBar --auto-resume %1 on|off` is the per-session checkbox, without the menu. Same
// reason as --login-item: the interesting behaviour is what the daemon does afterwards, which
// a GUI-only control cannot be checked for in a script.
if let i = CommandLine.arguments.firstIndex(of: "--auto-resume") {
    let args = CommandLine.arguments
    guard args.count > i + 2, args[i + 1].hasPrefix("%"), ["on", "off"].contains(args[i + 2]) else {
        FileHandle.standardError.write(Data("usage: --auto-resume %<pane> on|off\n".utf8))
        exit(2)
    }
    let pane = args[i + 1]
    guard let session = Snapshot.loadFull().first(where: { $0.pane == pane }) else {
        FileHandle.standardError.write(Data("no Claude session in pane \(pane)\n".utf8))
        exit(1)
    }
    Controller.setAutoResume(args[i + 2] == "on", for: session)
    let after = Snapshot.loadFull().first(where: { $0.pane == pane })
    print("\(pane) auto-resume: \(after?.autoResume == true ? "ON" : "OFF")")
    exit(0)
}

if CommandLine.arguments.contains("--dump") {
    let sessions = Snapshot.loadFull()
    print("status dir : \(Snapshot.statusDir.path)")
    print("today's log: \(Controller.todayLog.path)")
    print("tmux       : \(Tmux.binary ?? "NOT FOUND")")
    print("timer      : \(Controller.timerInstalled ? "installed" : "not installed")")
    print("login item : \(Controller.launchAtLoginDescription)")
    print("sessions   : \(sessions.count)")
    for s in sessions {
        print("""

          \(s.pane)  \(s.displayName)
            headline : \(s.headline)
            auto-resume: \(s.autoResume ? "ON" : "OFF")
            status   : \(s.status.status)   live: \(s.isLive)   stale: \(s.isStale)   gaveUp: \(s.status.gaveUp ?? false)
            claude   : \(s.claudePid.map(String.init) ?? "-")   monitor: \(s.monitorPid.map(String.init) ?? "-")
            deadline : \(s.deadline.map { "in \(Session.short($0))" } ?? "-")
            prompt   : \(SessionPrompt.file(for: s)?.path ?? "-")\(SessionPrompt.isCustom(for: s) ? "  [CUSTOM]" : "")
        """)
    }
    print("\nlast event: \(Controller.lastEvent().map { "\($0.age)  ·  \($0.message)" } ?? "(nothing recent)")")
    exit(0)
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.run()
