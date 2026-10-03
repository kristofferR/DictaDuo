import { decodePersonalDictionary } from "../../../Server/src/domain/dictionary.ts";
import {
  defaultProofreadingPrompt,
  preferencesValidationError,
} from "../../../Server/src/domain/preferences.ts";
import { validateBody } from "../../../Server/src/validation.ts";
import { APIError, type API } from "./api.ts";
import { ClientNotice } from "./errors.ts";

export { defaultProofreadingPrompt };
export async function saveSharedPreferences(api: API, value: unknown) {
  if (
    value &&
    typeof value === "object" &&
    "preferences" in value &&
    value.preferences &&
    typeof value.preferences === "object" &&
    "dictionary" in value.preferences
  ) {
    const dictionary = decodePersonalDictionary(value.preferences.dictionary);
    if (dictionary.error) throw new ClientNotice(dictionary.error);
  }
  let snapshot;
  try {
    snapshot = validateBody("PreferencesSnapshot", value);
  } catch {
    throw new ClientNotice(
      "Check the settings: list names, preferred spellings and text cleanup instructions cannot be empty, and each word allows up to 8 replacement phrases.",
    );
  }
  const dictionary = decodePersonalDictionary(snapshot.preferences.dictionary);
  if (dictionary.error || !dictionary.value)
    throw new ClientNotice(dictionary.error ?? "Invalid dictionary.");
  const preferences = {
    ...snapshot.preferences,
    dictionary: dictionary.value,
    proofreadingPrompt: snapshot.preferences.proofreadingPrompt ?? defaultProofreadingPrompt,
  };
  const error = preferencesValidationError(preferences);
  if (error) throw new ClientNotice(error);
  const request = { ...snapshot, preferences };
  if (Buffer.byteLength(JSON.stringify(request)) > 262_144)
    throw new ClientNotice(
      "These shared settings exceed the server’s 256 KB limit. Shorten the dictionary or vocabulary before saving.",
    );
  try {
    return await api.savePreferences(request);
  } catch (error) {
    if (error instanceof APIError) {
      if (error.status === 409)
        throw new ClientNotice(
          "Another device changed shared settings. Your edits are still here. Discard and reload before editing again.",
        );
      if ([401, 403].includes(error.status))
        throw new ClientNotice(
          "The server rejected this connection’s access token. Check Connection in This computer.",
        );
      if (error.status === 413)
        throw new ClientNotice(
          "These settings exceed the server’s size limit. Reduce the dictionary or vocabulary.",
        );
      if (error.status === 400)
        throw new ClientNotice(
          "The server rejected these settings. Check the dictionary and text cleanup instructions, then try again.",
        );
    }
    throw new ClientNotice(
      "Could not confirm the save. Your edits are still here. Reload from the server before retrying.",
    );
  }
}
