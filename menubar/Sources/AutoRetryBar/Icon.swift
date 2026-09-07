import AppKit

/// The menu bar mark, drawn in code rather than shipped as an asset so it stays crisp at any
/// scale factor and needs no bundle resources.
///
/// It is a radiating burst — the same visual family as Claude's mark, deliberately not the
/// same drawing. Claude's is an uneven fan of tapered spokes with no centre. This is a
/// symmetric eight-spoke star: four long axis spokes and four short diagonals, uniform
/// stroke, rounded caps, with an open centre. Close enough to read as "the Claude thing" in a
/// crowded menu bar, far enough not to pass as the real logo — which matters, because an icon
/// that IS the logo would misrepresent an unofficial tool as a first-party one.
enum Icon {
    /// Menu bar images are sized in points and macOS renders them at the display's scale.
    /// 16pt leaves the ~2pt of vertical breathing room the system status items use.
    static let size = NSSize(width: 16, height: 16)

    /// - Parameter template: when true the image adapts to light/dark and menu bar tinting.
    ///   The attention state passes false so it can carry its own colour.
    static func burst(template: Bool = true, color: NSColor = .black, alpha: CGFloat = 1) -> NSImage {
        let image = NSImage(size: size, flipped: false) { rect in
            let c = NSPoint(x: rect.midX, y: rect.midY)
            let long = rect.width * 0.46      // axis spokes reach near the edge
            let short = rect.width * 0.30     // diagonals stop well inside — the length
                                              // difference is what makes it a star rather
                                              // than a wheel at 16pt
            let inner = rect.width * 0.11     // open centre
            let path = NSBezierPath()
            path.lineWidth = rect.width * 0.115
            path.lineCapStyle = .round

            for i in 0..<8 {
                let angle = Double(i) * .pi / 4
                let outer = (i % 2 == 0) ? long : short
                path.move(to: NSPoint(x: c.x + CGFloat(cos(angle)) * inner,
                                      y: c.y + CGFloat(sin(angle)) * inner))
                path.line(to: NSPoint(x: c.x + CGFloat(cos(angle)) * outer,
                                      y: c.y + CGFloat(sin(angle)) * outer))
            }
            color.withAlphaComponent(alpha).setStroke()
            path.stroke()
            return true
        }
        image.isTemplate = template
        return image
    }

    /// Cached, because refresh() runs every 5 seconds and these never change.
    static let normal = burst()
    static let dimmed = burst(alpha: 0.45)
    static let attention = burst(template: false, color: .systemRed)
}
