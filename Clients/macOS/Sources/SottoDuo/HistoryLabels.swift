import Foundation
import SottoDuoAPI

/// How strongly a history status stands out; each maps to one palette tint.
enum HistoryTone: Equatable { case ok, neutral, warning, error, accent }

struct HistoryStatus: Equatable {
    var label: String
    var tone: HistoryTone
    /// Explains a delivery chip in the detail view; nil for take states.
    var detail: String?
}

/// History's shared label tables. The Linux client uses the same words and tones.
enum HistoryLabels {
    static func delivery(_ status: String?) -> HistoryStatus? {
        switch status {
        case "inserted", "listUpdated": .init(label: "Pasted", tone: .ok, detail: "Pasted at your cursor.")
        case "copied": .init(label: "Copied", tone: .neutral, detail: "Copied to the clipboard.")
        case "unconfirmed": .init(label: "Check the field", tone: .warning, detail: "The paste could not be confirmed.")
        case "cancelled": .init(label: "Not pasted", tone: .neutral, detail: "You cancelled this take.")
        case "none": .init(label: "Not pasted", tone: .neutral, detail: "Nothing was pasted.")
        case "failed": .init(label: "Couldn't paste", tone: .error, detail: "The text is saved here to copy.")
        case "tested": .init(label: "Test (no paste)", tone: .accent, detail: "Microphone test. Nothing is pasted.")
        default: nil
        }
    }

    /// Problems and progress come first, then how the text was delivered.
    static func status(_ record: GenerationRecord, interrupted: Bool) -> HistoryStatus? {
        if interrupted { return .init(label: "Interrupted", tone: .warning) }
        switch record.status {
        case .receiving: return .init(label: "Recording", tone: .neutral)
        case .queued: return .init(label: "Waiting to transcribe", tone: .neutral)
        case .transcribing: return .init(label: "Transcribing", tone: .neutral)
        case .proofreading: return .init(label: "Cleaning up text", tone: .neutral)
        case .failed: return .init(label: "Couldn't transcribe", tone: .error)
        case .cancelled: return delivery("cancelled")
        case .completed: return delivery(record.delivery?.status) ?? (record.mode == .test ? delivery("tested") : nil)
        }
    }

    /// Nil when cleanup was off; it then needs no mention.
    static func cleanup(_ status: TextProcessingRecord.Status?) -> String? {
        switch status {
        case .applied: "Text cleanup applied"
        case .rejected: "Cleanup not used (kept recognized text)"
        case .skipped: "Cleanup skipped"
        case .unavailable: "Cleanup unavailable"
        case .unchanged: "Text cleanup made no changes"
        case .failed: "Cleanup failed"
        case .disabled, nil: nil
        }
    }

    static func languageName(_ code: String?) -> String? {
        guard let code, !code.isEmpty else { return nil }
        return Locale(identifier: "en").localizedString(forLanguageCode: code) ?? code
    }

    /// How the speech was recognized, its language and length.
    static func recognition(_ record: GenerationRecord) -> String {
        let how: String? = if let recognition = record.recognition {
            recognition.provider == .soniox ? "Recognized with cloud"
                : recognition.fallbackReason == nil ? "Recognized locally" : "Recognized locally (cloud unavailable)"
        } else if let backend = record.speech?.backend {
            // Records from servers that predate the recognition field.
            backend.hasPrefix("soniox") ? "Recognized with cloud" : "Recognized locally"
        } else { nil }
        let duration = record.audioSeconds > 0 ? sottoduoDuration(record.audioSeconds) : nil
        return [how, languageName(record.detectedLanguage), duration].compactMap { $0 }.joined(separator: " · ")
    }

    /// A retry runs on the take's own engine and language, or on Whisper if that engine is gone.
    static func retryEngine(_ record: GenerationRecord, installed: [RecognitionEngine]?) -> String {
        let preferences = record.settings.preferences
        let parakeet = preferences.recognitionEngine == .parakeet && (installed ?? [.whisper]).contains(.parakeet)
        let language = parakeet || preferences.language == "auto"
            ? "Detect automatically" : languageName(preferences.language) ?? preferences.language
        return "Current engine: \(parakeet ? "Parakeet" : "Whisper"), language \(language)."
    }
}

extension GenerationRecord {
    /// The server keeps saved audio for finished, failed and cancelled takes.
    /// Interrupted takes are not settled, so they must be finished first.
    var canTranscribeAgain: Bool {
        importedSource == nil && inferenceAudio != nil && status.isTerminal
    }

    /// A finished take asks first, because the new transcript replaces it.
    var asksBeforeTranscribingAgain: Bool { status == .completed }
}
