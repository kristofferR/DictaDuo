import SottoDuoCore
import SottoDuoAPI
import SwiftUI

struct DevicePreferencesPage: View {
    @ObservedObject var controller: SottoDuoController

    var body: some View {
        DevicePreferencesForm(controller: controller, preferences: controller.preferences)
    }
}

private struct DevicePreferencesForm: View {
    @ObservedObject var controller: SottoDuoController
    @ObservedObject var preferences: ClientPreferencesStore
    @State private var endpoint = ""
    @State private var token = ""
    @State private var deviceName = ""
    @State private var showingDiagnostics = false

    var body: some View {
        Form {
            Section {
                TextField("Server address", text: $endpoint, prompt: Text("http://localhost:8391"))
                    .autocorrectionDisabled()
                    .accessibilityIdentifier("preferences.endpoint")
                SecureField("Access token", text: $token)
                    .accessibilityIdentifier("preferences.token")
                TextField("Device name", text: $deviceName)
                    .accessibilityIdentifier("preferences.device-name")
                HStack {
                    ServerConnectionStatus(controller: controller)
                    Button("Connect") {
                        controller.errorMessage = nil
                        controller.saveConnection(endpoint: endpoint, token: token, deviceName: deviceName)
                    }
                        .disabled(controller.isBusy || endpoint.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || deviceName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                        .accessibilityIdentifier("preferences.connect")
                }
                SottoDuoActionMessage(message: preferences.errorMessage ?? controller.errorMessage)
            } header: { Text("Connection").textCase(nil) }

            Section {
                Picker("Dictation key", selection: $controller.shortcut) {
                    ForEach(HoldKey.allCases) { key in Text(key.title).tag(key) }
                }
                .accessibilityIdentifier("preferences.shortcut")
                Picker("Trigger", selection: $controller.activationMode) {
                    ForEach(HotkeyActivationMode.allCases) { mode in Text(mode.title).tag(mode) }
                }
                .accessibilityIdentifier("preferences.activation")
                LabeledContent {
                    Button(controller.isCheckingShortcut ? "Stop checking" : "Check shortcut") {
                        if controller.isCheckingShortcut { controller.stopShortcutCheck() }
                        else { controller.startShortcutCheck(); showingDiagnostics = true }
                    }
                    .frame(width: 125)
                } label: {
                    Text(controller.isCheckingShortcut
                         ? (controller.activationMode == .doubleTapToggle ? "Double tap the key" : "Hold the key for a second")
                         : "Shortcut check")
                }
                if let note = controller.shortcut.note { Text(note).font(.caption).foregroundStyle(SottoDuoPalette.muted) }
                DisclosureGroup("Shortcut diagnostics", isExpanded: $showingDiagnostics) {
                    ScrollView {
                        Text(controller.shortcutCheckText.isEmpty ? "Run a shortcut check to see events." : controller.shortcutCheckText)
                            .font(.system(.caption, design: .monospaced))
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(height: 90)
                }
                Toggle("Mute system audio while recording", isOn: $controller.muteOutputWhileRecording)
                    .accessibilityIdentifier("preferences.mute-output")
                Toggle("Start \(SottoDuoBuild.current.displayName) at login", isOn: $controller.launchAtLogin)
                if let error = controller.loginItemError {
                    Text(error).font(.caption).foregroundStyle(SottoDuoPalette.warning)
                }
            } header: { Text("This Mac").textCase(nil) }
            .disabled(controller.isBusy)

            Section {
                PermissionRow(title: "Microphone", detail: "Capture audio while dictating.", granted: controller.permissions.microphone,
                              reviewGranted: true, action: controller.requestMicrophone)
                PermissionRow(title: "Accessibility", detail: "Recognize your dictation key and insert text.", granted: controller.permissions.accessibility,
                              reviewGranted: true, action: controller.requestAccessibility)
                HStack {
                    PermissionHelpButton()
                    Spacer()
                    Button("Check again") { controller.refreshPermissions() }
                }
            } header: { Text("Permissions").textCase(nil) }

            Section {
                HStack(spacing: 8) {
                    Text("\(SottoDuoBuild.current.displayName)").font(.headline)
                    Spacer()
                    if SottoDuoBuild.current.isDevelopment {
                        Text("Development build").foregroundStyle(SottoDuoPalette.muted)
                    } else {
                        Text(Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "")
                            .foregroundStyle(SottoDuoPalette.muted)
                    }
                }
                Text("Quitting this app leaves your server running.")
                    .font(.caption)
                    .foregroundStyle(SottoDuoPalette.muted)
            }
        }
        .formStyle(.grouped)
        .scrollContentBackground(.hidden)
        .toggleStyle(.switch)
        .frame(maxWidth: 760)
        .frame(maxWidth: .infinity)
        .onAppear {
            endpoint = preferences.endpoint
            token = preferences.token
            deviceName = preferences.deviceName
            controller.refreshPermissions()
        }
    }
}

struct ServerPreferencesPage: View {
    @ObservedObject var controller: SottoDuoController
    @State private var draft = ServerPreferences()
    @State private var base: PreferencesSnapshot?
    @State private var expandedLists = Set<String>()
    @State private var listPendingRemoval: String?
    @State private var showingModelDetails = false

    private var dirty: Bool { base.map { draft != $0.preferences } ?? false }
    /// The draft as saved. One replacement phrase per line: blank lines are editing leftovers, not phrases.
    private var cleanedDraft: ServerPreferences {
        var value = draft
        for list in value.dictionary.lists.indices {
            for entry in value.dictionary.lists[list].entries.indices {
                value.dictionary.lists[list].entries[entry].aliases.removeAll { $0.isEmpty }
            }
        }
        return value
    }
    private var changedRemotely: Bool {
        guard let base, let latest = controller.sharedPreferences else { return false }
        return dirty && base.revision != latest.revision
    }
    private var available: Bool { controller.sharedPreferences != nil && controller.serverHealth != nil }
    /// Offered only when the server has another engine installed and reports its selection.
    private var engineChoice: Bool {
        draft.recognitionEngine != nil && (controller.serverHealth?.recognitionEngines?.count ?? 0) > 1
    }
    private var installedEngines: [RecognitionEngine] { controller.serverHealth?.recognitionEngines ?? [] }
    /// Recognition runs locally with Parakeet, which ignores language and vocabulary.
    private var parakeet: Bool { draft.recognitionEngine == .parakeet && installedEngines.contains(.parakeet) }
    private var engine: Binding<RecognitionEngine> {
        Binding { draft.recognitionEngine ?? .whisper } set: { draft.recognitionEngine = $0 }
    }
    /// Whether Soniox is configured on the server. Nil from an older server.
    private var cloudAvailable: Bool? { controller.serverHealth?.cloudRecognition }
    private let languages = [
        ("English", "en"), ("Detect automatically", "auto"), ("Spanish", "es"), ("French", "fr"),
        ("German", "de"), ("Italian", "it"), ("Portuguese", "pt"), ("Dutch", "nl"), ("Japanese", "ja"),
        ("Chinese", "zh"), ("Korean", "ko"), ("Hindi", "hi"), ("Arabic", "ar"), ("Polish", "pl"),
        ("Russian", "ru"), ("Ukrainian", "uk"), ("Swedish", "sv"), ("Norwegian", "no")
    ]


    private func caption(_ text: String) -> some View {
        Text(text)
            .font(.caption)
            .foregroundStyle(SottoDuoPalette.muted)
            .fixedSize(horizontal: false, vertical: true)
    }
    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 12) {
                ServerConnectionStatus(controller: controller)
                Button("Discard changes") { loadLatest() }
                    .opacity(dirty ? 1 : 0)
                    .disabled(!dirty)
                Button("Save shared preferences") {
                    controller.errorMessage = nil
                    // The saved value must equal the draft, so the reply is recognized as this save.
                    draft = cleanedDraft
                    controller.updateSharedPreferences(draft, expectedRevision: base?.revision)
                }
                .buttonStyle(.borderedProminent)
                .disabled(!available || !dirty || changedRemotely || cleanedDraft.validationError != nil || controller.isSavingPreferences)
                .accessibilityIdentifier("preferences.save-shared")
            }
            .frame(height: 34)
            .padding(.horizontal, 28)
            .padding(.top, 24)
            .padding(.bottom, 10)

            HStack {
                SottoDuoActionMessage(message: changedRemotely
                    ? "Shared preferences changed on another device. Reload to continue."
                    : (cleanedDraft.validationError ?? controller.errorMessage))
                Button("Reload") { loadLatest() }
                    .opacity(changedRemotely ? 1 : 0)
                    .disabled(!changedRemotely)
            }
            .padding(.horizontal, 28)

            Form {
                if let health = controller.serverHealth {
                    Section {
                        modelsGroup(health)
                    } header: { Text("Server models").textCase(nil) }
                }
                Section {
                    VStack(alignment: .leading, spacing: 4) {
                        recognitionModePicker
                        if let modeCaption { caption(modeCaption) }
                    }
                    if engineChoice {
                        VStack(alignment: .leading, spacing: 4) {
                            Picker("Local engine", selection: engine) {
                                Text("Whisper large-v3-turbo").tag(RecognitionEngine.whisper)
                                Text("Parakeet v3").tag(RecognitionEngine.parakeet)
                            }
                            .accessibilityIdentifier("preferences.recognition-engine")
                            caption(parakeet
                                ? "Faster, but covers 25 European languages (not Norwegian) and ignores recognition vocabulary."
                                : "Parakeet v3 is faster but covers 25 European languages (not Norwegian) and ignores recognition vocabulary.")
                        }
                    } else if installedEngines.count == 1 {
                        VStack(alignment: .leading, spacing: 4) {
                            LabeledContent("Local engine",
                                           value: "\(installedEngines[0] == .parakeet ? "Parakeet v3" : "Whisper large-v3-turbo") (only engine installed)")
                            if installedEngines[0] == .whisper {
                                caption("Install Parakeet on the server to choose it. It is faster but covers 25 European languages (not Norwegian) and ignores recognition vocabulary.")
                            }
                        }
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        Picker("Language", selection: $draft.language) {
                            ForEach(languages, id: \.1) { name, code in Text(name).tag(code) }
                        }
                        if parakeet {
                            caption(draft.language == "no"
                                ? "Parakeet does not recognize Norwegian. Choose Whisper as the local engine for Norwegian."
                                : "Used for cloud recognition. Parakeet detects the language itself.")
                        }
                    }
                    Toggle("Clean up text after transcribing", isOn: $draft.textCorrectionEnabled)
                    VStack(alignment: .leading, spacing: 8) {
                        HStack {
                            Text("Text cleanup instructions")
                            Spacer()
                            Button("Reset to default") {
                                draft.proofreadingPrompt = ServerPreferences.defaultProofreadingPrompt
                            }
                            .disabled(draft.proofreadingPrompt == ServerPreferences.defaultProofreadingPrompt)
                            .accessibilityIdentifier("preferences.reset-cleanup-prompt")
                        }
                        TextEditor(text: $draft.proofreadingPrompt)
                            .font(.body)
                            .scrollContentBackground(.hidden)
                            .padding(7)
                            .frame(height: 352)
                            .background(SottoDuoPalette.surface, in: RoundedRectangle(cornerRadius: 6))
                            .overlay { RoundedRectangle(cornerRadius: 6).stroke(SottoDuoPalette.muted.opacity(0.25)) }
                            .accessibilityLabel("Text cleanup instructions")
                            .accessibilityIdentifier("preferences.cleanup-prompt")
                    }
                    VStack(alignment: .leading, spacing: 4) {
                        TextField("Recognition vocabulary", text: $draft.vocabulary, axis: .vertical)
                            .lineLimit(3...5)
                        caption(parakeet
                            ? "Parakeet ignores this list. Dictionary replacements and text cleanup still apply."
                            : "Names and specialized terms that help recognition.")
                    }
                } header: { Text("Processing").textCase(nil) }
                .disabled(!available)

                Section {
                    Toggle("Keep original microphone audio", isOn: $draft.keepOriginalAudio)
                        .accessibilityIdentifier("preferences.keep-original")
                    Text("Recognition audio is always kept. This also saves the original microphone audio for future dictations.")
                        .font(.caption)
                        .foregroundStyle(SottoDuoPalette.muted)
                } header: { Text("Shared history").textCase(nil) }
                .disabled(!available)

                Section {
                    dictionaryEditor
                } header: { Text("Dictionary").textCase(nil) }
                .disabled(!available)
            }
            .formStyle(.grouped)
            .scrollContentBackground(.hidden)
            .toggleStyle(.switch)
        }
        .frame(maxWidth: 800)
        .frame(maxWidth: .infinity)
        .onAppear {
            loadLatest()
            controller.refreshServer()
        }
        .onChange(of: controller.sharedPreferences) { old, latest in
            if base == nil || !dirty || latest?.preferences == draft {
                loadLatest()
            }
        }
    }

    @ViewBuilder private var dictionaryEditor: some View {
        Text("\(draft.dictionary.lists.reduce(0) { $0 + $1.entries.count }) of 500 words · up to 32 lists")
            .font(.caption)
            .foregroundStyle(SottoDuoPalette.muted)
        ForEach($draft.dictionary.lists) { $list in
            DisclosureGroup(isExpanded: Binding(
                get: { expandedLists.contains(list.id) },
                set: { if $0 { expandedLists.insert(list.id) } else { expandedLists.remove(list.id) } }
            )) {
                TextField("List name", text: $list.name)
                ForEach($list.entries) { $entry in
                    HStack(alignment: .top, spacing: 10) {
                        VStack(alignment: .leading, spacing: 8) {
                            TextField("Preferred spelling", text: $entry.term)
                            TextField("Replacement phrases, one per line (up to 8)", text: Binding(
                                get: { entry.aliases.joined(separator: "\n") },
                                set: { value in
                                    // One phrase per line, so a phrase may contain a comma.
                                    entry.aliases = value.isEmpty ? [] : value.components(separatedBy: .newlines)
                                        .map { $0.trimmingCharacters(in: .whitespaces) }
                                }
                            ), axis: .vertical)
                            .lineLimit(1...8)
                            .font(.caption)
                            .help("Use narrow phrases: preferred ‘auth middleware’, replace ‘off middleware’. Replacing ‘off’ alone also changes ordinary uses of that word.")
                        }
                        Toggle(isOn: $entry.isPriority) {
                            Image(systemName: entry.isPriority ? "star.fill" : "star")
                        }
                        .toggleStyle(.button)
                        .buttonStyle(.borderless)
                        .tint(SottoDuoPalette.accentInk)
                        .help("Priority words are suggested first when model space is limited.")
                        .accessibilityLabel("Prioritize \(entry.term.isEmpty ? "word" : entry.term)")
                        .accessibilityIdentifier("preferences.dictionary-priority.\(entry.id)")
                        Button {
                            list.entries.removeAll { $0.id == entry.id }
                        } label: { Image(systemName: "minus.circle") }
                            .buttonStyle(.borderless)
                            .help("Remove word")
                            .accessibilityLabel("Remove \(entry.term.isEmpty ? "word" : entry.term)")
                    }
                    .padding(.vertical, 6)
                }
                HStack {
                    Button("Add word") { list.entries.append(DictionaryEntry(term: "")) }
                    Spacer()
                    Button("Remove list", role: .destructive) { listPendingRemoval = list.id }
                }
                .padding(.top, 8)
            } label: {
                HStack {
                    Text(list.name.isEmpty ? "New list" : list.name)
                    Spacer()
                    Text("\(list.entries.count)").foregroundStyle(SottoDuoPalette.muted)
                }
            }
        }
        Button("Add list") {
            let list = DictionaryList(name: "New list")
            draft.dictionary.lists.append(list)
            expandedLists.insert(list.id)
        }
        .confirmationDialog(
            "Remove “\(draft.dictionary.lists.first { $0.id == listPendingRemoval }?.name ?? "list")”?",
            isPresented: Binding(get: { listPendingRemoval != nil }, set: { if !$0 { listPendingRemoval = nil } })
        ) {
            Button("Remove list", role: .destructive) {
                draft.dictionary.lists.removeAll { $0.id == listPendingRemoval }
                listPendingRemoval = nil
            }
        } message: {
            Text("Its words are removed when you save. Discard changes brings them back before then.")
        }
    }

    @ViewBuilder private var recognitionModePicker: some View {
        if let cloud = cloudAvailable {
            Picker("Recognition mode", selection: $draft.recognitionMode) {
                Text("Automatic").tag(RecognitionMode.automatic)
                Text(cloud ? "Cloud only" : "Cloud only (needs a Soniox API key on the server)")
                    .tag(RecognitionMode.cloud)
                    .disabled(!cloud)
                Text("Local only").tag(RecognitionMode.local)
            }
            .accessibilityIdentifier("preferences.recognition-mode")
        } else {
            // An older server does not report whether Soniox is configured.
            Picker("Recognition mode", selection: $draft.recognitionMode) {
                Text("Automatic (Soniox, with local fallback)").tag(RecognitionMode.automatic)
                Text("Cloud only (Soniox)").tag(RecognitionMode.cloud)
                Text("Local only").tag(RecognitionMode.local)
            }
            .help("Automatic uses Soniox when configured on the server. Local only never sends audio to Soniox.")
            .accessibilityIdentifier("preferences.recognition-mode")
        }
    }

    /// What the selected mode does on this server; engine names live here, not in the labels.
    private var modeCaption: String? {
        guard let cloud = cloudAvailable else { return nil }
        switch draft.recognitionMode {
        case .automatic: return cloud ? "Uses Soniox, with local fallback." : "Local only until a Soniox key is added."
        case .cloud: return cloud ? "Uses Soniox, with no local fallback." : "Needs a Soniox API key on the server."
        case .local: return "Audio never leaves your server."
        }
    }

    @ViewBuilder private func modelsGroup(_ health: ServerHealth) -> some View {
        let cleanupEnabled = controller.sharedPreferences?.preferences.textCorrectionEnabled ?? true
        modelRow("Speech recognition", name: health.speech.friendlyName,
                 status: ServerModelStatus(health.speech, health: health))
        modelRow("Text cleanup", name: health.proofreading.friendlyName,
                 status: ServerModelStatus(health.proofreading, health: health, enabled: cleanupEnabled))
        if let cloud = health.cloudRecognition {
            LabeledContent("Cloud recognition") {
                VStack(alignment: .trailing, spacing: 2) {
                    HStack(spacing: 6) {
                        Text("Soniox")
                        ModelStatusDot(status: cloud ? .ready : .off)
                        Text(cloud ? "On" : "Off").foregroundStyle(SottoDuoPalette.muted)
                    }
                    if !cloud { caption("No API key on the server") }
                }
            }
        }
        DisclosureGroup("Model details", isExpanded: $showingModelDetails) {
            Text(modelDetails(health))
                .font(.system(.caption, design: .monospaced))
                .foregroundStyle(SottoDuoPalette.muted)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityIdentifier("preferences.model-details")
    }

    private func modelRow(_ title: String, name: String, status: ServerModelStatus) -> some View {
        LabeledContent(title) {
            HStack(spacing: 6) {
                Text(name).lineLimit(1)
                ModelStatusDot(status: status)
                Text(status.rawValue).foregroundStyle(SottoDuoPalette.muted)
            }
        }
    }

    /// Exact model IDs and backends, as the server reports them.
    private func modelDetails(_ health: ServerHealth) -> String {
        var lines = [health.speech, health.proofreading].map { runtime in
            ([runtime.modelID, runtime.backend] + [runtime.message].compactMap { $0 }).joined(separator: " · ")
        }
        if let cloud = health.cloudRecognition {
            lines.append("soniox/websocket · " + (cloud ? "API key configured" : "no API key"))
        }
        return lines.joined(separator: "\n")
    }

    private func loadLatest() {
        guard let snapshot = controller.sharedPreferences else { return }
        base = snapshot
        draft = snapshot.preferences
    }
}

