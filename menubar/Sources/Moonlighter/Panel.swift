import SwiftUI
import AppKit

/// Everything the popover shows, and what its controls do. The app delegate fills it in and owns
/// the actions; the views only read it.
final class PanelModel: ObservableObject {
    @Published var usage: Usage?
    @Published var loading = true
    @Published var sessions: [Session] = []
    @Published var pending: [String: Bool] = [:]       // a toggle just flipped, still being applied
    @Published var launchAtLogin = false

    var onToggle: (Session, Bool) -> Void = { _, _ in }
    var onToggleAll: () -> Void = {}
    var onRefresh: () -> Void = {}
    var onQuit: () -> Void = {}
    var onEditSharedPrompt: () -> Void = {}
    var onEditSessionPrompt: (Session) -> Void = { _ in }
    var onFixMonitoring: () -> Void = {}
    var onLaunchAtLogin: (Bool) -> Void = { _ in }
}

private let brand = Color(red: 0.851, green: 0.467, blue: 0.341)          // Claude's orange
private let brandLight = Color(red: 0.93, green: 0.64, blue: 0.5)

struct ClaudeSpark: Shape {
    func path(in rect: CGRect) -> Path {
        Path(ClaudeMark.cgPath(size: min(rect.width, rect.height)))
    }
}

struct UsageBar: View {
    let percent: Int
    var body: some View {
        let hot = percent >= Usage.hotPercent
        GeometryReader { g in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.primary.opacity(0.12))
                Capsule()
                    .fill(LinearGradient(colors: hot ? [.orange, .red] : [brand, brandLight],
                                         startPoint: .leading, endPoint: .trailing))
                    .frame(width: max(g.size.height, g.size.width * CGFloat(min(percent, 100)) / 100))
            }
        }
        .frame(height: 10)
    }
}

struct WindowRow: View {
    let title: String
    let reset: String
    let percent: Int?

    var body: some View {
        HStack(alignment: .center, spacing: 14) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.system(size: 15, weight: .semibold))
                Text(reset).font(.system(size: 12)).foregroundStyle(.secondary)
            }
            .frame(width: 96, alignment: .leading)
            if let p = percent {
                UsageBar(percent: p)
                Text("\(p)%")
                    .font(.system(size: 17, weight: .semibold)).monospacedDigit()
                    .foregroundStyle(p >= Usage.hotPercent ? Color.red : Color.primary)
                    .frame(width: 48, alignment: .trailing)
            } else {
                Capsule().fill(Color.primary.opacity(0.12)).frame(height: 10)
                Text("—").font(.system(size: 17, weight: .semibold)).foregroundStyle(.tertiary)
                    .frame(width: 48, alignment: .trailing)
            }
        }
    }
}

struct ClaudeCard: View {
    @ObservedObject var model: PanelModel

    private var plan: String {
        guard let p = model.usage?.plan, !p.isEmpty else { return "Claude Code" }
        return "Claude Code · \(p.prefix(1).uppercased() + p.dropFirst())"
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .center, spacing: 12) {
                ClaudeSpark().fill(brand).frame(width: 34, height: 34)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Claude").font(.system(size: 19, weight: .semibold))
                    Text(plan).font(.system(size: 13)).foregroundStyle(.secondary)
                }
                Spacer()
                Text(model.usage?.checkedAt != nil ? Usage.updatedText(model.usage?.checkedAt)
                     : (model.loading ? "reading usage…" : ""))
                    .font(.system(size: 12)).foregroundStyle(.tertiary)
            }
            if let u = model.usage, !u.isEmpty {
                WindowRow(title: "5-hour", reset: Usage.resetText(u.sessionResetAt), percent: u.sessionShown)
                WindowRow(title: "Week", reset: Usage.resetText(u.weeklyResetAt), percent: u.weeklyShown)
            } else if !model.loading {
                Text("Usage isn't available yet. Sign in to Claude Code, then reopen this.")
                    .font(.system(size: 12)).foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, 20).padding(.vertical, 18)
    }
}

struct SessionsSection: View {
    @ObservedObject var model: PanelModel

    private var anyLive: Bool { model.sessions.contains { $0.isLive } }
    private func isOn(_ s: Session) -> Bool { model.pending[s.pane] ?? s.autoResume }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Terminal sessions").font(.system(size: 13, weight: .semibold))
                Text(anyLive ? "resumed after a limit resets" : "none watched")
                    .font(.system(size: 12)).foregroundStyle(.tertiary)
                Spacer()
                if model.sessions.count > 1 {
                    Button(AppDelegate.bulkTitle(for: model.sessions).replacingOccurrences(of: " Sessions", with: ""), action: model.onToggleAll)
                        .buttonStyle(.plain).font(.system(size: 12)).foregroundStyle(brand)
                }
            }
            ForEach(model.sessions, id: \.pane) { s in
                HStack(spacing: 10) {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(s.displayName).font(.system(size: 13)).lineLimit(1)
                        if !s.headline.isEmpty {
                            Text(s.headline).font(.system(size: 11))
                                .foregroundStyle(s.health == .attention ? Color.red : Color.secondary).lineLimit(1)
                        }
                    }
                    Spacer(minLength: 8)
                    Toggle("", isOn: Binding(get: { isOn(s) }, set: { model.onToggle(s, $0) }))
                        .toggleStyle(.switch).controlSize(.mini).labelsHidden()
                        .tint(brand)
                }
            }
        }
        .padding(.horizontal, 20).padding(.vertical, 14)
    }
}

struct Footer: View {
    @ObservedObject var model: PanelModel

    var body: some View {
        HStack(spacing: 14) {
            Button(action: model.onRefresh) { Label("Refresh", systemImage: "arrow.clockwise") }
                .buttonStyle(.plain).lineLimit(1).fixedSize()
            Spacer()
            Toggle("Launch at Login", isOn: Binding(get: { model.launchAtLogin }, set: { model.onLaunchAtLogin($0) }))
                .toggleStyle(.switch).controlSize(.mini).tint(brand).lineLimit(1).fixedSize()
            Spacer()
            Menu {
                Button("Edit Shared Prompt…", action: model.onEditSharedPrompt)
                ForEach(model.sessions.filter { $0.claudePid != nil }, id: \.pane) { s in
                    Button("Prompt for \(s.displayName)…") { model.onEditSessionPrompt(s) }
                }
                Button("Fix Monitoring", action: model.onFixMonitoring)
            } label: { Image(systemName: "ellipsis.circle") }
                .menuStyle(.borderlessButton).menuIndicator(.hidden).fixedSize()
            Button("Quit", action: model.onQuit).buttonStyle(.plain).lineLimit(1).fixedSize()
        }
        .font(.system(size: 13))
        .padding(.horizontal, 20).padding(.vertical, 12)
    }
}

struct PanelView: View {
    @ObservedObject var model: PanelModel
    static let width: CGFloat = 380

    var body: some View {
        VStack(spacing: 0) {
            ClaudeCard(model: model)
            if !model.sessions.isEmpty {
                Divider()
                SessionsSection(model: model)
            }
            Divider()
            Footer(model: model)
        }
        .frame(width: Self.width)
    }
}
