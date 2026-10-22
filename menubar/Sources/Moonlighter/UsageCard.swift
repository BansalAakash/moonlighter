import AppKit

/// Account-wide Claude usage, as published by `claude-auto-retry usage` (see src/session-reset.js).
/// Independent of which sessions are being watched: the app refreshes it itself.
struct Usage: Equatable {
    var sessionPercent: Int?
    var sessionResetAt: Date?
    var weeklyPercent: Int?
    var weeklyResetAt: Date?
    var checkedAt: Date?

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
                     checkedAt: date("checkedAt"))
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

/// The card at the top of the menu: Claude's two windows as bars, in the spirit of an iOS widget.
final class UsageCardView: NSView {
    static let width: CGFloat = 320
    static let height: CGFloat = 150

    var usage: Usage? { didSet { if usage != oldValue { needsDisplay = true } } }
    var loading = true { didSet { needsDisplay = true } }

    private let brand = NSColor(srgbRed: 0.851, green: 0.467, blue: 0.341, alpha: 1)       // Claude's orange
    private let brandLight = NSColor(srgbRed: 0.93, green: 0.64, blue: 0.5, alpha: 1)

    init() { super.init(frame: NSRect(x: 0, y: 0, width: Self.width, height: Self.height)) }
    required init?(coder: NSCoder) { fatalError() }

    override var isFlipped: Bool { true }

    private func text(_ s: String, size: CGFloat, weight: NSFont.Weight = .regular, color: NSColor = .labelColor,
                      at p: NSPoint, rightAlignedTo right: CGFloat? = nil) {
        let a: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: size, weight: weight), .foregroundColor: color]
        let str = NSAttributedString(string: s, attributes: a)
        let x = right.map { $0 - str.size().width } ?? p.x
        str.draw(at: NSPoint(x: x, y: p.y))
    }

    override func draw(_ dirtyRect: NSRect) {
        let pad: CGFloat = 16
        let right = bounds.width - pad

        // Header: mark, name, how fresh the reading is.
        ClaudeMark.draw(in: NSRect(x: pad, y: 12, width: 26, height: 26), color: brand)
        text("Claude", size: 15, weight: .semibold, at: NSPoint(x: pad + 34, y: 11))
        text("Claude Code", size: 11, color: .secondaryLabelColor, at: NSPoint(x: pad + 34, y: 29))
        let status = usage?.checkedAt != nil ? Usage.updatedText(usage?.checkedAt) : (loading ? "reading usage…" : "")
        text(status, size: 11, color: .tertiaryLabelColor, at: NSPoint(x: 0, y: 14), rightAlignedTo: right)

        guard let u = usage, !u.isEmpty else {
            if !loading {
                text("Usage isn't available yet", size: 12, color: .secondaryLabelColor, at: NSPoint(x: pad, y: 70))
                text("Sign in to Claude Code, then reopen this menu.", size: 11, color: .tertiaryLabelColor, at: NSPoint(x: pad, y: 88))
            }
            return
        }
        row("5-hour", reset: Usage.resetText(u.sessionResetAt), percent: u.sessionShown, y: 56, pad: pad, right: right)
        row("Week", reset: Usage.resetText(u.weeklyResetAt), percent: u.weeklyShown, y: 102, pad: pad, right: right)
    }

    private func row(_ title: String, reset: String, percent: Int?, y: CGFloat, pad: CGFloat, right: CGFloat) {
        text(title, size: 13, weight: .semibold, at: NSPoint(x: pad, y: y))
        text(reset, size: 11, color: .secondaryLabelColor, at: NSPoint(x: pad, y: y + 18))

        let barX: CGFloat = 112, barW = right - 48 - barX, barH: CGFloat = 8, barY = y + 12
        let track = NSBezierPath(roundedRect: NSRect(x: barX, y: barY, width: barW, height: barH), xRadius: 4, yRadius: 4)
        NSColor.quaternaryLabelColor.setFill()
        track.fill()

        guard let p = percent else {
            text("—", size: 14, weight: .semibold, color: .tertiaryLabelColor, at: .zero, rightAlignedTo: right)
            return
        }
        let hot = p >= Usage.hotPercent
        let fillW = max(barH, barW * CGFloat(min(p, 100)) / 100)          // never thinner than the cap
        let fillRect = NSRect(x: barX, y: barY, width: p == 0 ? barH : fillW, height: barH)
        let fill = NSBezierPath(roundedRect: fillRect, xRadius: 4, yRadius: 4)
        let gradient = hot ? NSGradient(starting: .systemOrange, ending: .systemRed)
                           : NSGradient(starting: brand, ending: brandLight)
        NSGraphicsContext.saveGraphicsState()
        fill.addClip()
        gradient?.draw(in: fillRect, angle: 0)
        NSGraphicsContext.restoreGraphicsState()
        text("\(p)%", size: 14, weight: .semibold, color: hot ? .systemRed : .labelColor, at: NSPoint(x: 0, y: y + 8), rightAlignedTo: right)
    }
}
