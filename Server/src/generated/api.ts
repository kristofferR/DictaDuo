export interface paths {
  "/v1/button-destinations": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getButtonDestinations"];
    put?: never;
    post: operations["registerButtonDestination"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/button-destinations/{id}/heartbeat": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["heartbeatButtonDestination"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/button-destinations/{id}/select": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["selectButtonDestination"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/button-destinations/{id}/complete": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["completeButtonTake"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/button-destinations/{id}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    delete: operations["unregisterButtonDestination"];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/audio-sources": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["listAudioSources"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/audio-sources/sharing": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    /** @description Shares or stops sharing one source with other computers. Only a client on the computer that hosts the sources may change this. */
    put: operations["setAudioSourceSharing"];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/button-destinations/target": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    /** @description Chooses where the DJI button types. Stored on the server and shared by every destination. */
    put: operations["setButtonTarget"];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v2/captures": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["startCapture"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v2/recordings/{id}/capture/heartbeat": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["heartbeatCapture"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v2/recordings/{id}/capture/stop": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["stopCapture"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v2/recordings/{id}/context": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** @description Fix a remote capture's continuation (or none) before its text processing starts. */
    post: operations["setCaptureContext"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v2/recordings/{id}/events": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["recordingEvents"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/health": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getHealth"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/preferences": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getPreferences"];
    put: operations["updatePreferences"];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/generations": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["listGenerations"];
    put?: never;
    post: operations["createGeneration"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/generations/{id}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getGeneration"];
    put?: never;
    post?: never;
    delete: operations["deleteGeneration"];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/generations/{id}/audio/{kind}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["appendAudio"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/generations/{id}/finish": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["finishGeneration"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/generations/{id}/cancel": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["cancelGeneration"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/generations/{id}/retry": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["retryGeneration"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/generations/{id}/delivery": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["recordDelivery"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/generations/{id}/events": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description A bounded NDJSON stream of complete GenerationRecord values, with the latest record repeated as a two-second heartbeat. Ends after a terminal record. */
    get: operations["generationEvents"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/generations/{id}/artifacts/{filename}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["downloadArtifact"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/imports/wispr-flow/known": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["knownWisprFlowIDs"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/imports/wispr-flow": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["beginWisprFlowImport"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/imports/wispr-flow/dictionary": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put: operations["archiveWisprFlowDictionary"];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/imports/wispr-flow/{id}/artifacts/{filename}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put: operations["uploadWisprFlowArtifact"];
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/imports/wispr-flow/{id}/complete": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["completeWisprFlowImport"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v1/imports/wispr-flow/{id}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post?: never;
    delete: operations["cancelWisprFlowImport"];
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v2/recordings/capabilities": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getRecordingCapabilities"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v2/recordings": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["listRecordings"];
    put?: never;
    post: operations["createRecording"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v2/recordings/{id}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getRecording"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v2/recordings/{id}/transcript": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getRecordingTranscript"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v2/recordings/{id}/audio/{kind}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getRecordingAudio"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v2/recordings/{id}/discard": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["discardRecording"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v2/recordings/{id}/retry": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    /** @description Resume a failed recording's processing from its committed text with local recognition. Nothing is delivered. */
    post: operations["retryRecording"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v2/recordings/{id}/delivery": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get?: never;
    put?: never;
    post: operations["recordRecordingDelivery"];
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v2/recordings/{id}/stream": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description Upgrade to WebSocket subprotocol sottoduo.recording.v1. Binary audio is UInt32BE JSON header length, UTF8 RecordingAudioHeader, then little-endian float32 PCM. Text controls resume, context, pause, stop and ping; server sends snapshots, acknowledgments, progress and errors. See docs/recording-protocol.md for durable ACK, fencing and resume semantics. */
    get: operations["streamRecording"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
  "/v2/recordings/{id}/audio/{kind}/{runID}": {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    get: operations["getRecordingRunAudio"];
    put?: never;
    post?: never;
    delete?: never;
    options?: never;
    head?: never;
    patch?: never;
    trace?: never;
  };
}
export type webhooks = Record<string, never>;
export interface components {
  schemas: {
    /** Format: uuid */
    UUID: string;
    /** @enum {string} */
    GenerationMode: "dictation" | "test" | "file";
    /** @enum {string} */
    GenerationStatus:
      | "receiving"
      | "queued"
      | "transcribing"
      | "proofreading"
      | "completed"
      | "failed"
      | "cancelled";
    /** @enum {string} */
    AudioKind: "inference" | "original";
    /** @enum {string} */
    WisprFlowArtifactName:
      "source.json" | "source.wav" | "opus.json" | "screenshot.png" | "built-in-audio.bin";
    /** @enum {string} */
    WisprFlowImportOutcome: "imported" | "enriched" | "skipped" | "partial";
    /** @enum {string} */
    TextProcessingStatus:
      "disabled" | "unavailable" | "applied" | "unchanged" | "rejected" | "failed" | "skipped";
    /** @enum {string} */
    SpokenListStyle: "numbered" | "bulleted";
    /** @enum {string} */
    DictationBoundary: "none" | "line" | "paragraph";
    DictionaryEntry: {
      id: string;
      term: string;
      /** @default [] */
      aliases?: string[];
      /** @default false */
      isPriority?: boolean;
    };
    DictionaryList: {
      id: string;
      name: string;
      /** @default [] */
      entries?: components["schemas"]["DictionaryEntry"][];
    };
    PersonalDictionary: {
      lists: components["schemas"]["DictionaryList"][];
    };
    DeviceIdentity: {
      id: string;
      name: string;
    };
    /** @enum {string} */
    RecognitionMode: "automatic" | "cloud" | "local";
    /**
     * @description The local speech model. Whisper large-v3-turbo covers Whisper's languages and uses vocabulary hints; Parakeet TDT 0.6B v3 is faster, detects 25 European languages itself, and ignores vocabulary hints.
     * @enum {string}
     */
    RecognitionEngine: "whisper" | "parakeet";
    RecognitionState: {
      /**
       * @description whisper means local server recognition, whichever recognition engine is selected.
       * @enum {string}
       */
      provider: "soniox" | "whisper";
      fallbackReason?: string;
      partialText?: string;
    };
    ServerPreferences: {
      recognitionMode?: components["schemas"]["RecognitionMode"];
      /** @description Request this field with X-SottoDuo-Recognition-Engine: engine-v1. Missing values select Whisper; updates that omit it keep the server's selection. */
      recognitionEngine?: components["schemas"]["RecognitionEngine"];
      /**
       * @description Norwegian (no) is sent only to clients that send X-SottoDuo-Language: language-v2; others see auto, and saving auto keeps Norwegian.
       * @enum {string}
       */
      language:
        | "en"
        | "auto"
        | "es"
        | "fr"
        | "de"
        | "it"
        | "pt"
        | "nl"
        | "ja"
        | "zh"
        | "ko"
        | "hi"
        | "ar"
        | "pl"
        | "ru"
        | "uk"
        | "sv"
        | "no";
      /** @description Missing values use the built-in cleanup prompt; maximum UTF-8 size is 4096 bytes. */
      proofreadingPrompt?: string;
      /** @description Maximum UTF-8 size is 16384 bytes. */
      vocabulary: string;
      dictionary: components["schemas"]["PersonalDictionary"];
      textCorrectionEnabled: boolean;
      keepOriginalAudio: boolean;
    };
    PreferencesSnapshot: {
      revision: number;
      preferences: components["schemas"]["ServerPreferences"];
    };
    ModelRuntimeInfo: {
      modelID: string;
      backend: string;
      ready: boolean;
      message?: string;
    };
    ServerHealth: {
      apiVersion: number;
      serverVersion: string;
      isDev: boolean;
      ready: boolean;
      /** @description Whether failed or cancelled generations with sealed audio can be retried. Request this field with X-SottoDuo-Generation-Retry: retry-v1. An omitted value means unsupported. */
      generationRetry?: boolean;
      /** @description Whether cloud recognition (Soniox) is configured on this server. Request this field with X-SottoDuo-Cloud-Recognition: cloud-v1. An omitted value means unknown. */
      cloudRecognition?: boolean;
      /** @description Additions to API version 3 this server supports, such as retry-completed (finished takes can be transcribed again) and language-no (Norwegian). Request this field with X-SottoDuo-Features: features-v1. An omitted value means none. */
      features?: string[];
      /** @description Local recognition engines installed on this server. Request this field with X-SottoDuo-Recognition-Engine: engine-v1. An omitted value means Whisper only. */
      recognitionEngines?: components["schemas"]["RecognitionEngine"][];
      speech: components["schemas"]["ModelRuntimeInfo"];
      proofreading: components["schemas"]["ModelRuntimeInfo"];
      message?: string;
    };
    ButtonDestination: {
      id: components["schemas"]["UUID"];
      device: components["schemas"]["DeviceIdentity"];
    };
    RegisterButtonDestination: {
      id: components["schemas"]["UUID"];
      device: components["schemas"]["DeviceIdentity"];
    };
    ButtonCommand: {
      id: components["schemas"]["UUID"];
      takeID: components["schemas"]["UUID"];
      /** @enum {string} */
      action: "start" | "stop" | "cancel";
      source: components["schemas"]["AudioSourceIdentity"];
      /** Format: date-time */
      expiresAt: string;
    };
    ButtonDestinationState: {
      selected?: components["schemas"]["ButtonDestination"];
      destinations: components["schemas"]["ButtonDestination"][];
      source?: components["schemas"]["AudioSourceIdentity"];
      available: boolean;
      command?: components["schemas"]["ButtonCommand"];
      buttonTarget?: components["schemas"]["ButtonTarget"];
    };
    /** @description lastDictated follows the computer of the latest successful shortcut dictation; device always types into one computer; off ignores the button. */
    ButtonTarget: {
      /** @enum {string} */
      mode: "lastDictated" | "device" | "off";
      device?: components["schemas"]["DeviceIdentity"];
    };
    HeartbeatButtonDestination: {
      acknowledgement?: components["schemas"]["UUID"];
    };
    SelectButtonDestination: {
      generationID?: components["schemas"]["UUID"];
    };
    CompleteButtonTake: {
      takeID: components["schemas"]["UUID"];
    };
    AudioSourceIdentity: {
      hostID: string;
      id: string;
    };
    AudioSource: {
      identity: components["schemas"]["AudioSourceIdentity"];
      name: string;
      /** @enum {string} */
      transport: "usb" | "bluetooth" | "builtIn" | "other";
      present: boolean;
      /** @enum {string} */
      link: "connected" | "disconnected" | "unknown" | "notApplicable";
      /** @enum {string} */
      capture: "available" | "unavailable" | "unknown";
      /** @enum {string} */
      audioHealth: "unknown" | "healthy" | "degraded";
      /** Format: date-time */
      observedAt: string;
      reason?: string;
      /** @description Other computers may record from this source. */
      shared?: boolean;
      /** @description The device whose take this computer is recording. One take holds every source until it ends. */
      recordingFor?: components["schemas"]["DeviceIdentity"];
    };
    AudioSourceList: {
      sources: components["schemas"]["AudioSource"][];
      sharingHost?: components["schemas"]["SharingHost"];
    };
    /** @description The computer whose sources are listed. */
    SharingHost: {
      name: string;
      /** @description The request came from that computer, so it may change sharing. */
      local: boolean;
    };
    AudioSourceSharing: {
      source: components["schemas"]["AudioSourceIdentity"];
      shared: boolean;
    };
    RemoteCapture: {
      continuationID?: components["schemas"]["UUID"];
      source: components["schemas"]["AudioSourceIdentity"];
      /** @enum {string} */
      state: "preparing" | "recording" | "stopping" | "sealed" | "stopped";
      peak?: number;
    };
    StartCaptureRequest: {
      buttonTicket?: components["schemas"]["UUID"];
      requestID: components["schemas"]["UUID"];
      device: components["schemas"]["DeviceIdentity"];
      /** @enum {string} */
      mode: "dictation" | "test";
      source: components["schemas"]["AudioSourceIdentity"];
    };
    StopCaptureRequest: {
      continuationID?: components["schemas"]["UUID"];
    };
    CreateGenerationRequest: {
      requestID: components["schemas"]["UUID"];
      device: components["schemas"]["DeviceIdentity"];
      mode: components["schemas"]["GenerationMode"];
    };
    AudioStreamFormat: {
      sampleRate: number;
      channels: number;
    };
    AudioChunkReceipt: {
      nextSequence: number;
      /** Format: int64 */
      frameCount: number;
    };
    FinishGenerationRequest: {
      /** Format: int64 */
      inferenceFrames: number;
      /** Format: int64 */
      originalFrames?: number;
      continuationID?: components["schemas"]["UUID"];
    };
    AudioArtifact: {
      filename: string;
      sampleRate: number;
      channels: number;
      /** Format: int64 */
      frameCount: number;
      /** Format: int64 */
      byteCount: number;
      encoding: string;
    };
    ModelProvenance: {
      modelID: string;
      modelSHA256?: string;
      backend: string;
      engineVersion?: string;
      processingSeconds?: number;
    };
    DeliveryReceipt: {
      status: string;
      message?: string;
      /** Format: date-time */
      reportedAt: string;
    };
    ModelHintUsage: {
      includedTerms: string[];
      omittedTerms: string[];
      tokenCount?: number;
      tokenBudget?: number;
    };
    SpokenListContext: {
      style: components["schemas"]["SpokenListStyle"];
      nextNumber: number;
    };
    ListControlSpan: {
      location: number;
      length: number;
    };
    TextRepairSpan: {
      locationUTF16: number;
      lengthUTF16: number;
      text: string;
    };
    VerifiedTextRepair: {
      abandoned: components["schemas"]["TextRepairSpan"];
      cue: components["schemas"]["TextRepairSpan"];
      replacement: components["schemas"]["TextRepairSpan"];
    };
    TextProcessingRecord: {
      dictionaryTerms: string[];
      dictionaryChangedText: boolean;
      inputText: string;
      outputText: string;
      enabled: boolean;
      status: components["schemas"]["TextProcessingStatus"];
      reason?: string;
      modelID?: string;
      modelSHA256?: string;
      engineVersion?: string;
      processingSeconds?: number;
      wallSeconds?: number;
      proposedText?: string;
      verifiedRepairs?: components["schemas"]["VerifiedTextRepair"][];
    };
    DictationContinuation: {
      list?: components["schemas"]["SpokenListContext"];
      preview: string;
      boundary: components["schemas"]["DictationBoundary"];
    };
    WisprFlowArtifactManifest: {
      filename: components["schemas"]["WisprFlowArtifactName"];
      byteCount: number;
      sha256: string;
    };
    WisprFlowImportRequest: {
      sourceID: components["schemas"]["UUID"];
      /** Format: date-time */
      createdAt: string;
      sourceStatus?: string;
      finalText: string;
      rawText: string;
      durationSeconds?: number;
      variantNames: string[];
      artifacts: components["schemas"]["WisprFlowArtifactManifest"][];
      unarchivedArtifacts?: components["schemas"]["WisprFlowArtifactManifest"][];
    };
    WisprFlowImportSession: {
      id: components["schemas"]["UUID"];
    };
    WisprFlowArtifactReceipt: {
      filename: components["schemas"]["WisprFlowArtifactName"];
      byteCount: number;
    };
    WisprFlowKnownIDsRequest: {
      sourceIDs: components["schemas"]["UUID"][];
    };
    WisprFlowKnownIDsResponse: {
      knownSourceIDs: components["schemas"]["UUID"][];
    };
    WisprFlowDictionaryArchiveReceipt: {
      byteCount: number;
      sha256: string;
    };
    ImportedSource: {
      provider: string;
      sourceID: components["schemas"]["UUID"];
      sourceStatus?: string;
      /** Format: date-time */
      importedAt: string;
      variantNames: string[];
      artifactNames: components["schemas"]["WisprFlowArtifactName"][];
      durationSeconds?: number;
      sourceSHA256: string;
      artifactSHA256: {
        [key: string]: string;
      };
      unarchivedArtifactSHA256?: {
        [key: string]: string;
      };
    };
    GenerationRecord: {
      capture?: components["schemas"]["RemoteCapture"];
      schemaVersion: number;
      id: components["schemas"]["UUID"];
      requestID: components["schemas"]["UUID"];
      device: components["schemas"]["DeviceIdentity"];
      mode: components["schemas"]["GenerationMode"];
      status: components["schemas"]["GenerationStatus"];
      /** Format: date-time */
      createdAt: string;
      /** Format: date-time */
      updatedAt: string;
      settings: components["schemas"]["PreferencesSnapshot"];
      recognition?: components["schemas"]["RecognitionState"];
      inferenceAudio?: components["schemas"]["AudioArtifact"];
      originalAudio?: components["schemas"]["AudioArtifact"];
      rawText: string;
      finalText: string;
      insertionText: string;
      previewText: string;
      detectedLanguage?: string;
      speech?: components["schemas"]["ModelProvenance"];
      proofreading?: components["schemas"]["ModelProvenance"];
      textProcessing?: components["schemas"]["TextProcessingRecord"];
      recognitionHints?: components["schemas"]["ModelHintUsage"];
      proofreadingHints?: components["schemas"]["ModelHintUsage"];
      formattingRejectionReason?: string;
      consumedListControls?: components["schemas"]["ListControlSpan"][];
      continuation?: components["schemas"]["DictationContinuation"];
      delivery?: components["schemas"]["DeliveryReceipt"];
      error?: string;
      progress?: number;
      importedSource?: components["schemas"]["ImportedSource"];
    };
    GenerationPage: {
      items: components["schemas"]["GenerationRecord"][];
      nextCursor?: string;
    };
    WisprFlowImportResult: {
      outcome: components["schemas"]["WisprFlowImportOutcome"];
      record: components["schemas"]["GenerationRecord"];
      unarchivedArtifactNames: components["schemas"]["WisprFlowArtifactName"][];
    };
    APIErrorResponse: {
      code: string;
      message: string;
    };
    RecordingCapabilities: {
      /** @enum {string} */
      protocol: "sottoduo.recording.v1";
      maximumPCMBytes: number;
    };
    RecordingRunEndpoint: {
      runID: components["schemas"]["UUID"];
      inferenceFrames: number;
      originalFrames?: number;
    };
    RecordingStreamCheckpoint: {
      runID: components["schemas"]["UUID"];
      kind: components["schemas"]["AudioKind"];
      format: components["schemas"]["AudioStreamFormat"];
      nextSequence: number;
      frameCount: number;
    };
    RecordingSnapshot: {
      id: components["schemas"]["UUID"];
      requestID: components["schemas"]["UUID"];
      device: components["schemas"]["DeviceIdentity"];
      mode: components["schemas"]["GenerationMode"];
      settings: components["schemas"]["PreferencesSnapshot"];
      /** Format: date-time */
      createdAt: string;
      revision: number;
      /** @enum {string} */
      captureState: "recording" | "interrupted" | "stopped" | "discarded";
      /** @enum {string} */
      processingState: "queued" | "processing" | "completed" | "failed";
      uploadedFrames: number;
      transcribedFrames: number;
      proofreadFrames: number;
      streams: components["schemas"]["RecordingStreamCheckpoint"][];
      epoch: number;
      stopRuns?: components["schemas"]["RecordingRunEndpoint"][];
      error?: string;
      capture?: components["schemas"]["RemoteCapture"];
      recognition?: components["schemas"]["RecognitionState"];
      previewText: string;
      continuationID?: components["schemas"]["UUID"];
      closedRuns?: components["schemas"]["RecordingRunEndpoint"][];
      runTimings?: components["schemas"]["RecordingRunTiming"][];
    };
    RecordingDetail: {
      snapshot: components["schemas"]["RecordingSnapshot"];
      result?: components["schemas"]["GenerationRecord"];
    };
    RecordingPage: {
      items: components["schemas"]["RecordingSnapshot"][];
      nextCursor?: string;
    };
    RecordingAudioHeader: {
      /** @enum {string} */
      type: "audio";
      epoch: number;
      runID: components["schemas"]["UUID"];
      kind: components["schemas"]["AudioKind"];
      sequence: number;
      firstFrame: number;
      format: components["schemas"]["AudioStreamFormat"];
      frameCount: number;
      sha256: string;
    };
    RecordingStopRequest: {
      /** @enum {string} */
      type: "stop";
      epoch: number;
      runs: components["schemas"]["RecordingRunEndpoint"][];
      runTimings?: components["schemas"]["RecordingRunTiming"][];
    };
    RecordingAck: {
      /** @enum {string} */
      type: "ack";
      runID: components["schemas"]["UUID"];
      kind: components["schemas"]["AudioKind"];
      nextSequence: number;
      frameCount: number;
      revision: number;
    };
    RecordingContextRequest: {
      /** @enum {string} */
      type: "context";
      epoch: number;
      continuationID: components["schemas"]["UUID"];
    };
    RecordingRunTiming: {
      runID: components["schemas"]["UUID"];
      /** Format: date-time */
      startedAt: string;
      /** Format: date-time */
      endedAt?: string;
      gapBeforeMilliseconds?: number;
    };
    RecordingPauseRequest: {
      /** @enum {string} */
      type: "pause";
      epoch: number;
      runs: components["schemas"]["RecordingRunEndpoint"][];
      runTimings: components["schemas"]["RecordingRunTiming"][];
      interruption?: string;
    };
  };
  responses: {
    /** @description A request, admission, or server error. */
    APIError: {
      headers: {
        [name: string]: unknown;
      };
      content: {
        "application/json": components["schemas"]["APIErrorResponse"];
      };
    };
  };
  parameters: {
    /** @description Opt in to remote capture source/state fields; omit for the legacy generation shape. */
    CaptureView: "capture-v1";
    /** @description Required for remote-capture cancellation and delivery; omitted by local-upload clients. */
    CaptureMutationOwner: string;
    /** @description Client-generated 256-bit lowercase hexadecimal secret, unique per capture request. Required in addition to server authorization for remote recording control and delivery. Never put it in URLs or history. */
    CaptureOwner: string;
  };
  requestBodies: never;
  headers: never;
  pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
  getButtonDestinations: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Live button-destination state. Selection and commands never survive expiry or restart. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ButtonDestinationState"];
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  registerButtonDestination: {
    parameters: {
      query?: never;
      header: {
        /** @description Fresh 256-bit secret for this in-memory destination registration. Never persist or log it. */
        "X-SottoDuo-Destination-Owner": string;
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["RegisterButtonDestination"];
      };
    };
    responses: {
      /** @description Live button-destination state. Selection and commands never survive expiry or restart. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ButtonDestinationState"];
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  heartbeatButtonDestination: {
    parameters: {
      query?: never;
      header: {
        /** @description Fresh 256-bit secret for this in-memory destination registration. Never persist or log it. */
        "X-SottoDuo-Destination-Owner": string;
      };
      path: {
        id: components["schemas"]["UUID"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["HeartbeatButtonDestination"];
      };
    };
    responses: {
      /** @description Live button-destination state. Selection and commands never survive expiry or restart. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ButtonDestinationState"];
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  selectButtonDestination: {
    parameters: {
      query?: never;
      header: {
        /** @description Fresh 256-bit secret for this in-memory destination registration. Never persist or log it. */
        "X-SottoDuo-Destination-Owner": string;
      };
      path: {
        id: components["schemas"]["UUID"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["SelectButtonDestination"];
      };
    };
    responses: {
      /** @description Live button-destination state. Selection and commands never survive expiry or restart. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ButtonDestinationState"];
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  completeButtonTake: {
    parameters: {
      query?: never;
      header: {
        /** @description Fresh 256-bit secret for this in-memory destination registration. Never persist or log it. */
        "X-SottoDuo-Destination-Owner": string;
      };
      path: {
        id: components["schemas"]["UUID"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["CompleteButtonTake"];
      };
    };
    responses: {
      /** @description Live button-destination state. Selection and commands never survive expiry or restart. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ButtonDestinationState"];
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  unregisterButtonDestination: {
    parameters: {
      query?: never;
      header: {
        /** @description Fresh 256-bit secret for this in-memory destination registration. Never persist or log it. */
        "X-SottoDuo-Destination-Owner": string;
      };
      path: {
        id: components["schemas"]["UUID"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Live button-destination state. Selection and commands never survive expiry or restart. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ButtonDestinationState"];
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  listAudioSources: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Bounded snapshot; discovery never starts audio or connects Bluetooth. Other computers only see shared sources. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AudioSourceList"];
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  setAudioSourceSharing: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["AudioSourceSharing"];
      };
    };
    responses: {
      /** @description Updated snapshot. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AudioSourceList"];
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  setButtonTarget: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["ButtonTarget"];
      };
    };
    responses: {
      /** @description Live button-destination state. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ButtonDestinationState"];
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  startCapture: {
    parameters: {
      query?: never;
      header: {
        /** @description Client-generated 256-bit lowercase hexadecimal secret, unique per capture request. Required in addition to server authorization for remote recording control and delivery. Never put it in URLs or history. */
        "X-SottoDuo-Capture-Owner": components["parameters"]["CaptureOwner"];
      };
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["StartCaptureRequest"];
      };
    };
    responses: {
      /** @description Admitted recording session with acknowledged microphone readiness. */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["RecordingSnapshot"];
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  heartbeatCapture: {
    parameters: {
      query?: never;
      header: {
        /** @description Client-generated 256-bit lowercase hexadecimal secret, unique per capture request. Required in addition to server authorization for remote recording control and delivery. Never put it in URLs or history. */
        "X-SottoDuo-Capture-Owner": components["parameters"]["CaptureOwner"];
      };
      path: {
        id: components["schemas"]["UUID"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Owner lease renewed. Send every second; expiry is six seconds. */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      default: components["responses"]["APIError"];
    };
  };
  stopCapture: {
    parameters: {
      query?: never;
      header: {
        /** @description Client-generated 256-bit lowercase hexadecimal secret, unique per capture request. Required in addition to server authorization for remote recording control and delivery. Never put it in URLs or history. */
        "X-SottoDuo-Capture-Owner": components["parameters"]["CaptureOwner"];
      };
      path: {
        id: components["schemas"]["UUID"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["StopCaptureRequest"];
      };
    };
    responses: {
      /** @description Capture stopped and its run sealed; processing continues to completion. */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["RecordingSnapshot"];
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  setCaptureContext: {
    parameters: {
      query?: never;
      header: {
        /** @description Client-generated 256-bit lowercase hexadecimal secret, unique per capture request. Required in addition to server authorization for remote recording control and delivery. Never put it in URLs or history. */
        "X-SottoDuo-Capture-Owner": components["parameters"]["CaptureOwner"];
      };
      path: {
        id: components["schemas"]["UUID"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["StopCaptureRequest"];
      };
    };
    responses: {
      /** @description Continuation fixed. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["RecordingSnapshot"];
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  recordingEvents: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: components["schemas"]["UUID"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description NDJSON RecordingSnapshot lines until the session completes, fails, or is discarded. */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/x-ndjson": string;
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  getHealth: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["ServerHealth"];
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  getPreferences: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["PreferencesSnapshot"];
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  updatePreferences: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["PreferencesSnapshot"];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["PreferencesSnapshot"];
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  listGenerations: {
    parameters: {
      query?: {
        limit?: number;
        before?: string;
        source?: "sottoduo" | "wispr-flow";
      };
      header?: {
        /** @description Opt in to remote capture source/state fields; omit for the legacy generation shape. */
        "X-SottoDuo-Capture"?: components["parameters"]["CaptureView"];
      };
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GenerationPage"];
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  createGeneration: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["CreateGenerationRequest"];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GenerationRecord"];
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  getGeneration: {
    parameters: {
      query?: never;
      header?: {
        /** @description Opt in to remote capture source/state fields; omit for the legacy generation shape. */
        "X-SottoDuo-Capture"?: components["parameters"]["CaptureView"];
      };
      path: {
        id: components["schemas"]["UUID"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GenerationRecord"];
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  deleteGeneration: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: components["schemas"]["UUID"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      default: components["responses"]["APIError"];
    };
  };
  appendAudio: {
    parameters: {
      query: {
        sequence: number;
        sampleRate: number;
        channels: number;
      };
      header?: never;
      path: {
        id: components["schemas"]["UUID"];
        kind: components["schemas"]["AudioKind"];
      };
      cookie?: never;
    };
    /** @description Raw interleaved little-endian float32 PCM. Chunks must contain whole frames. Repeated sequences must have identical bytes. */
    requestBody: {
      content: {
        "application/octet-stream": string;
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["AudioChunkReceipt"];
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  finishGeneration: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: components["schemas"]["UUID"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["FinishGenerationRequest"];
      };
    };
    responses: {
      /** @description Success */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GenerationRecord"];
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  cancelGeneration: {
    parameters: {
      query?: never;
      header?: {
        /** @description Opt in to remote capture source/state fields; omit for the legacy generation shape. */
        "X-SottoDuo-Capture"?: components["parameters"]["CaptureView"];
        /** @description Required for remote-capture cancellation and delivery; omitted by local-upload clients. */
        "X-SottoDuo-Capture-Owner"?: components["parameters"]["CaptureMutationOwner"];
      };
      path: {
        id: components["schemas"]["UUID"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GenerationRecord"];
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  retryGeneration: {
    parameters: {
      query?: never;
      header?: {
        /** @description Opt in to remote capture source/state fields; omit for the legacy generation shape. */
        "X-SottoDuo-Capture"?: components["parameters"]["CaptureView"];
      };
      path: {
        id: components["schemas"]["UUID"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Accepted */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GenerationRecord"];
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  recordDelivery: {
    parameters: {
      query?: never;
      header?: {
        /** @description Opt in to remote capture source/state fields; omit for the legacy generation shape. */
        "X-SottoDuo-Capture"?: components["parameters"]["CaptureView"];
        /** @description Required for remote-capture cancellation and delivery; omitted by local-upload clients. */
        "X-SottoDuo-Capture-Owner"?: components["parameters"]["CaptureMutationOwner"];
      };
      path: {
        id: components["schemas"]["UUID"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["DeliveryReceipt"];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GenerationRecord"];
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  generationEvents: {
    parameters: {
      query?: never;
      header?: {
        /** @description Opt in to remote capture source/state fields; omit for the legacy generation shape. */
        "X-SottoDuo-Capture"?: components["parameters"]["CaptureView"];
      };
      path: {
        id: components["schemas"]["UUID"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/x-ndjson": string;
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  downloadArtifact: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: components["schemas"]["UUID"];
        filename:
          | "inference.wav"
          | "original.wav"
          | "metadata.json"
          | "transcript.txt"
          | "source.json"
          | "source.wav"
          | "opus.json"
          | "screenshot.png"
          | "built-in-audio.bin";
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/octet-stream": string;
          "audio/wav": string;
          "image/png": string;
          "application/json": string;
          "text/plain": string;
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  knownWisprFlowIDs: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["WisprFlowKnownIDsRequest"];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WisprFlowKnownIDsResponse"];
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  beginWisprFlowImport: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["WisprFlowImportRequest"];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WisprFlowImportSession"];
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  archiveWisprFlowDictionary: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    /** @description Original Wispr Flow dictionary JSON archive. This does not change the active personal dictionary. */
    requestBody: {
      content: {
        "application/json": unknown;
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WisprFlowDictionaryArchiveReceipt"];
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  uploadWisprFlowArtifact: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: components["schemas"]["UUID"];
        filename: components["schemas"]["WisprFlowArtifactName"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/octet-stream": string;
        "application/json": string;
        "audio/wav": string;
        "image/png": string;
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WisprFlowArtifactReceipt"];
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  completeWisprFlowImport: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: components["schemas"]["UUID"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["WisprFlowImportResult"];
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  cancelWisprFlowImport: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: components["schemas"]["UUID"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      204: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      default: components["responses"]["APIError"];
    };
  };
  getRecordingCapabilities: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["RecordingCapabilities"];
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  listRecordings: {
    parameters: {
      query?: {
        limit?: number;
        before?: string;
      };
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["RecordingPage"];
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  createRecording: {
    parameters: {
      query?: never;
      header?: never;
      path?: never;
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["CreateGenerationRequest"];
      };
    };
    responses: {
      /** @description Success */
      201: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["RecordingSnapshot"];
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  getRecording: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: components["schemas"]["UUID"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["RecordingDetail"];
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  getRecordingTranscript: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: components["schemas"]["UUID"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "text/plain": string;
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  getRecordingAudio: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: components["schemas"]["UUID"];
        kind: components["schemas"]["AudioKind"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "audio/wav": string;
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  discardRecording: {
    parameters: {
      query?: never;
      header?: {
        /** @description Required for remote-capture cancellation and delivery; omitted by local-upload clients. */
        "X-SottoDuo-Capture-Owner"?: components["parameters"]["CaptureMutationOwner"];
      };
      path: {
        id: components["schemas"]["UUID"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["RecordingSnapshot"];
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  retryRecording: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: components["schemas"]["UUID"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Accepted */
      202: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["RecordingSnapshot"];
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  recordRecordingDelivery: {
    parameters: {
      query?: never;
      header?: {
        /** @description Required for remote-capture cancellation and delivery; omitted by local-upload clients. */
        "X-SottoDuo-Capture-Owner"?: components["parameters"]["CaptureMutationOwner"];
      };
      path: {
        id: components["schemas"]["UUID"];
      };
      cookie?: never;
    };
    requestBody: {
      content: {
        "application/json": components["schemas"]["DeliveryReceipt"];
      };
    };
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "application/json": components["schemas"]["GenerationRecord"];
        };
      };
      default: components["responses"]["APIError"];
    };
  };
  streamRecording: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: components["schemas"]["UUID"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description WebSocket upgrade */
      101: {
        headers: {
          [name: string]: unknown;
        };
        content?: never;
      };
      default: components["responses"]["APIError"];
    };
  };
  getRecordingRunAudio: {
    parameters: {
      query?: never;
      header?: never;
      path: {
        id: components["schemas"]["UUID"];
        kind: components["schemas"]["AudioKind"];
        runID: components["schemas"]["UUID"];
      };
      cookie?: never;
    };
    requestBody?: never;
    responses: {
      /** @description Success */
      200: {
        headers: {
          [name: string]: unknown;
        };
        content: {
          "audio/wav": string;
        };
      };
      default: components["responses"]["APIError"];
    };
  };
}
