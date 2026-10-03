import AppKit
import SottoDuoAPI
import SwiftUI

struct HistoryPage: View {
    @ObservedObject var controller: SottoDuoController
    @State private var selectedID: UUID?
    @State private var deviceID = "all"
    @State private var confirmingDelete = false
    @State private var copiedID: UUID?
    @State private var showingWisprFlowImport = false
    @State private var pendingDiscardID: UUID?
    @State private var pendingRetryID: UUID?

    private var devices: [DeviceIdentity] {
        var seen = Set<String>()
        return controller.generations.map(\.device).filter { seen.insert($0.id).inserted }.sorted { $0.name < $1.name }
    }
    private var filtered: [GenerationRecord] {
        controller.generations.filter { deviceID == "all" || $0.device.id == deviceID }
    }
    private var selected: GenerationRecord? {
        filtered.first { $0.id == selectedID }.flatMap { controller.generationDetail($0.id) }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack {
                SottoDuoPageHeading(title: "History")
                Picker("Device", selection: $deviceID) {
                    Text("All devices").tag("all")
                    ForEach(devices, id: \.id) { device in Text(device.name).tag(device.id) }
                }
                .labelsHidden()
                .frame(width: 180)
                Picker("Source", selection: Binding(get: { controller.historySourceFilter },
                                                     set: controller.setHistorySourceFilter)) {
                    Text("All sources").tag("all")
                    Text("SottoDuo").tag("sottoduo")
                    Text("Wispr Flow").tag("wispr-flow")
                }
                .labelsHidden()
                .frame(width: 130)
                .accessibilityIdentifier("history.source-filter")
                Button {
                    controller.errorMessage = nil
                    controller.refreshHistory()
                } label: { Image(systemName: "arrow.clockwise") }
                    .help("Refresh shared history")
                    .accessibilityLabel("Refresh shared history")
            }
            VStack(spacing: 4) {
                ServerConnectionStatus(controller: controller)
                SottoDuoActionMessage(message: controller.errorMessage)
            }

            HSplitView {
                historyList.frame(minWidth: 220, idealWidth: 255, maxWidth: 320)
                detail.frame(minWidth: 280, maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .layoutPriority(1)

            HStack {
                Text("\(filtered.count) \(filtered.count == 1 ? "dictation" : "dictations")\(controller.hasMoreHistory ? " loaded" : "")")
                    .font(.caption)
                    .foregroundStyle(SottoDuoPalette.muted)
                Spacer()
                Button("Import Wispr Flow history") {
                    showingWisprFlowImport = true
                    controller.prepareWisprFlowImport()
                }
                .disabled(controller.isBusy)
                .accessibilityIdentifier("history.import-wispr-flow")
                if controller.isLoadingHistory { ProgressView().controlSize(.mini) }
                Button("Load older") {
                    controller.errorMessage = nil
                    controller.loadMoreHistory()
                }
                .opacity(controller.hasMoreHistory ? 1 : 0)
                .disabled(!controller.hasMoreHistory || controller.isLoadingHistory)
            }
            .frame(height: 28)
        }
        .padding(26)
        .onAppear { controller.refreshHistory() }
        .onChange(of: selectedID) { _, id in
            if let id { controller.loadGenerationDetail(id) }
        }
        .onChange(of: selected?.status) { _, status in
            if status == .completed, let id = selectedID { controller.loadGenerationDetail(id) }
        }
        .onChange(of: controller.historySourceFilter) { _, _ in
            deviceID = "all"
            selectedID = nil
        }
        .sheet(isPresented: $showingWisprFlowImport) {
            WisprFlowImportSheet(controller: controller)
                .onDisappear { controller.closeWisprFlowImportSheet() }
        }
        .confirmationDialog(selected.map { isInterrupted($0) } == true ? "Discard this recording?"
                                : "Delete this dictation from the server?", isPresented: $confirmingDelete) {
            if let selected {
                Button(isInterrupted(selected) ? "Discard recording" : "Delete dictation", role: .destructive) {
                    controller.errorMessage = nil
                    controller.deleteGeneration(selected.id)
                }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Its archived text and files will be removed from every device’s history.")
        }
        .confirmationDialog("Discard this saved recording?", isPresented: Binding(
            get: { pendingDiscardID != nil }, set: { if !$0 { pendingDiscardID = nil } }
        )) {
            if let id = pendingDiscardID {
                Button("Discard recording", role: .destructive) { controller.discardPendingRecording(id) }
            }
            Button("Cancel", role: .cancel) { pendingDiscardID = nil }
        }
        .confirmationDialog("Transcribe this take again?", isPresented: Binding(
            get: { pendingRetryID != nil }, set: { if !$0 { pendingRetryID = nil } }
        )) {
            if let id = pendingRetryID {
                Button("Transcribe again") {
                    controller.errorMessage = nil
                    controller.retryGeneration(id)
                }
            }
            Button("Cancel", role: .cancel) { pendingRetryID = nil }
        } message: {
            let record = controller.generations.first { $0.id == pendingRetryID }
            Text("The new transcript replaces the current one in History on every device. Nothing is pasted."
                 + (record.map { " " + HistoryLabels.retryEngine($0, installed: controller.serverHealth?.recognitionEngines) } ?? ""))
        }
    }

    private var historyList: some View {
        List(selection: $selectedID) {
            if !controller.pendingRecordings.isEmpty {
                Section("Saved on this Mac") {
                    ForEach(controller.pendingRecordings) { recording in
                        VStack(alignment: .leading, spacing: 8) {
                            HStack {
                                Text(recording.createdAt, format: .dateTime.month(.abbreviated).day().hour().minute())
                                    .font(.caption)
                                Spacer()
                                Button { pendingDiscardID = recording.id } label: { Image(systemName: "trash") }
                                    .buttonStyle(.borderless)
                                    .help("Discard saved recording")
                                    .accessibilityLabel("Discard saved recording")
                            }
                            HStack {
                                Text(controller.pendingRecordingIsPaused(recording.id) ? "Interrupted" : "Saved on this Mac, waiting to upload")
                                Spacer()
                                Text(sottoduoDuration(controller.pendingRecordingAudioSeconds(recording.id))).monospacedDigit()
                            }
                            .font(.callout)
                            HStack {
                                Button("Resume") { controller.resumePendingRecording(recording.id) }
                                    .disabled(!controller.canResumePendingRecording(recording.id))
                                    .help("Keep recording into this take.")
                                Button("Finish") { controller.finishPendingRecording(recording.id) }
                                    .disabled(!controller.canFinishPendingRecording(recording.id))
                                    .help("Stop here and transcribe what was saved.")
                            }
                            .buttonStyle(.borderless)
                        }
                        .padding(.vertical, 8)
                    }
                    Button("Upload saved recordings", action: controller.retryPendingRecordings)
                        .buttonStyle(.borderless)
                        .disabled(controller.isBusy)
                }
            }
            ForEach(filtered) { generation in
                let status = HistoryLabels.status(generation, interrupted: isInterrupted(generation))
                VStack(alignment: .leading, spacing: 6) {
                    Text("\(generation.createdAt.formatted(.dateTime.month(.abbreviated).day().hour().minute())) · \(sourceLabel(generation))")
                        .font(.caption)
                        .foregroundStyle(SottoDuoPalette.muted)
                        .lineLimit(1)
                    Text(summary(generation))
                        .font(.callout)
                        .foregroundStyle(transcript(generation).isEmpty ? SottoDuoPalette.muted : SottoDuoPalette.ink)
                        .lineLimit(2)
                        .frame(maxWidth: .infinity, alignment: .topLeading)
                    if let status { HistoryChip(status: status) }
                }
                .padding(.vertical, 8)
                .tag(generation.id)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel([sourceLabel(generation), summary(generation), status?.label]
                    .compactMap { $0 }.joined(separator: ", "))
            }
        }
        .listStyle(.inset)
        .scrollContentBackground(.hidden)
        .overlay {
            if filtered.isEmpty && controller.pendingRecordings.isEmpty {
                ContentUnavailableView("No dictations", systemImage: "waveform",
                                       description: Text("Record while connected to add a dictation."))
            }
        }
        .accessibilityIdentifier("history.list")
    }

    @ViewBuilder private var detail: some View {
        if let selected {
            let interrupted = isInterrupted(selected)
            // Failed and interrupted takes need a decision; a banner holds the explanation and actions.
            let problem = interrupted || selected.status == .failed
            let text = transcript(selected)
            VStack(alignment: .leading, spacing: 14) {
                HStack {
                    Text(selected.createdAt, format: .dateTime.month(.wide).day().hour().minute()).font(.headline)
                    Spacer()
                    Button {
                        NSPasteboard.general.clearContents()
                        if NSPasteboard.general.setString(selected.finalText, forType: .string) { copiedID = selected.id }
                    } label: { Image(systemName: copiedID == selected.id ? "checkmark" : "doc.on.doc") }
                        .disabled(selected.finalText.isEmpty || controller.loadingGenerationDetails.contains(selected.id))
                        .help("Copy transcript")
                        .accessibilityLabel("Copy transcript")
                    // Interrupted takes are discarded from their banner.
                    if !interrupted {
                        Button { confirmingDelete = true } label: { Image(systemName: "trash") }
                            .disabled(!selected.status.isTerminal || controller.serverHealth == nil)
                            .help("Delete from server")
                            .accessibilityLabel("Delete dictation")
                    }
                }
                HStack(spacing: 12) {
                    Label(sourceLabel(selected),
                          systemImage: selected.importedSource == nil ? "laptopcomputer" : "square.and.arrow.down")
                    if let sourceStatus = selected.importedSource?.sourceStatus, !sourceStatus.isEmpty {
                        Text("Wispr Flow: \(sourceStatus)")
                    }
                    if problem, savedSeconds(selected) > 0 { Text(sottoduoDuration(savedSeconds(selected))).monospacedDigit() }
                    let gapSeconds = controller.recordingGapSeconds(selected.id)
                    if gapSeconds > 0 { Text("\(sottoduoDuration(gapSeconds)) paused").monospacedDigit() }
                }
                .font(.caption)
                .foregroundStyle(SottoDuoPalette.muted)
                if problem {
                    problemBanner(selected, interrupted: interrupted)
                } else {
                    if let status = HistoryLabels.status(selected, interrupted: false) {
                        HStack(spacing: 8) {
                            HistoryChip(status: status)
                            if let detail = status.detail {
                                Text(detail).font(.caption).foregroundStyle(SottoDuoPalette.muted)
                            }
                        }
                    }
                    let recognition = HistoryLabels.recognition(selected)
                    if !recognition.isEmpty {
                        Text(recognition)
                            .font(.caption)
                            .foregroundStyle(SottoDuoPalette.muted)
                            .help([selected.speech, selected.proofreading].compactMap { $0.map { "\($0.modelID) · \($0.backend)" } }
                                .joined(separator: "\n"))
                    }
                }
                // A failed retry of a finished take keeps the transcript and says why.
                if !problem, let error = selected.error {
                    Text(error)
                        .font(.callout)
                        .foregroundStyle(HistoryTone.warning.ink)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                        .padding(12)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(HistoryTone.warning.tint))
                        .accessibilityIdentifier("history.error-banner")
                }
                Divider()
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        if controller.loadingGenerationDetails.contains(selected.id) {
                            ProgressView("Loading transcript…").controlSize(.small)
                        }
                        // A problem banner already says why there is no transcript.
                        if !text.isEmpty || !problem {
                            Text(!text.isEmpty ? text
                                 : selected.status.isTerminal ? "No transcript available." : "Processing saved audio…")
                                .font(.body)
                                .lineSpacing(4)
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        let cleanup = selected.importedSource == nil ? HistoryLabels.cleanup(selected.textProcessing?.status) : nil
                        if !selected.rawText.isEmpty && selected.rawText != selected.finalText {
                            DisclosureGroup(selected.importedSource == nil
                                            ? "Original transcript" + (cleanup.map { " · \($0)" } ?? "")
                                            : "Wispr Flow's transcript") {
                                Text(selected.rawText)
                                    .font(.callout)
                                    .foregroundStyle(SottoDuoPalette.muted)
                                    .textSelection(.enabled)
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.top, 8)
                            }
                        } else if let cleanup, selected.textProcessing?.reason == nil {
                            Text(cleanup).font(.caption).foregroundStyle(SottoDuoPalette.muted)
                        }
                        if let source = selected.importedSource, !source.variantNames.isEmpty {
                            Text("Text versions from Wispr Flow: \(source.variantNames.joined(separator: ", "))")
                                .font(.caption)
                                .foregroundStyle(SottoDuoPalette.muted)
                        }
                        if let reason = selected.formattingRejectionReason {
                            Text("List formatting skipped: \(reason)").font(.caption).foregroundStyle(SottoDuoPalette.warning)
                        }
                        if let processing = selected.textProcessing {
                            if let reason = processing.reason {
                                Text("\(cleanup ?? "Text cleanup"): \(reason)").font(.caption).foregroundStyle(SottoDuoPalette.warning)
                            }
                            if processing.status == .rejected, let proposed = processing.proposedText {
                                DisclosureGroup("Rejected cleanup") {
                                    Text(proposed).font(.callout).textSelection(.enabled)
                                        .frame(maxWidth: .infinity, alignment: .leading)
                                }
                            }
                        }
                        if let hints = selected.recognitionHints, !hints.omittedTerms.isEmpty {
                            hintDetails("Recognition vocabulary", hints: hints)
                        }
                        if let hints = selected.proofreadingHints, !hints.omittedTerms.isEmpty {
                            hintDetails("Text cleanup vocabulary", hints: hints)
                        }
                    }
                }
                .frame(maxHeight: .infinity)
                Divider()
                HStack {
                    // Failed takes offer this in their banner.
                    if controller.canTranscribeAgain(selected) && !problem {
                        transcribeAgainButton(selected)
                    }
                    if selected.inferenceAudio != nil {
                        Button("Open audio") {
                            controller.errorMessage = nil
                            controller.openGenerationAudio(selected, kind: .inference)
                        }
                        .help("The 16 kHz audio used for transcription.")
                    }
                    let originalRuns = controller.originalRecordingRuns(selected.id)
                    if originalRuns.count > 1 {
                        Menu("Open original recording") {
                            ForEach(Array(originalRuns.enumerated()), id: \.element.runID) { index, run in
                                Button("Part \(index + 1)") {
                                    controller.openGenerationAudio(selected, kind: .original, runID: run.runID)
                                }
                            }
                        }
                    } else if selected.originalAudio != nil || !originalRuns.isEmpty {
                        Button("Open original recording") {
                            controller.errorMessage = nil
                            controller.openGenerationAudio(selected, kind: .original)
                        }
                    }
                    if let source = selected.importedSource {
                        if source.artifactNames.contains(.sourceWAV) {
                            Button("Open Wispr Flow audio") {
                                controller.openWisprFlowArtifact(selected, filename: .sourceWAV)
                            }
                        }
                        if !source.artifactNames.isEmpty {
                            Menu("Source files") {
                                ForEach(source.artifactNames, id: \.rawValue) { filename in
                                    Button(sourceFileLabel(filename)) {
                                        controller.openWisprFlowArtifact(selected, filename: filename)
                                    }
                                }
                            }
                        }
                    }
                    Spacer()
                }
                .frame(height: 28)
                .disabled(controller.serverHealth == nil || !selected.status.isTerminal)
            }
            .padding(.leading, 20)
            .padding(.top, 8)
            .accessibilityIdentifier("history.detail")
        } else {
            ContentUnavailableView("Select a dictation", systemImage: "text.alignleft")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func problemBanner(_ selected: GenerationRecord, interrupted: Bool) -> some View {
        let tone: HistoryTone = interrupted ? .warning : .error
        let savedHere = isSavedHere(selected.id)
        return VStack(alignment: .leading, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(interrupted ? "Interrupted" : "Couldn't transcribe").fontWeight(.semibold)
                Text(interrupted ? interruptedText(selected, savedHere: savedHere)
                                 : selected.error ?? "No transcript was produced.")
                    .fixedSize(horizontal: false, vertical: true)
                    .textSelection(.enabled)
            }
            .foregroundStyle(tone.ink)
            if interrupted {
                HStack {
                    if savedHere {
                        // Only the Mac that made the recording holds what is needed to finish it.
                        Button("Finish") { controller.finishPendingRecording(selected.id) }
                            .buttonStyle(.borderedProminent)
                            .disabled(!controller.canFinishPendingRecording(selected.id))
                            .help("Stop here and transcribe what was saved.")
                        if controller.pendingRecordingIsPaused(selected.id) {
                            Button("Resume") { controller.resumePendingRecording(selected.id) }
                                .disabled(!controller.canResumePendingRecording(selected.id))
                                .help("Keep recording into this take.")
                        }
                        Button("Discard", role: .destructive) { pendingDiscardID = selected.id }
                    } else {
                        Button("Discard", role: .destructive) { confirmingDelete = true }
                            .disabled(controller.serverHealth == nil)
                    }
                }
                if savedHere {
                    Text("Finish transcribes what was saved. Discard deletes it.")
                        .font(.caption)
                        .foregroundStyle(tone.ink)
                }
            } else if controller.canTranscribeAgain(selected) {
                transcribeAgainButton(selected, prominent: true)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(tone.tint))
    }

    private func interruptedText(_ selected: GenerationRecord, savedHere: Bool) -> String {
        let seconds = savedSeconds(selected)
        let saved = seconds > 0 ? "\(sottoduoDuration(seconds)) of audio is saved." : "Its audio is saved."
        let elsewhere = !savedHere && selected.device.id != controller.preferences.deviceID
        return "The recording stopped before it finished. \(saved)" + (elsewhere ? " Finish it on \(selected.device.name)." : "")
    }

    @ViewBuilder private func transcribeAgainButton(_ selected: GenerationRecord, prominent: Bool = false) -> some View {
        let supported = controller.serverHealth?.generationRetry == true
        let retrying = controller.retryingGenerationIDs.contains(selected.id)
        let asks = selected.asksBeforeTranscribingAgain
        let button = Button(retrying ? "Transcribing…" : asks ? "Transcribe again…" : "Transcribe again") {
            controller.errorMessage = nil
            if asks { pendingRetryID = selected.id } else { controller.retryGeneration(selected.id) }
        }
        .disabled(!supported || retrying || controller.serverHealth == nil)
        .help(supported ? "Transcribe the saved audio again. Nothing is pasted."
              : "Update SottoDuo on the server to transcribe recordings again.")
        if prominent { button.buttonStyle(.borderedProminent) } else { button }
    }

    private func isInterrupted(_ generation: GenerationRecord) -> Bool { controller.isPausedRecording(generation.id) }

    /// This Mac holds a local copy of the recording, so it can finish or resume it.
    private func isSavedHere(_ id: UUID) -> Bool { controller.pendingRecordings.contains { $0.id == id } }

    private func savedSeconds(_ generation: GenerationRecord) -> TimeInterval {
        generation.audioSeconds > 0 ? generation.audioSeconds : controller.pendingRecordingAudioSeconds(generation.id)
    }

    private func sourceLabel(_ generation: GenerationRecord) -> String {
        generation.importedSource == nil ? generation.device.name : "Imported from Wispr Flow"
    }

    private func transcript(_ generation: GenerationRecord) -> String {
        generation.status == .completed || !generation.finalText.isEmpty ? generation.finalText : generation.previewText
    }

    private func summary(_ generation: GenerationRecord) -> String {
        if !generation.previewText.isEmpty { return generation.previewText }
        if !generation.finalText.isEmpty { return generation.finalText }
        if generation.importedSource != nil { return "No transcript recovered" }
        if isInterrupted(generation) {
            let seconds = savedSeconds(generation)
            return seconds > 0 ? "\(sottoduoDuration(seconds)) of audio saved" : "Audio saved"
        }
        switch generation.status {
        case .failed: return "No transcript"
        case .completed, .cancelled: return "No speech"
        case .receiving, .queued, .transcribing, .proofreading: return "No transcript yet"
        }
    }

    private func sourceFileLabel(_ filename: WisprFlowArtifactName) -> String {
        switch filename {
        case .sourceJSON: "Full source data"
        case .sourceWAV: "Wispr Flow audio"
        case .opusJSON: "Compressed audio (Opus)"
        case .screenshotPNG: "Screenshot"
        case .builtInAudio: "Built-in audio (not imported)"
        }
    }

    @ViewBuilder private func hintDetails(_ title: String, hints: ModelHintUsage) -> some View {
        // A zero budget means the engine has no vocabulary prompting at all.
        if hints.tokenBudget == 0 {
            Text("Vocabulary not used by this engine").font(.caption).foregroundStyle(SottoDuoPalette.muted)
        } else {
            DisclosureGroup("\(title): \(hints.omittedTerms.count) terms did not fit") {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Used: \(hints.includedTerms.isEmpty ? "None" : hints.includedTerms.joined(separator: ", "))")
                    Text("Did not fit: \(hints.omittedTerms.joined(separator: ", "))")
                }
                .font(.caption)
                .foregroundStyle(SottoDuoPalette.muted)
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }
}

private struct HistoryChip: View {
    let status: HistoryStatus

    var body: some View {
        Text(status.label)
            .font(.caption.weight(.semibold))
            .lineLimit(1)
            .foregroundStyle(status.tone.ink)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(Capsule().fill(status.tone.tint))
            .overlay { if status.tone == .accent { Capsule().strokeBorder(SottoDuoPalette.line) } }
    }
}

private extension HistoryTone {
    var ink: Color {
        switch self {
        case .ok: SottoDuoPalette.okInk
        case .warning: SottoDuoPalette.warningInk
        case .error: SottoDuoPalette.errorInk
        case .neutral: SottoDuoPalette.muted
        case .accent: SottoDuoPalette.ink
        }
    }

    var tint: Color {
        switch self {
        case .ok: SottoDuoPalette.okTint
        case .warning: SottoDuoPalette.warningTint
        case .error: SottoDuoPalette.errorTint
        // Translucent, so it stays visible on selected and hovered rows.
        case .neutral: SottoDuoPalette.muted.opacity(0.16)
        case .accent: .clear
        }
    }
}

private struct WisprFlowImportSheet: View {
    @ObservedObject var controller: SottoDuoController
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Import Wispr Flow history")
                .font(.title2.weight(.semibold))

            Group {
                switch controller.wisprFlowImportState {
                case .idle, .preparing:
                    VStack(alignment: .leading, spacing: 12) {
                        ProgressView().controlSize(.small)
                        Text("Reading local Wispr Flow history…")
                            .foregroundStyle(SottoDuoPalette.muted)
                    }
                case .preview(let preview, let knownCount, let destinationError):
                    previewContent(preview, knownCount: knownCount, destinationError: destinationError)
                case .running(let preview, let counts):
                    progressContent(preview, counts: counts)
                case .finished(let preview, let counts, let cancelled):
                    resultContent(preview, counts: counts, cancelled: cancelled)
                case .failed(let message):
                    Text(message)
                        .foregroundStyle(SottoDuoPalette.warning)
                        .textSelection(.enabled)
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)

            Divider()
            HStack {
                Text("Destination: \(controller.preferences.endpoint)")
                    .font(.caption)
                    .foregroundStyle(SottoDuoPalette.muted)
                    .lineLimit(1)
                    .truncationMode(.middle)
                Spacer()
                actions
            }
        }
        .padding(24)
        .frame(width: 520, height: 380)
        .interactiveDismissDisabled(isImporting)
        .accessibilityIdentifier("wispr-flow-import.sheet")
    }

    private var isImporting: Bool {
        if case .running = controller.wisprFlowImportState { return true }
        return false
    }

    private func previewContent(_ preview: WisprFlowImportPreview, knownCount: Int?,
                                destinationError: String?) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                Text("\(preview.sessionCount) sessions found")
                    .font(.headline)
                if let earliest = preview.earliestDate, let latest = preview.latestDate {
                    Text("\(earliest.formatted(date: .abbreviated, time: .omitted)) – \(latest.formatted(date: .abbreviated, time: .omitted))")
                        .foregroundStyle(SottoDuoPalette.muted)
                }
                Divider()
                countRow("With transcripts", count: preview.transcriptCount)
                countRow("Without text", count: preview.sessionCount - preview.transcriptCount)
                countRow("Details only, no text or audio", count: preview.metadataOnlyCount)
                countRow("WAV found", count: preview.wavCount)
                countRow("Compressed audio", count: preview.opusCount)
                countRow("Screenshots", count: preview.screenshotCount)
                countRow("Dictionary entries to archive", count: preview.dictionaryCount)
                if let knownCount {
                    countRow("Already in SottoDuo", count: knownCount)
                }
                if let destinationError {
                    Text(destinationError).font(.caption).foregroundStyle(SottoDuoPalette.warning)
                }
                Text("About \(ByteCountFormatter.string(fromByteCount: preview.estimatedArtifactBytes, countStyle: .file)) of source files")
                    .font(.caption)
                    .foregroundStyle(SottoDuoPalette.muted)
                Text("Sources: \(sourceSummary(preview.sourceURLs))")
                    .font(.caption)
                    .foregroundStyle(SottoDuoPalette.muted)
                ForEach(preview.warnings, id: \.self) { warning in
                    Text(warning).font(.caption).foregroundStyle(SottoDuoPalette.warning)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func progressContent(_ preview: WisprFlowImportPreview, counts: WisprFlowImportCounts) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Importing \(preview.sessionCount) sessions")
                .font(.headline)
            ProgressView(value: Double(counts.processed), total: Double(max(1, counts.total)))
                .accessibilityIdentifier("wispr-flow-import.progress")
            Text("\(counts.processed) of \(counts.total) processed")
                .monospacedDigit()
                .foregroundStyle(SottoDuoPalette.muted)
            Text("\(counts.imported) new · \(counts.enriched) updated · \(counts.skipped) already here · \(counts.partial) missing files · \(counts.failed) failed")
                .font(.caption)
        }
    }

