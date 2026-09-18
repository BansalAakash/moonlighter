import AppKit

/// The menu bar mark: Anthropic's own Claude icon (menubar/Resources/claude-logo.svg, the
/// same file their VS Code extension ships and renders at icon size), not a hand-drawn
/// approximation of it. build_app.sh copies it into Contents/Resources at build time.
enum Icon {
    /// Menu bar images are sized in points and macOS renders them at the display's scale.
    /// 16pt leaves the ~2pt of vertical breathing room the system status items use.
    static let size = NSSize(width: 16, height: 16)

    private static let base: NSImage = {
        guard let url = Bundle.main.url(forResource: "claude-logo", withExtension: "svg"),
              let image = NSImage(contentsOf: url) else {
            // build_app.sh always bundles the SVG; an empty image is a quiet degrade over a
            // status bar glyph rather than a crash if it's ever somehow missing.
            return NSImage(size: size)
        }
        image.size = size
        return image
    }()

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
