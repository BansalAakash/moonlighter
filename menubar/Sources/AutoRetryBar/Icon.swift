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

    // The badge, in points on the 16x16 canvas (origin bottom-left). The halo is a knockout ring
    // cut out of the spark so the crescent reads as its own shape instead of smudging into the
    // spark's arms at this size; it is sized so the whole badge stays inside the canvas.
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

    /// A filled crescent, as its own image: a disc with a second disc bitten out of it.
    private static let crescent: NSImage = {
        let image = NSImage(size: size)
        image.lockFocus()
        NSColor.black.set()
        circle(badgeCenter, moonRadius).fill()
        NSGraphicsContext.current?.compositingOperation = .destinationOut
        circle(NSPoint(x: badgeCenter.x + biteOffset.x, y: badgeCenter.y + biteOffset.y), biteRadius).fill()
        image.unlockFocus()
        return image
    }()

    /// The spark with the moon badge. Everything below recolours or templates THIS, so all three
    /// states (normal, dimmed, attention) carry the same mark.
    private static let base: NSImage = {
        let spark: NSImage
        if let url = Bundle.main.url(forResource: "claude-logo", withExtension: "svg"),
           let image = NSImage(contentsOf: url) {
            image.size = size
            spark = image
        } else {
            // build_app.sh always bundles the SVG; an empty image is a quiet degrade over a
            // status bar glyph rather than a crash if it's ever somehow missing.
            spark = NSImage(size: size)
        }
        let composed = NSImage(size: size)
        composed.lockFocus()
        spark.draw(in: NSRect(origin: .zero, size: size), from: .zero, operation: .sourceOver, fraction: 1)
        // Cut the halo out of the spark, then lay the crescent into the clearing.
        NSGraphicsContext.current?.compositingOperation = .destinationOut
        NSColor.black.set()
        circle(badgeCenter, haloRadius).fill()
        NSGraphicsContext.current?.compositingOperation = .sourceOver
        crescent.draw(in: NSRect(origin: .zero, size: size), from: .zero, operation: .sourceOver, fraction: 1)
        composed.unlockFocus()
        return composed
    }()

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
