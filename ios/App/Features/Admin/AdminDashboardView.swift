import Charts
import ChatAPI
import SwiftUI

/// The operator dashboard (`Route.admin`): lifetime totals, live health,
/// per-window activity and a daily timeline. Aggregates only — never a
/// per-user breakdown (a deliberate privacy rule, see CLAUDE.md).
struct AdminDashboardView: View {
    @Environment(AppEnvironment.self) private var env
    @State private var model: AdminStatsModel?

    var body: some View {
        Group {
            if let model {
                AdminDashboardContent(model: model)
            } else {
                Color.clear
            }
        }
        .navigationTitle("Admin")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear { if model == nil { model = AdminStatsModel(api: env.api) } }
    }
}

private struct AdminDashboardContent: View {
    @Environment(AppEnvironment.self) private var env
    @Bindable var model: AdminStatsModel

    var body: some View {
        Group {
            switch model.state {
            case .loading:
                List { SkeletonRows(count: 6) }.accessibilityIdentifier("admin.loading")
            case .forbidden:
                EmptyState(title: "Admins only", systemImage: "lock.shield",
                           message: "This dashboard shows platform-wide operational data, so it's limited to administrator accounts.",
                           identifier: "admin.forbidden")
            case .failed(let message):
                List {
                    ErrorBanner(message: "Could not load statistics: \(message)", retry: { Task { await model.load() } }, identifier: "admin.error")
                }
            case .loaded(let stats):
                dashboard(stats)
            }
        }
        .accessibilityIdentifier("admin.screen")
        .toolbar {
            ToolbarItem(placement: .primaryAction) {
                Button {
                    Task { await model.load() }
                } label: {
                    if model.isRefreshing { ProgressView() } else { Image(systemName: "arrow.clockwise") }
                }
                .accessibilityLabel("Refresh statistics")
                .accessibilityIdentifier("admin.refresh")
            }
        }
        // Loads, then refreshes every minute while the screen is up (like the web).
        .task(id: model.range) {
            while !Task.isCancelled {
                await model.load()
                try? await Task.sleep(for: .seconds(60))
            }
        }
    }

    private func dashboard(_ stats: AdminStats) -> some View {
        List {
            TotalsSection(totals: stats.totals, generatedAt: stats.generatedAt)
            HealthSection(health: stats.health)
            ActivitySection(activity: stats.activity)
            TimelineSection(timeline: stats.timeline, range: $model.range)
        }
        .refreshable { await model.load() }
    }
}

// MARK: tiles

private struct StatTile: View {
    let label: String
    let value: String
    var hint: String?
    var identifier: String

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label).font(.caption).foregroundStyle(.secondary)
            Text(value).font(.title3.weight(.semibold)).monospacedDigit()
                .minimumScaleFactor(0.7).lineLimit(1)
            // Every tile keeps the hint line, so a row of tiles lines up.
            Text(hint ?? " ").font(.caption2).foregroundStyle(.secondary).accessibilityHidden(hint == nil)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(Color(.tertiarySystemFill), in: RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier(identifier)
    }
}

private let tileColumns = [GridItem(.flexible(), spacing: 10), GridItem(.flexible(), spacing: 10)]

private struct TotalsSection: View {
    let totals: Components.Schemas.AdminTotals
    let generatedAt: Int

    var body: some View {
        Section {
            LazyVGrid(columns: tileColumns, spacing: 10) {
                StatTile(label: "Users", value: AdminFormat.count(totals.users),
                         hint: totals.admins == 1 ? "1 admin" : "\(AdminFormat.count(totals.admins)) admins", identifier: "admin.total.users")
                StatTile(label: "Posts", value: AdminFormat.count(totals.posts), identifier: "admin.total.posts")
                StatTile(label: "Comments", value: AdminFormat.count(totals.comments), identifier: "admin.total.comments")
                StatTile(label: "Reactions", value: AdminFormat.count(totals.reactions), identifier: "admin.total.reactions")
                StatTile(label: "Chats", value: AdminFormat.count(totals.chats), identifier: "admin.total.chats")
                StatTile(label: "Messages", value: AdminFormat.count(totals.messages), identifier: "admin.total.messages")
                StatTile(label: "Attachments", value: AdminFormat.count(totals.attachments),
                         hint: AdminFormat.bytes(totals.attachmentBytes), identifier: "admin.total.attachments")
            }
            .padding(.vertical, 4)
        } header: {
            HStack {
                Text("Totals")
                Spacer()
                Text("Updated \(Date(timeIntervalSince1970: TimeInterval(generatedAt) / 1000), format: .relative(presentation: .named))")
                    .textCase(nil)
                    .accessibilityIdentifier("admin.updated")
            }
        } footer: {
            Text("Everything on the platform since it launched.")
        }
    }
}

private struct HealthSection: View {
    let health: Components.Schemas.AdminRuntimeHealth

