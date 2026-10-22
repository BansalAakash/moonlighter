import AppKit

/// Account-wide Claude usage, as published by `claude-auto-retry usage` (see src/session-reset.js).
/// Independent of which sessions are being watched: the app refreshes it itself.
struct Usage: Equatable {
    var sessionPercent: Int?
    var sessionResetAt: Date?
    var weeklyPercent: Int?
    var weeklyResetAt: Date?
    var checkedAt: Date?
    var plan: String?

    /// Percentages at or past this read as "about to run out" — red in the bar and the card.
    static let hotPercent = 90

    /// A window whose reset has already passed no longer describes anything: show "—", not an old figure.
    var sessionShown: Int? { Self.live(sessionPercent, resetAt: sessionResetAt) }
    var weeklyShown: Int? { Self.live(weeklyPercent, resetAt: weeklyResetAt) }

    private static func live(_ pct: Int?, resetAt: Date?) -> Int? {
        guard let pct else { return nil }
        if let resetAt, resetAt < Date() { return nil }
        return pct
    }

    var isEmpty: Bool { sessionShown == nil && weeklyShown == nil }

    static func parse(_ json: String) -> Usage? {
        guard let data = json.data(using: .utf8),
              let o = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        func date(_ key: String) -> Date? {
            guard let ms = (o[key] as? NSNumber)?.doubleValue, ms > 0 else { return nil }
            return Date(timeIntervalSince1970: ms / 1000)
        }
        func int(_ key: String) -> Int? { (o[key] as? NSNumber)?.intValue }
        return Usage(sessionPercent: int("percentUsed"), sessionResetAt: date("resetAt"),
                     weeklyPercent: int("weeklyPercentUsed"), weeklyResetAt: date("weeklyResetAt"),
                     checkedAt: date("checkedAt"), plan: o["plan"] as? String)
    }

    /// What goes beside the mark in the menu bar: "7%", or "7% · 85%ʷ" once the weekly figure is
    /// the one that matters (it outlasts any 5-hour wait).
    var barLabel: String {
        var parts: [String] = []
        if let s = sessionShown { parts.append("\(s)%") }
        if let w = weeklyShown, w >= 50 || sessionShown == nil { parts.append("\(w)%ʷ") }
        return parts.joined(separator: " · ")
    }

    /// Windows that were nearly used up and have since rolled over — worth telling the user their
    /// limit is back. A roll-over shows as the reset instant moving later by a real margin (not the
    /// few seconds of jitter between readings).
    static func resetWindows(old: Usage?, new: Usage) -> [String] {
        guard let old else { return [] }
        var out: [String] = []
        func rolled(_ pct: Int?, _ a: Date?, _ b: Date?) -> Bool {
            guard let pct, pct >= hotPercent, let a, let b else { return false }
            return b.timeIntervalSince(a) > 30 * 60
        }
        if rolled(old.sessionPercent, old.sessionResetAt, new.sessionResetAt) { out.append("5-hour") }
        if rolled(old.weeklyPercent, old.weeklyResetAt, new.weeklyResetAt) { out.append("weekly") }
        return out
    }

    var isHot: Bool { max(sessionShown ?? 0, weeklyShown ?? 0) >= Self.hotPercent }

    static func updatedText(_ at: Date?, now: Date = Date()) -> String {
        guard let at else { return "" }
        let s = Int(now.timeIntervalSince(at))
        if s < 90 { return "updated just now" }
        if s < 3600 { return "updated \(s / 60)m ago" }
        return "updated \(s / 3600)h ago"
    }

    /// "resets 23:40" within the day, "resets Sat 06:30" beyond it.
    static func resetText(_ at: Date?, now: Date = Date()) -> String {
        guard let at else { return "" }
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = Calendar.current.isDate(at, inSameDayAs: now) ? "HH:mm" : "EEE HH:mm"
        return "resets \(f.string(from: at))"
    }
}
