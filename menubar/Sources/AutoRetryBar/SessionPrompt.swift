import Foundation

/// The per-session prompt override, from the app's side. `src/session-prompt.js` is the
/// daemon's side and owns the contract; this only has to agree with it about the filename.
///
///     ~/.claude-auto-retry/session-prompts/<socket>_<pane>_<claudePid>.txt
///
/// with every character outside [A-Za-z0-9_-] replaced by "_" (src/pane-key.js). The claude
/// PID in the name is what makes an override self-expiring and immune to tmux pane-id reuse:
/// when that session exits, its file matches nothing and can never be sent to a later one.
enum SessionPrompt {
    static var dir: URL { Snapshot.home.appending(path: ".claude-auto-retry/session-prompts") }

    /// The same rule as src/pane-key.js `sanitizeKey`.
    static func sanitize(_ key: String) -> String {
        String(key.map { c in
            (c.isLetter && c.isASCII) || (c.isNumber && c.isASCII) || c == "_" || c == "-" ? c : "_"
        })
    }

    /// nil when the session's claude PID is unknown — without it there is no reuse-proof key,
    /// and writing one keyed on the pane alone would be exactly the hazard the pid prevents.
    static func file(for session: Session) -> URL? {
        guard let pid = session.claudePid else { return nil }
        let name = "\(sanitize(session.socket))_\(sanitize(session.pane))_\(sanitize(String(pid))).txt"
        return dir.appending(path: name)
    }

    /// The same rule as src/session-prompt.js `normalize`, so both sides agree on when two
    /// prompts are "the same".
    static func normalize(_ s: String) -> String {
        s.trimmingCharacters(in: .whitespacesAndNewlines)
            .split(whereSeparator: { $0.isWhitespace }).joined(separator: " ")
    }

    /// A session's prompt counts as CUSTOM only once it differs from the shared one.
    ///
    /// The file is seeded with the shared prompt so there is something to edit, which meant a
    /// session read as "its own" the instant you opened it, having changed nothing. Worse, that
    /// seeded copy was a snapshot: editing the shared prompt afterwards would no longer reach a
    /// session that had never actually been customised. Defining custom as "differs" makes the
    /// label honest, and `pruneUnedited` makes the behaviour match the label.
    static func isCustom(for session: Session) -> Bool {
        guard let f = file(for: session),
              let text = try? String(contentsOf: f, encoding: .utf8) else { return false }
        let body = normalize(text)
        if body.isEmpty { return false }
        return body != normalize(globalMessage() ?? "")
    }

    /// Delete session prompts that are byte-identical to the shared one. Without this, opening
    /// the editor and changing nothing would leave a file behind that silently pins the session
    /// to today's shared text forever. Runs on every menu build; if the editor is open with
    /// unsaved changes, saving simply recreates the file.
    static func pruneUnedited(_ sessions: [Session]) {
        let shared = normalize(globalMessage() ?? "")
        guard !shared.isEmpty else { return }
        for s in sessions {
            guard let f = file(for: s),
                  let text = try? String(contentsOf: f, encoding: .utf8),
                  normalize(text) == shared else { continue }
            try? FileManager.default.removeItem(at: f)
        }
    }

    /// `usageLimitMessage` from ~/.claude-auto-retry.json, used to seed a new override. Parsed
    /// with JSONSerialization rather than a Decodable struct so an unrelated malformed key
    /// elsewhere in the file doesn't cost us the one string we want.
    static func globalMessage() -> String? {
        guard let data = try? Data(contentsOf: Snapshot.configFile),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else { return nil }
        return obj["usageLimitMessage"] as? String
    }
}