    var body: some View {
        let healthy = health.status == .ok
        Section {
            // Status is never color alone — icon plus word.
            Label(healthy ? "All systems go" : "Degraded", systemImage: healthy ? "heart.text.square" : "exclamationmark.triangle.fill")
                .font(.headline)
                .foregroundStyle(healthy ? Color.primary : Color.red)
                .accessibilityIdentifier("admin.health.status")
            ForEach(health.dependencies, id: \.name) { dependency in
                HStack(spacing: 8) {
                    Image(systemName: dependency.reachable ? "checkmark.circle.fill" : "xmark.octagon.fill")
                        .foregroundStyle(dependency.reachable ? .green : .red)
                        .accessibilityHidden(true)
                    Text(dependency.name == .database ? "Database" : "PubSub").fontWeight(.medium)
                    Text(dependency.backend).font(.caption).padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Color(.tertiarySystemFill), in: Capsule())
                    Spacer()
                    Text(dependency.reachable ? "reachable · \(Int(dependency.latencyMs ?? 0))ms" : "unreachable")
                        .font(.caption).foregroundStyle(dependency.reachable ? Color.secondary : Color.red)
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("admin.dependency.\(dependency.name.rawValue)")
            }
            LazyVGrid(columns: tileColumns, spacing: 10) {
                StatTile(label: "Requests served", value: AdminFormat.count(health.requestsTotal),
                         hint: "\(AdminFormat.percent(health.errorRate)) 5xx", identifier: "admin.health.requests")
                StatTile(label: "Server errors", value: AdminFormat.count(health.serverErrorsTotal),
                         hint: "since process start", identifier: "admin.health.errors")
                StatTile(label: "Rate-limited", value: AdminFormat.count(health.rateLimitRejectionsTotal),
                         hint: "requests rejected", identifier: "admin.health.rateLimited")
                StatTile(label: "Live sockets", value: AdminFormat.count(health.websocketConnections),
                         hint: "/ws connections open", identifier: "admin.health.sockets")
            }
            .padding(.vertical, 4)
        } header: {
            Text("Health")
        } footer: {
            Text("Instance up \(AdminFormat.uptime(health.uptimeSeconds)) · running v\(health.version). Counters are this server instance's — with several replicas, Prometheus is the deployment-wide view.")
        }
    }
}

private struct ActivitySection: View {
    let activity: [Components.Schemas.AdminActivityWindow]

    private let rows: [(label: String, hint: String?, pick: (Components.Schemas.AdminActivityWindow) -> Double)] = [
        ("Active users", "Posted, commented, reacted or messaged", { $0.activeUsers }),
        ("New users", nil, { $0.newUsers }),
        ("Posts", nil, { $0.newPosts }),
        ("Comments", nil, { $0.newComments }),
        ("Messages", nil, { $0.newMessages }),
        ("Reactions", nil, { $0.newReactions }),
    ]

