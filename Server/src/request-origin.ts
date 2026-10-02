import type { FastifyRequest } from "fastify";

/**
 * The request comes from the computer running this server, which also hosts
 * its microphones: over loopback, or from one of its own addresses.
 */
export const isLocal = (request: FastifyRequest) => {
  const address = (value?: string) => value?.replace(/^::ffff:/, "");
  const remote = address(request.socket.remoteAddress);
  return (
    !!remote &&
    (remote === "127.0.0.1" || remote === "::1" || remote === address(request.socket.localAddress))
  );
};