    private func resultContent(_ preview: WisprFlowImportPreview, counts: WisprFlowImportCounts,
                               cancelled: Bool) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(cancelled ? "Import stopped" : (counts.processed < preview.sessionCount ? "Import incomplete" : "Import complete"))
                .font(.headline)
            Text("\(counts.processed) of \(preview.sessionCount) sessions processed")
                .monospacedDigit()
            countRow("New", count: counts.imported)
            countRow("Updated with more files", count: counts.enriched)
            countRow("Already in SottoDuo", count: counts.skipped)
            countRow("Missing some files", count: counts.partial)
            countRow("Failed", count: counts.failed)
            if preview.dictionaryCount > 0 {
                Text(counts.dictionaryArchived ? "Dictionary archived" : "Dictionary was not archived")
                    .font(.caption)
                    .foregroundStyle(counts.dictionaryArchived ? SottoDuoPalette.muted : SottoDuoPalette.warning)
            }
            if let warning = counts.warning {
                Text(warning).font(.caption).foregroundStyle(SottoDuoPalette.warning)
            }
            if let warning = counts.unarchivedWarning {
                Text(warning).font(.caption).foregroundStyle(SottoDuoPalette.warning)
            }
        }
    }

    private func countRow(_ label: String, count: Int) -> some View {
        HStack {
            Text(label)
            Spacer()
            Text("\(count)").monospacedDigit()
        }
        .font(.callout)
    }

    private func sourceSummary(_ urls: [URL]) -> String {
        let names = urls.map(\.lastPathComponent)
        var parts: [String] = []
        if names.contains("flow.sqlite") { parts.append("flow.sqlite") }
        let backups = names.filter { $0.hasPrefix("backup-") }.count
        if backups > 0 { parts.append("\(backups) backup\(backups == 1 ? "" : "s")") }
        let selected = names.count - (names.contains("flow.sqlite") ? 1 : 0) - backups
        if selected > 0 { parts.append("\(selected) selected file\(selected == 1 ? "" : "s")") }
        return parts.joined(separator: " + ")
    }

    @ViewBuilder private var actions: some View {
        switch controller.wisprFlowImportState {
        case .idle, .preparing:
            Button("Cancel") { controller.cancelWisprFlowImport(); dismiss() }
        case .preview(_, _, let destinationError):
            Button("Cancel") { dismiss() }
            Button("Import") { controller.startWisprFlowImport() }
                .buttonStyle(.borderedProminent)
                .disabled(destinationError != nil || controller.serverHealth?.apiVersion != SottoDuoAPI.version || controller.isBusy)
                .accessibilityIdentifier("wispr-flow-import.start")
        case .running:
            Button("Cancel import") { controller.cancelWisprFlowImport() }
        case .finished:
            Button("Done") { dismiss() }
        case .failed:
            Button("Close") { dismiss() }
            Button("Try again") { controller.prepareWisprFlowImport() }
        }
    }
}
