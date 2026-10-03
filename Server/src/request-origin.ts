import type { FastifyRequest } from "fastify";

/**
 * The request comes from the computer running this server, which also hosts
 * its microphones: over loopback, or from one of its own addresses. A request a
 * reverse proxy forwarded is never local, even when the proxy runs here.
 */
export const isLocal = (request: FastifyRequest) => {
  const headers = request.headers;
  if (headers["forwarded"] || headers["x-forwarded-for"] || headers["x-real-ip"]) return false;
  const address = (value?: string) => value?.replace(/^::ffff:/, "");
  const remote = address(request.socket.remoteAddress);
  return (
    !!remote &&
    (remote === "127.0.0.1" || remote === "::1" || remote === address(request.socket.localAddress))
  );
};
