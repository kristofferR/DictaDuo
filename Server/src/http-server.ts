import { registerAudioStream } from "./audio-stream.ts";
import { timingSafeEqual } from "node:crypto";
import { Readable } from "node:stream";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import {
  MAXIMUM_ARTIFACT_BYTES,
  MAXIMUM_CHUNK_BYTES,
  MAXIMUM_DICTIONARY_BYTES,
  type GenerationRecord,
  type WisprFlowArtifactName,
} from "./api.ts";
import { ServiceError } from "./errors.ts";
import type { GenerationService } from "./generation-service.ts";
import { validateBody } from "./validation.ts";
import { isLocal } from "./request-origin.ts";
import type { RecordingService } from "./recording-service.ts";
import { registerRecordingRoutes } from "./recording-routes.ts";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const identifier = (value: string) => {
  if (!uuidPattern.test(value))
    throw new ServiceError(400, "invalid_id", "A recording ID must be a UUID.");
  return value.toLowerCase();
};
const integer = (value: string | undefined) =>
  value !== undefined && /^-?\d+$/.test(value) && Number.isSafeInteger(Number(value))
    ? Number(value)
    : undefined;
export function isLoopbackAuthority(value: string | undefined) {
  if (!value) return false;
  const match = /^(localhost|127\.0\.0\.1|\[::1\])(?::(\d+))?$/i.exec(value);
  return (
    !!match && (match[2] === undefined || (Number(match[2]) >= 1 && Number(match[2]) <= 65535))
  );
}
const equal = (left: string, right: string) => {
  const a = Buffer.from(left),
    b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};
const bytes = (value: unknown) => {
  if (!Buffer.isBuffer(value))
    throw new ServiceError(400, "invalid_chunk", "Supply a binary request body.");
  return value;
};
const artifactNames = new Set<WisprFlowArtifactName>([
  "source.json",
  "source.wav",
  "opus.json",
  "screenshot.png",
  "built-in-audio.bin",
]);
const artifactName = (value: string) => {
  if (!artifactNames.has(value as WisprFlowArtifactName))
    throw new ServiceError(
      400,
      "invalid_source_artifact",
      "Choose an allowlisted source artifact.",
    );
  return value as WisprFlowArtifactName;
};

type IDParams = { id: string };
export const languageV2 = (request: FastifyRequest) =>
  request.headers["x-sottoduo-language"] === "language-v2";
