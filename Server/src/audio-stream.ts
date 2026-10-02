import websocket from "@fastify/websocket";
import type { FastifyInstance } from "fastify";
import type { GenerationService } from "./generation-service.ts";
import { ServiceError } from "./errors.ts";

/** Additive transport; archive validation and acknowledgements remain in GenerationService. */
export function registerAudioStream(app: FastifyInstance, service: GenerationService) {
  // Encapsulated so the v2 recording routes can register their own socket options.
  app.register(async (routes) => {
    await routes.register(websocket, { options: { maxPayload: 64_004 } });
    routes.get<{ Params: { id: string } }>(
      "/v1/generations/:id/stream",
      {
        websocket: true,
        preValidation: async (request) => {
          await service.requireClientUpload(request.params.id);
          const record = await service.get(request.params.id);
          if (record.status !== "receiving")
            throw new ServiceError(409, "upload_closed", "Recording is no longer accepting audio.");
        },
      },
      (socket, request) => {
        const id = request.params.id;
        let queuedBytes = 0,
          queuedMessages = 0;
        let ended = false,
          closed = false;
        let queue = Promise.resolve();
        const send = (value: unknown) => {
          if (socket.readyState !== socket.OPEN) return;
          if (socket.bufferedAmount > 262_144) {
            socket.close(1008, "Slow consumer");
            return;
          }
          socket.send(JSON.stringify(value));
        };
        const fail = (error: unknown) => {
          if (closed) return;
          send({
            type: "error",
            message: error instanceof ServiceError ? error.message : "Audio streaming failed.",
          });
          closed = true;
          socket.close(1008, "Audio stream rejected");
        };
        socket.on("error", () => {
          closed = true;
        });
        socket.on("message", (data, binary) => {
          if (closed) return;
          const bytes = Buffer.isBuffer(data)
            ? data
            : data instanceof ArrayBuffer
              ? Buffer.from(data)
              : Buffer.concat(data);
          queuedBytes += bytes.length;
          queuedMessages++;
          if (queuedBytes > 128_008 || queuedMessages > 64) {
            fail(new ServiceError(413, "backlog", "Audio upload could not keep up."));
            return;
          }
          queue = queue
            .then(async () => {
              if (closed) return;
              if (ended)
                throw new ServiceError(409, "audio_ended", "Inference audio has already ended.");
              if (binary) {
                if (bytes.length <= 4 || (bytes.length - 4) % 4 !== 0)
                  throw new ServiceError(
                    400,
                    "invalid_frame",
                    "Supply a sequence number followed by float32 PCM.",
                  );
                const receipt = await service.appendAudio(
                  id,
                  "inference",
                  bytes.readUInt32LE(0),
                  { sampleRate: 16000, channels: 1 },
                  bytes.subarray(4),
                );
                send({ type: "ack", ...receipt });
              } else {
                const message: unknown = JSON.parse(bytes.toString("utf8"));
                if (
                  !message ||
                  typeof message !== "object" ||
                  !("type" in message) ||
                  message.type !== "end" ||
                  !("frameCount" in message) ||
                  typeof message.frameCount !== "number"
                )
                  throw new ServiceError(
                    400,
                    "invalid_control",
                    "Supply an end message with the final frame count.",
                  );
                await service.endInference(id, message.frameCount);
                ended = true;
                send({ type: "ended", frameCount: message.frameCount });
              }
            })
            .catch(fail)
            .finally(() => {
              queuedBytes -= bytes.length;
              queuedMessages--;
            });
        });
        // Reuse the coordinator's bounded watcher queue; never write previews to disk per token.
        let updates: AsyncIterator<Awaited<ReturnType<typeof service.get>>> | undefined;
        socket.on("close", () => {
          closed = true;
          void updates?.return?.();
        });
        void (async () => {
          updates = (await service.events(id))[Symbol.asyncIterator]();
          if (closed) {
            await updates.return?.();
            return;
          }
          let previous = "";
          while (!closed) {
            const next = await updates.next();
            if (next.done || closed) break;
            const recognition = next.value.recognition;
            const encoded = JSON.stringify(recognition);
            if (recognition && encoded !== previous) {
              previous = encoded;
              send({ type: "recognition", recognition });
            }
          }
        })().catch(fail);
      },
    );
  });
}
