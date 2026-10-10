import AppKit

/// The menu bar mark: Anthropic's Claude spark (menubar/Resources/claude-logo.svg, the same file
/// their VS Code extension ships and renders at icon size) with a small crescent moon tucked
/// into its lower-right corner. The spark alone was pixel-identical to Claude's own menu bar
/// icon, which made this app impossible to tell apart from it at a glance; the moon is the
/// "moonlighter" — it keeps working after hours — and is the only thing that differs.
/// build_app.sh copies the SVG into Contents/Resources at build time.
enum Icon {
    /// Menu bar images are sized in points and macOS renders them at the display's scale.
    /// 16pt leaves the ~2pt of vertical breathing room the system status items use.
    static let size = NSSize(width: 16, height: 16)

    // The badge, in units of the 16x16 design canvas (origin bottom-left); everything below scales
    // with the size asked for, so the same geometry serves the 16pt menu bar glyph and a 1024px
    // app icon. The halo is a knockout ring cut out of the spark so the crescent reads as its own
    // shape instead of smudging into the spark's arms; it is sized so the whole badge stays inside
    // the canvas.
    private static let badgeCenter = NSPoint(x: 11.9, y: 4.1)
    private static let haloRadius: CGFloat = 4.1
    private static let moonRadius: CGFloat = 3.1
    /// How far the "bite" circle sits from the moon's centre — up and to the right, so the
    /// crescent opens towards the spark rather than away from it.
    private static let biteOffset = NSPoint(x: 1.35, y: 1.05)
    private static let biteRadius: CGFloat = 2.6

    private static func circle(_ center: NSPoint, _ r: CGFloat) -> NSBezierPath {
        NSBezierPath(ovalIn: NSRect(x: center.x - r, y: center.y - r, width: r * 2, height: r * 2))
    }

    private static func loadSpark() -> NSImage {
        if let url = Bundle.main.url(forResource: "claude-logo", withExtension: "svg"),
           let image = NSImage(contentsOf: url) {
            return image
        }
        // build_app.sh always bundles the SVG; an empty image is a quiet degrade over a status bar
        // glyph rather than a crash if it's ever somehow missing.
        return NSImage(size: size)
    }

    /// The spark with the moon badge, drawn as vectors at `side` points square, the moon in
    /// `moon`. Transparent outside the mark.
    static func markImage(side: CGFloat, moon: NSColor) -> NSImage {
        let spark = loadSpark()
        let k = side / size.width                  // design units → points
        let image = NSImage(size: NSSize(width: side, height: side))
        image.lockFocus()
        spark.draw(in: NSRect(x: 0, y: 0, width: side, height: side), from: .zero, operation: .sourceOver, fraction: 1)

        let t = NSAffineTransform()
        t.scale(by: k)
        // Cut the halo out of the spark, then lay the crescent into the clearing.
        NSGraphicsContext.current?.compositingOperation = .destinationOut
        NSColor.black.set()
        t.transform(circle(badgeCenter, haloRadius)).fill()

        NSGraphicsContext.current?.compositingOperation = .sourceOver
        let crescent = NSImage(size: NSSize(width: side, height: side))
        crescent.lockFocus()
        moon.set()
        t.transform(circle(badgeCenter, moonRadius)).fill()
        NSGraphicsContext.current?.compositingOperation = .destinationOut
        NSColor.black.set()
        t.transform(circle(NSPoint(x: badgeCenter.x + biteOffset.x, y: badgeCenter.y + biteOffset.y), biteRadius)).fill()
        crescent.unlockFocus()
        crescent.draw(in: NSRect(x: 0, y: 0, width: side, height: side), from: .zero, operation: .sourceOver, fraction: 1)
        image.unlockFocus()
        return image
    }

    /// The menu bar mark. Everything below recolours or templates THIS, so all three states
    /// (normal, dimmed, attention) carry the same mark.
    private static let base: NSImage = markImage(side: size.width, moon: .black)

    /// The Finder / Dock icon: the mark on a dark warm rounded square, moon in cream. `px` is the
    /// pixel size (1024 for the iconset master). Follows the macOS icon grid: the body fills about
    /// 80% of the canvas, centred, with a soft shadow in the margin.
    static func renderAppIcon(to path: String, px: Int) -> Bool {
        let n = CGFloat(px)
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: px, pixelsHigh: px,
                                         bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                         isPlanar: false, colorSpaceName: .deviceRGB,
                                         bytesPerRow: 0, bitsPerPixel: 0),
              let ctx = NSGraphicsContext(bitmapImageRep: rep) else { return false }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = ctx
        ctx.imageInterpolation = .high