    var body: some View {
        Section {
            Grid(alignment: .trailing, horizontalSpacing: 12, verticalSpacing: 10) {
                GridRow {
                    Text("").gridColumnAlignment(.leading)
                    ForEach(activity, id: \.window) { window in
                        Text(AdminFormat.windowLabel(window.window)).font(.caption.weight(.semibold)).foregroundStyle(.secondary)
                    }
                }
                ForEach(rows, id: \.label) { row in
                    Divider()
                    GridRow {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(row.label).font(.subheadline)
                            if let hint = row.hint { Text(hint).font(.caption2).foregroundStyle(.secondary) }
                        }
                        .gridColumnAlignment(.leading)
                        ForEach(activity, id: \.window) { window in
                            Text(AdminFormat.count(row.pick(window))).font(.subheadline).monospacedDigit()
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
            .padding(.vertical, 4)
            .accessibilityIdentifier("admin.activity")
        } header: {
            Text("Activity")
        } footer: {
            Text("What happened in each trailing window, as of now.")
        }
    }
}

// MARK: timeline chart

/// A series in the timeline chart. Colors are the web's (`admin.tsx`),
/// checked with the dataviz palette validator in both modes; text never
/// wears them.
private struct ActivitySeries: Identifiable, Sendable {
    let id: String
    let label: String
    let color: Color
    let pick: @Sendable (Components.Schemas.AdminTimelinePoint) -> Double

    static let content = [
        ActivitySeries(id: "posts", label: "Posts", color: Color(red: 0x39 / 255, green: 0x87 / 255, blue: 0xE5 / 255), pick: { $0.posts }),
        ActivitySeries(id: "comments", label: "Comments", color: Color(red: 0xD9 / 255, green: 0x59 / 255, blue: 0x26 / 255), pick: { $0.comments }),
        ActivitySeries(id: "messages", label: "Messages", color: Color(red: 0x19 / 255, green: 0x9E / 255, blue: 0x70 / 255), pick: { $0.messages }),
    ]
    static let signups = [
        ActivitySeries(id: "signups", label: "Signups", color: Color(red: 0x6B / 255, green: 0x6C / 255, blue: 0xEF / 255), pick: { $0.signups }),
    ]
}

private struct TimelineSection: View {
    let timeline: [Components.Schemas.AdminTimelinePoint]
    @Binding var range: Int

    var body: some View {
        Section {
            Picker("Range", selection: $range) {
                ForEach(AdminStatsModel.ranges, id: \.self) { Text("\($0)d").tag($0) }
            }
            .pickerStyle(.segmented)
            .accessibilityIdentifier("admin.range")
            VStack(alignment: .leading, spacing: 8) {
                Text("Content created").font(.subheadline.weight(.medium))
                ActivityChart(timeline: timeline, series: ActivitySeries.content, identifier: "admin.chart.content")
            }
            .padding(.vertical, 4)
            VStack(alignment: .leading, spacing: 8) {
                Text("Signups").font(.subheadline.weight(.medium))
                ActivityChart(timeline: timeline, series: ActivitySeries.signups, identifier: "admin.chart.signups")
            }
            .padding(.vertical, 4)
        } header: {
            Text("Over time")
        } footer: {
            Text("One bar per UTC day, oldest first. Touch a bar for that day's numbers.")
        }
    }
}

/// Stacked daily bars (one stack per day), with a touch-to-inspect readout.
private struct ActivityChart: View {
    let timeline: [Components.Schemas.AdminTimelinePoint]
    let series: [ActivitySeries]
    let identifier: String
    @State private var selected: Date?

    private struct Mark: Identifiable {
        let id: String
        let day: Date
        let series: ActivitySeries
        let value: Double
    }

    private var marks: [Mark] {
        timeline.flatMap { point -> [Mark] in
            guard let day = AdminFormat.day(point.date) else { return [] }
            return series.map { Mark(id: "\(point.date)-\($0.id)", day: day, series: $0, value: $0.pick(point)) }
        }
    }

    private var total: Double { timeline.reduce(0) { sum, point in sum + series.reduce(0) { $0 + $1.pick(point) } } }

    private var ceiling: Double {
        AdminFormat.niceCeiling(timeline.map { point in series.reduce(0) { $0 + $1.pick(point) } }.max() ?? 0)
    }

    private var selectedPoint: Components.Schemas.AdminTimelinePoint? {
        guard let selected else { return nil }
        return timeline.min { a, b in
            abs((AdminFormat.day(a.date) ?? .distantPast).timeIntervalSince(selected))
                < abs((AdminFormat.day(b.date) ?? .distantPast).timeIntervalSince(selected))
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            // A legend whenever there's more than one series (identity is
            // never color alone); a single series is named by its title.
            if series.count > 1 {
                HStack(spacing: 14) {
                    ForEach(series) { entry in
                        HStack(spacing: 5) {
                            RoundedRectangle(cornerRadius: 2).fill(entry.color).frame(width: 10, height: 10)
                            Text(entry.label).font(.caption).foregroundStyle(.secondary)
                        }
                    }
                }
                .accessibilityHidden(true)
            }
            readout
            Chart(marks) { mark in
                BarMark(
                    x: .value("Day", mark.day, unit: .day),
                    y: .value(mark.series.label, mark.value),
                    width: .ratio(0.7)
                )
                .foregroundStyle(mark.series.color)
                .cornerRadius(3)
                .opacity(selectedPoint == nil || AdminFormat.day(selectedPoint!.date) == mark.day ? 1 : 0.45)
            }
            .chartLegend(.hidden)
            .chartXAxis {
                AxisMarks(values: .automatic(desiredCount: 4)) { _ in
                    AxisValueLabel(format: .dateTime.month(.abbreviated).day(), centered: true)
                }
            }
            // Whole-number ticks at 0, half and a "nice" even ceiling (the web's scale).
            .chartYScale(domain: 0...ceiling)
            .chartYAxis {
                AxisMarks(position: .leading, values: [0, ceiling / 2, ceiling]) { value in
                    AxisGridLine(stroke: StrokeStyle(lineWidth: 0.5)).foregroundStyle(Color(.separator))
                    AxisValueLabel { Text(AdminFormat.count(value.as(Double.self) ?? 0)) }
                }
            }
            .chartXSelection(value: $selected)
            .frame(height: 170)
            .accessibilityLabel("\(series.map(\.label).joined(separator: ", ")) per day over the last \(timeline.count) days, \(AdminFormat.count(total)) in total")
            .accessibilityIdentifier(identifier)
        }
    }

    @ViewBuilder
    private var readout: some View {
        if let point = selectedPoint, let day = AdminFormat.day(point.date) {
            HStack(spacing: 10) {
                Text(day, format: .dateTime.month(.abbreviated).day())
                    .font(.caption.weight(.semibold))
                ForEach(series) { entry in
                    Text("\(entry.label) \(AdminFormat.count(entry.pick(point)))").font(.caption).monospacedDigit()
                }
            }
            .accessibilityElement(children: .combine)
        } else {
            Text("\(AdminFormat.count(total)) in \(timeline.count) days").font(.caption).foregroundStyle(.secondary)
        }
    }
}
