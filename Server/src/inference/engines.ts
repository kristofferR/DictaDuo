import type { RecognitionEngine, ServerPreferences } from "../api.ts";

export const engineName = (engine: RecognitionEngine) =>
  engine === "parakeet" ? "Parakeet" : "Whisper";

/** The selected engine. Settings frozen before engines were selectable used Whisper. */
export const selectedEngine = (preferences: Pick<ServerPreferences, "recognitionEngine">) =>
  preferences.recognitionEngine ?? "whisper";

/**
 * The engine a take runs on: its frozen selection, or Whisper, which is always
 * installed, when that engine has been uninstalled since. Omitted `installed`
 * means Whisper only.
 */
export const recognitionEngine = (
  preferences: Pick<ServerPreferences, "recognitionEngine">,
  installed: readonly RecognitionEngine[] | undefined,
): RecognitionEngine => {
  const engine = selectedEngine(preferences);
  return (installed ?? ["whisper"]).includes(engine) ? engine : "whisper";
};

/** The engine that recognized a result, by the version its helper reported. */
export const reportedEngine = (engineVersion: string | undefined): RecognitionEngine | undefined =>
  engineVersion === undefined
    ? undefined
    : engineVersion.startsWith("parakeet.cpp/")
      ? "parakeet"
      : "whisper";

/** Provenance for text a local engine recognized. */
export const localSpeechModel = (engine: RecognitionEngine) => ({
  modelID: engine === "parakeet" ? "parakeet-tdt-0.6b-v3" : "whisper-large-v3-turbo",
  backend: `${engine === "parakeet" ? "parakeet" : "whisper"}.cpp${process.platform === "darwin" ? "/Metal" : ""}`,
});

/** Parakeet detects its languages without reporting which one it heard. */
export const detectedLanguage = (language: string) => (language === "auto" ? undefined : language);