        let body = NSRect(x: n * 0.1, y: n * 0.1, width: n * 0.8, height: n * 0.8)
        let shape = NSBezierPath(roundedRect: body, xRadius: body.width * 0.2237, yRadius: body.width * 0.2237)
        NSGraphicsContext.saveGraphicsState()
        let shadow = NSShadow()
        shadow.shadowColor = NSColor.black.withAlphaComponent(0.35)
        shadow.shadowOffset = NSSize(width: 0, height: -n * 0.012)
        shadow.shadowBlurRadius = n * 0.025
        shadow.set()
        NSColor(red: 0.13, green: 0.10, blue: 0.09, alpha: 1).setFill()
        shape.fill()
        NSGraphicsContext.restoreGraphicsState()

        NSGradient(starting: NSColor(red: 0.27, green: 0.20, blue: 0.17, alpha: 1),
                   ending: NSColor(red: 0.10, green: 0.08, blue: 0.075, alpha: 1))?.draw(in: shape, angle: -90)

        let side = body.width * 0.66
        let mark = markImage(side: side, moon: NSColor(red: 0.98, green: 0.92, blue: 0.80, alpha: 1))
        mark.draw(in: NSRect(x: body.midX - side / 2, y: body.midY - side / 2, width: side, height: side),
                  from: .zero, operation: .sourceOver, fraction: 1)
        NSGraphicsContext.restoreGraphicsState()

        guard let data = rep.representation(using: .png, properties: [:]) else { return false }
        return (try? data.write(to: URL(fileURLWithPath: path))) != nil
    }

    /// Writes the composed mark (as the menu bar draws it: black on transparent) to a PNG at
    /// `scale`x, for `--render-icon`. Lets the badge be inspected at a size a human can see.
    static func renderPNG(to path: String, scale: Int) -> Bool {
        let w = Int(size.width) * scale, h = Int(size.height) * scale
        guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: w, pixelsHigh: h,
                                         bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                         isPlanar: false, colorSpaceName: .deviceRGB,
                                         bytesPerRow: 0, bitsPerPixel: 0),
              let ctx = NSGraphicsContext(bitmapImageRep: rep) else { return false }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = ctx
        ctx.imageInterpolation = .high
        // Light backing so the black mark is visible in a screenshot.
        NSColor(white: 0.93, alpha: 1).setFill()
        NSRect(x: 0, y: 0, width: w, height: h).fill()
        base.draw(in: NSRect(x: 0, y: 0, width: w, height: h), from: .zero, operation: .sourceOver, fraction: 1)
        NSGraphicsContext.restoreGraphicsState()
        guard let data = rep.representation(using: .png, properties: [:]) else { return false }
        return (try? data.write(to: URL(fileURLWithPath: path))) != nil
    }

    /// Repaints the mark as a flat colour at the given alpha, using its own shape as a mask:
    /// draw it, then fill the same rect with `.sourceAtop` so only its already-opaque pixels
    /// pick up the new colour. Standard AppKit recolour trick for an image that isn't (or
    /// shouldn't always be) a template.
    private static func recolored(_ color: NSColor, alpha: CGFloat = 1) -> NSImage {
        let image = NSImage(size: size)
        image.lockFocus()
        base.draw(in: NSRect(origin: .zero, size: size), from: .zero, operation: .sourceOver, fraction: 1)
        color.withAlphaComponent(alpha).set()
        NSRect(origin: .zero, size: size).fill(using: .sourceAtop)
        image.unlockFocus()
        return image
    }

    /// Cached, because refresh() runs every 5 seconds and these never change.
    ///
    /// Template mode: AppKit repaints a template image by its alpha channel alone, to match
    /// the menu bar's current light/dark/highlighted state — the source SVG's own fill
    /// colour is irrelevant once this is set, so the logo's real colour doesn't need
    /// stripping out first.
    static let normal: NSImage = {
        let img = (base.copy() as? NSImage) ?? base
        img.isTemplate = true
        return img
    }()

    /// Recoloured flat black at reduced alpha, THEN marked template — recolouring first is
    /// what makes the dimming apply to the logo's actual filled shape rather than fading a
    /// mark AppKit would otherwise repaint at full strength regardless of source alpha.
    static let dimmed: NSImage = {
        let img = recolored(.black, alpha: 0.45)
        img.isTemplate = true
        return img
    }()

    /// Carries its own colour (NOT a template) so it stays red regardless of menu bar
    /// appearance — the one state that should interrupt you.
    static let attention: NSImage = recolored(.systemRed)
}