// v1 clients generated before streaming reject unknown fields, even optional ones.
const encodeFor = (request: FastifyRequest) => {
  const path = request.url.split("?")[0]!;
  return (value: unknown) =>
    JSON.stringify(value, (key, item) => {
      if (
        key === "generationRetry" &&
        request.headers["x-sottoduo-generation-retry"] !== "retry-v1"
      )
        return undefined;
      if (
        (key === "recognitionEngine" || key === "recognitionEngines") &&
        request.headers["x-sottoduo-recognition-engine"] !== "engine-v1"
      )
        return undefined;
      if (
        (key === "shared" ||
          key === "recordingFor" ||
          key === "sharingHost" ||
          key === "buttonTarget") &&
        request.headers["x-sottoduo-microphone-sharing"] !== "sharing-v1"
      )
        return undefined;
      if (
        key === "cloudRecognition" &&
        request.headers["x-sottoduo-cloud-recognition"] !== "cloud-v1"
      )
        return undefined;
      if (key === "features" && request.headers["x-sottoduo-features"] !== "features-v1")
        return undefined;
      // Older clients decode the language list strictly and predate Norwegian.
      if (key === "language" && item === "no" && !languageV2(request)) return "auto";
      if (
        (key === "recognitionMode" || key === "recognition") &&
        request.headers["x-sottoduo-recognition"] !== "streaming-v1"
      )
        return undefined;
      if (
        key === "capture" &&
        typeof item === "object" &&
        request.headers["x-sottoduo-capture"] !== "capture-v1" &&
        path !== "/v1/captures" &&
        !path.includes("/capture/")
      )
        return undefined;
      return item;
    });
};
export const compactFeedback = (record: GenerationRecord) => ({
  feedbackDelta: 1 as const,
  id: record.id,
  status: record.status,
  capture: record.capture ?? null,
  recognition: record.recognition ?? null,
  progress: record.progress ?? null,
});
const captureOwner = (request: FastifyRequest) => {
  const value = request.headers["x-sottoduo-capture-owner"];
  return typeof value === "string" ? value : undefined;
};
export function createHTTPServer(
  service: GenerationService,
  token?: string,
  beforeRoutes?: (app: FastifyInstance) => void,
  recordings?: RecordingService,
) {
  const app = Fastify({ logger: false, bodyLimit: 262_144 });
  beforeRoutes?.(app);
  registerAudioStream(app, service);
  const parseJSON = app.getDefaultJsonParser("error", "error");
  app.removeContentTypeParser("application/json");
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    if (body === "") done(null, undefined);
    else parseJSON(request, typeof body === "string" ? body : body.toString("utf8"), done);
  });
  app.addContentTypeParser(
    "application/octet-stream",
    { parseAs: "buffer" },
    (_request, body, done) => done(null, body),
  );
  app.addHook("onRequest", async (request) => {
    if (token === undefined && !isLoopbackAuthority(request.headers.host)) {
      throw new ServiceError(
        403,
        "host_rejected",
        "Tokenless connections must address localhost directly.",
      );
    }
    if (
      request.url.split("?")[0] !== "/v1/health" &&
      token !== undefined &&
      !equal(request.headers.authorization ?? "", `Bearer ${token}`)
    ) {
      throw new ServiceError(401, "unauthorized", "Connect with the server's access token.");
    }
    if (request.headers.origin !== undefined)
      throw new ServiceError(
        403,
        "origin_rejected",
        "Browser origins are not supported by this native-client API.",
      );
  });
  app.addHook("onSend", async (_request, reply) => {
    reply.header("Cache-Control", "no-store");
  });
  // v2 routes negotiate their own fields and must leave text bodies unquoted.
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/v2/")) reply.serializer(encodeFor(request));
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ServiceError)
      return reply.code(error.status).send({ code: error.code, message: error.message });
    const failure = error as { code?: string; statusCode?: number };
    if (failure.code === "FST_ERR_CTP_BODY_TOO_LARGE")
      return reply
        .code(413)
        .send({ code: "body_too_large", message: "The request exceeded its size limit." });
    if (failure.statusCode && failure.statusCode >= 400 && failure.statusCode < 500) {
      return reply.code(failure.statusCode).send({
        code: `http_${failure.statusCode}`,
        message: "The request could not be accepted.",
      });
    }
    return reply
      .code(500)
      .send({ code: "internal_error", message: "The server could not complete this request." });
  });
  app.setNotFoundHandler((_request, reply) =>
    reply.code(404).send({ code: "http_404", message: "Not found." }),
  );

  if (recordings) registerRecordingRoutes(app, recordings, service.captures);

  app.get("/v1/health", () => service.health());
  app.get("/v1/audio-sources", (request) => service.captures.sourcesFor(isLocal(request)));
  app.put("/v1/audio-sources/sharing", (request) => {
    const body = validateBody("AudioSourceSharing", request.body);
    return service.captures.setSharing(body.source, body.shared, isLocal(request));
  });
  const destinationOwner = (request: FastifyRequest) => {
    const value = request.headers["x-sottoduo-destination-owner"];
    return typeof value === "string" ? value : undefined;
  };
  app.get("/v1/button-destinations", () => service.buttons.state());
  app.put("/v1/button-destinations/target", (request) =>
    service.buttons.setTarget(validateBody("ButtonTarget", request.body)),
  );
  app.post("/v1/button-destinations", (request) =>
    service.buttons.register(
      validateBody("RegisterButtonDestination", request.body),
      destinationOwner(request),
    ),
  );
  app.post<{ Params: IDParams }>("/v1/button-destinations/:id/heartbeat", (request) =>
    service.buttons.heartbeat(
      identifier(request.params.id),
      validateBody("HeartbeatButtonDestination", request.body),
      destinationOwner(request),
    ),
  );
  app.post<{ Params: IDParams }>("/v1/button-destinations/:id/select", (request) =>
    service.buttons.select(
      identifier(request.params.id),
      validateBody("SelectButtonDestination", request.body),
      destinationOwner(request),
    ),
  );
  app.post<{ Params: IDParams }>("/v1/button-destinations/:id/complete", (request) =>
    service.buttons.complete(
      identifier(request.params.id),
      validateBody("CompleteButtonTake", request.body).takeID,
      destinationOwner(request),
    ),
  );
  app.delete<{ Params: IDParams }>("/v1/button-destinations/:id", (request) =>
    service.buttons.unregister(identifier(request.params.id), destinationOwner(request)),
  );
  app.get("/v1/preferences", () => service.getPreferences());
  app.put("/v1/preferences", async (request) => {
    const update = validateBody("PreferencesSnapshot", request.body);
    // An older client shows Norwegian as "auto"; saving that must not change it.
    if (
      !languageV2(request) &&
      update.preferences.language === "auto" &&
      (await service.getPreferences()).preferences.language === "no"
    )
      update.preferences.language = "no";
    return service.updatePreferences(update);
  });
  app.post("/v1/generations", async (request, reply) => {
    const record = await service.create(validateBody("CreateGenerationRequest", request.body));
    return reply.code(201).send(record);
  });
  app.get<{ Querystring: { limit?: string; before?: string; source?: string } }>(
    "/v1/generations",
    (request) => {
      const limit = request.query.limit === undefined ? 50 : integer(request.query.limit);
      if (limit === undefined)
        throw new ServiceError(400, "invalid_limit", "Invalid history page size.");
      return service.history(limit, request.query.before, request.query.source);
    },
  );
  app.get<{ Params: IDParams }>("/v1/generations/:id", (request) =>
    service.get(identifier(request.params.id)),
  );
  app.post<{
    Params: IDParams & { kind: string };
    Querystring: { sequence?: string; sampleRate?: string; channels?: string };
  }>("/v1/generations/:id/audio/:kind", { bodyLimit: MAXIMUM_CHUNK_BYTES }, async (request) => {
    await service.requireClientUpload(identifier(request.params.id));
    const kind = request.params.kind;
    const sequence = integer(request.query.sequence),
      sampleRate = integer(request.query.sampleRate),
      channels = integer(request.query.channels);
    if (
      (kind !== "inference" && kind !== "original") ||
      sequence === undefined ||
      sampleRate === undefined ||
      channels === undefined
    ) {
      throw new ServiceError(
        400,
        "invalid_audio_parameters",
        "Supply audio kind, sequence, sampleRate and channels.",
      );
    }
    return service.appendAudio(
      identifier(request.params.id),
      kind,
      sequence,
      { sampleRate, channels },
      bytes(request.body),
    );
  });
  app.post<{ Params: IDParams }>("/v1/generations/:id/finish", async (request, reply) => {
    await service.requireClientUpload(identifier(request.params.id));
    return reply
      .code(202)
      .send(
        await service.finish(
          identifier(request.params.id),
          validateBody("FinishGenerationRequest", request.body),
        ),
      );
  });
  app.post<{ Params: IDParams }>("/v1/generations/:id/cancel", async (request) => {
    await service.authorizeCapture(identifier(request.params.id), captureOwner(request));
    return service.cancel(identifier(request.params.id));
  });
  // Retrying needs no capture owner: only finished, failed or cancelled takes qualify.
  app.post<{ Params: IDParams }>("/v1/generations/:id/retry", async (request, reply) =>
    reply.code(202).send(await service.retry(identifier(request.params.id))),
  );
  app.post<{ Params: IDParams }>("/v1/generations/:id/delivery", async (request) => {
    await service.authorizeCapture(identifier(request.params.id), captureOwner(request));
    return service.recordDelivery(
      identifier(request.params.id),
      validateBody("DeliveryReceipt", request.body),
    );
  });
  app.delete<{ Params: IDParams }>("/v1/generations/:id", async (request, reply) => {
    await service.delete(identifier(request.params.id));
    return reply.code(204).send();
  });
  app.get<{ Params: IDParams }>("/v1/generations/:id/events", async (request, reply) => {
    const events = await service.events(identifier(request.params.id));
    const encode = encodeFor(request);
    const compact = request.headers["x-sottoduo-feedback"] === "compact-v1";
    const source = Readable.from(
      (async function* () {
        let first = true;
        for await (const record of events) {
          yield `${encode(first || !compact ? record : compactFeedback(record))}\n`;
          first = false;
        }
      })(),
      { objectMode: false },
    );
    reply.raw.once("close", () => {
      source.destroy();
    });
    return reply.type("application/x-ndjson").send(source);
  });
  app.get<{ Params: IDParams & { filename: string } }>(
    "/v1/generations/:id/artifacts/:filename",
    async (request, reply) => {
      const filename = request.params.filename;
      const file = await service.artifact(identifier(request.params.id), filename);
      return reply
        .type(
          filename.endsWith(".wav")
            ? "audio/wav"
            : filename.endsWith(".png")
              ? "image/png"
              : filename.endsWith(".json")
                ? "application/json"
                : "text/plain; charset=utf-8",
        )
        .send(file.createReadStream({ autoClose: true }));
    },
  );

  app.post("/v1/imports/wispr-flow/known", (request) =>
    service.knownWisprFlowIDs(validateBody("WisprFlowKnownIDsRequest", request.body)),
  );
  app.post("/v1/imports/wispr-flow", async (request, reply) =>
    reply
      .code(201)
      .send(
        await service.beginWisprFlowImport(validateBody("WisprFlowImportRequest", request.body)),
      ),
  );
  app.post<{ Params: IDParams }>("/v1/imports/wispr-flow/:id/complete", (request) =>
    service.completeWisprFlowImport(identifier(request.params.id)),
  );
  app.delete<{ Params: IDParams }>("/v1/imports/wispr-flow/:id", async (request, reply) => {
    await service.cancelWisprFlowImport(identifier(request.params.id));
    return reply.code(204).send();
  });
  app.register(async (raw) => {
    raw.removeContentTypeParser("application/json");
    raw.addContentTypeParser("application/json", { parseAs: "buffer" }, (_request, body, done) =>
      done(null, body),
    );
    raw.addContentTypeParser(
      ["audio/wav", "image/png"],
      { parseAs: "buffer" },
      (_request, body, done) => done(null, body),
    );
    raw.put<{ Params: IDParams & { filename: string } }>(
      "/v1/imports/wispr-flow/:id/artifacts/:filename",
      { bodyLimit: MAXIMUM_ARTIFACT_BYTES },
      (request) =>
        service.uploadWisprFlowArtifact(
          identifier(request.params.id),
          artifactName(request.params.filename),
          bytes(request.body),
        ),
    );
    raw.put(
      "/v1/imports/wispr-flow/dictionary",
      { bodyLimit: MAXIMUM_DICTIONARY_BYTES },
      (request) => service.archiveWisprFlowDictionary(bytes(request.body)),
    );
  });
  return app;
}
