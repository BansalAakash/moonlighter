import Foundation

/// `AutoRetryBar --self-test` — checks the parts that can wedge or silently misread, without a
/// GUI or an XCTest toolchain (the package has no test target, and CI/CLT-only machines may not
/// ship XCTest). Prints one line per check and exits non-zero if any failed.
enum SelfTest {
    static func run() -> Int32 {
        var failures = 0
        func check(_ name: String, _ ok: Bool, _ detail: @autoclosure () -> String = "") {
            print("\(ok ? "ok  " : "FAIL") \(name)\(ok || detail().isEmpty ? "" : "  — \(detail())")")
            if !ok { failures += 1 }
        }

        // --- Shell.run: the timeout has to be real ---------------------------------------------
        let t0 = Date()
        let hung = Shell.run("/bin/sleep", ["30"], timeout: 1)
        let hungTook = Date().timeIntervalSince(t0)
        check("a hung child is stopped at the timeout", hungTook < 6 && hung.status == -1,
              "took \(String(format: "%.1f", hungTook))s, status \(hung.status)")

        let big = Shell.run("/bin/sh", ["-c", "yes | head -c 300000"], timeout: 10)
        check("300KB of stdout does not deadlock the reader", big.status == 0 && big.out.utf8.count == 300_000,
              "got \(big.out.utf8.count) bytes, status \(big.status)")

        let noisy = Shell.run("/bin/sh", ["-c", "head -c 300000 /dev/zero >&2; echo ok"], timeout: 10)
        check("a child flooding stderr does not block", noisy.status == 0 && noisy.out == "ok\n",
              "out \(noisy.out.debugDescription), status \(noisy.status)")

        let ok = Shell.run("/bin/echo", ["hello"])
        check("an ordinary command returns its output and status 0", ok.out == "hello\n" && ok.status == 0)

        let bad = Shell.run("/nonexistent/binary", [])
        check("a missing binary is reported, not thrown", bad.status == -1 && bad.out.isEmpty)

        let fail = Shell.run("/bin/sh", ["-c", "exit 3"])
        check("a failing command's exit status is preserved", fail.status == 3, "status \(fail.status)")

        // --- Model: countdown text and the snapshot contract -----------------------------------
        func short(_ seconds: TimeInterval) -> String { Session.short(Date().addingTimeInterval(seconds + 0.5)) }
        check("countdown: seconds", short(45) == "45s", short(45))
        check("countdown: minutes", short(12 * 60) == "12m", short(12 * 60))
        check("countdown: hours", short(3 * 3600 + 12 * 60) == "3h12m", short(3 * 3600 + 12 * 60))
        check("countdown: a weekly wait reads in days", short(3 * 86400 + 4 * 3600) == "3d4h", short(3 * 86400 + 4 * 3600))

        // A snapshot from a newer daemon (extra keys: pane, claudePid) must still decode.
        let json = #"{"status":"waiting","waitUntil":1,"updatedAt":2,"pollIntervalSeconds":5,"pane":"%3","claudePid":99}"#
        let decoded = try? JSONDecoder().decode(PaneStatus.self, from: Data(json.utf8))
        check("a snapshot with extra fields still decodes", decoded?.status == "waiting" && decoded?.updatedAt == 2)

        check("pane id is recovered from a status filename",
              Snapshot.paneId(fromFileName: "_private_tmp_tmux-501_default__12.json") == "%12")

        // --- tmux: the pane list has to survive a launchd-style (locale-less) environment ------
        check("tmux is invoked with -u (a locale-less GUI app otherwise gets '_' for every tab)",
              Tmux.listPanesArguments.first == "-u")
        let sample = "%3\tclaude-retry-1-2\t/private/tmp/tmux-501/default\t/Users/a/proj\t✳ Review\tstill title\n%4\ts\t/sock\t/p\tzsh\n"
        let parsed = Tmux.parsePanes(sample)
        check("pane list parses; a title containing a tab stays whole",
              parsed.count == 2 && parsed["%3"]?.title == "✳ Review\tstill title" && parsed["%3"]?.path == "/Users/a/proj")
        check("a line the locale mangled to underscores is skipped, not mis-parsed",
              Tmux.parsePanes("%3_claude-retry-1-2_/sock_/p_title\n").isEmpty)
        if let tmux = Tmux.binary {
            // End to end, in the environment that broke it: no LANG, no LC_*.
            let (out, status) = Shell.run("/usr/bin/env", ["-i", "HOME=\(NSHomeDirectory())", tmux] + Tmux.listPanesArguments)
            if status == 0, !out.isEmpty {
                check("against the real tmux server, with NO locale, every pane row still has its tab fields",
                      Tmux.parsePanes(out).count == out.split(separator: "\n").count,
                      "parsed \(Tmux.parsePanes(out).count) of \(out.split(separator: "\n").count) rows")
            } else {
                print("skip no tmux server running — end-to-end pane-list check")
            }
        }

        // --- Icon -------------------------------------------------------------------------------
        check("the menu bar mark is 16pt and a template", Icon.normal.size == NSSize(width: 16, height: 16) && Icon.normal.isTemplate)

        print(failures == 0 ? "all checks passed" : "\(failures) check(s) failed")
        return failures == 0 ? 0 : 1
    }
}