/// A plain status for a server model, derived from its health runtime.
enum ServerModelStatus: String {
    case ready = "Ready", loading = "Loading", off = "Off", unavailable = "Unavailable"

    init(_ runtime: ModelRuntimeInfo, health: ServerHealth, enabled: Bool = true) {
        if !enabled { self = .off }
        else if runtime.ready { self = .ready }
        // The server reports warm-up in these messages.
        else if [runtime.message, health.message].contains(where: { $0?.hasPrefix("Loading") == true }) { self = .loading }
        else { self = .unavailable }
    }
}

extension ModelRuntimeInfo {
    /// A friendly model name. The exact ID stays in Model details.
    var friendlyName: String {
        if backend.hasPrefix("soniox") { return "Soniox" }
        if modelID.hasPrefix("whisper-large-v3-turbo") { return "Whisper large-v3-turbo" }
        if modelID.hasPrefix("parakeet-tdt-0.6b-v3") { return "Parakeet v3" }
        if modelID.hasPrefix("Qwen3-4B") { return "Qwen3 4B" }
        return modelID
    }
}

private struct ModelStatusDot: View {
    var status: ServerModelStatus

    var body: some View {
        switch status {
        case .ready: StatusDot(color: SottoDuoPalette.success)
        case .loading, .unavailable: StatusDot(color: SottoDuoPalette.warning)
        case .off:
            Circle()
                .stroke(SottoDuoPalette.muted, lineWidth: 1.5)
                .frame(width: 6, height: 6)
                .accessibilityHidden(true)
        }
    }
}
