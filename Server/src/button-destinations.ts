import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { ServiceError } from "./errors.ts";
import type { GenerationService } from "./generation-service.ts";
import type { components } from "./generated/api.ts";
type Schema = components["schemas"];
type Destination = Schema["ButtonDestination"];
type Command = Schema["ButtonCommand"];
type Identity = Schema["AudioSourceIdentity"];
type Registration = { destination: Destination; hash: Buffer; until: number; command?: Command };
export const buttonLimits = {
  leaseMS: 5000,
  commandMS: 5000,
  debounceMS: 500,
  destinations: 8,
} as const;
const secret = (owner?: string) => {
  if (!owner || !/^[0-9a-f]{64}$/.test(owner))
    throw new ServiceError(
      403,
      "destination_owner_required",
      "Supply this destination's owner secret.",
    );
  return createHash("sha256").update(owner).digest();
};
const unavailable = () =>
  new ServiceError(409, "button_unavailable", "Select an available DJI button destination again.");
const key = (source: Identity) => JSON.stringify([source.hostID, source.id]);
interface Route {
  takeID: string;
  destinationID: string;
  source: Identity;
  controller: AbortController;
  phase: "preparing" | "recording" | "stopping";
  deadline: number;
  requestID?: string;
  ownerHash?: Buffer;
  generationID?: string;
}
/** Ephemeral destination consent. Hardware can request a take, but cannot open audio itself. */
export class ButtonDestinations {
  private registrations = new Map<string, Registration>();
  private selected?: string;
  private selectedAt = 0;
  private route?: Route;
  private source?: Identity;
  private inputEpoch?: string;
  private lastSequence = 0;
  private lastPress = -Infinity;
  private timer: ReturnType<typeof setInterval>;
  private closed = false;
  constructor(
    private service: Pick<GenerationService, "captures" | "resolveResult">,
    private now = Date.now,
  ) {
    this.timer = setInterval(() => this.expire(), 250);
    this.timer.unref();
  }
  input(source: Identity | undefined, epoch?: string) {
    if (this.closed) return;
    if (
      epoch !== this.inputEpoch ||
      (source && this.source && key(source) !== key(this.source)) ||
      !source
    ) {
      this.disarm();
      this.lastSequence = 0;
      this.lastPress = -Infinity;
    }
    this.source = source;
    this.inputEpoch = epoch;
  }
  private eligible() {
    if (!this.source || !this.inputEpoch) return false;
    try {
      const source = this.service.captures
        .sources()
        .sources.find((s) => key(s.identity) === key(this.source!));
      return (
        source?.present === true &&
        source.capture === "available" &&
        source.link === "connected" &&
        source.transport === "usb" &&
        source.audioHealth !== "degraded"
      );
    } catch {
      return false;
    }
  }
  private expire() {
    const now = this.now();
    for (const [id, registration] of this.registrations)
      if (registration.until <= now) this.remove(id);
    if (this.selected && !this.eligible()) this.disarm();
    if (
      this.route &&
      ((this.route.phase === "preparing" && this.route.deadline <= now) ||
        (this.registrations.get(this.route.destinationID)?.command &&
          Date.parse(this.registrations.get(this.route.destinationID)!.command!.expiresAt) <= now))
    )
      this.disarm();
  }
  private authorize(id: string, owner?: string) {
    this.expire();
    const registration = this.registrations.get(id.toUpperCase());
    const hash = secret(owner);
    if (!registration || !timingSafeEqual(registration.hash, hash))
      throw new ServiceError(
        403,
        "destination_owner_mismatch",
        "The destination is absent, expired, or owned by another client process.",
      );
    return registration;
  }
  register(request: Schema["RegisterButtonDestination"], owner?: string) {
    if (this.closed) throw unavailable();
    this.expire();
    const hash = secret(owner);
    const id = request.id.toUpperCase();
    const existing = this.registrations.get(id);
    if (existing) {
      if (
        !timingSafeEqual(existing.hash, hash) ||
        existing.destination.device.id !== request.device.id
      )
        throw unavailable();
      existing.until = this.now() + buttonLimits.leaseMS;
      return this.state(id);
    }
    const replacements = [...this.registrations].filter(
      ([, registration]) => registration.destination.device.id === request.device.id,
    );
    if (replacements.some(([, registration]) => !timingSafeEqual(registration.hash, hash)))
      throw unavailable();
    for (const [other] of replacements) this.remove(other);
    if (this.registrations.size >= buttonLimits.destinations)
      throw new ServiceError(429, "too_many_destinations", "Too many connected destinations.");
    this.registrations.set(id, {
      destination: { id, device: structuredClone(request.device) },
      hash,
      until: this.now() + buttonLimits.leaseMS,
    });
    return this.state(id);
  }
  heartbeat(id: string, request: Schema["HeartbeatButtonDestination"], owner?: string) {
    const registration = this.authorize(id, owner);
    registration.until = this.now() + buttonLimits.leaseMS;
    if (request.acknowledgement?.toUpperCase() === registration.command?.id)
      delete registration.command;
    return this.state(id);
  }
  async select(id: string, request: Schema["SelectButtonDestination"], owner?: string) {
    let registration = this.authorize(id, owner);
    if (this.route || !this.eligible()) throw unavailable();
    if (request.generationID) {
      const record = await this.service.resolveResult(request.generationID);
      registration = this.authorize(id, owner);
      if (
        this.route ||
        !this.eligible() ||
        record.device.id !== registration.destination.device.id ||
        record.mode !== "dictation" ||
        record.status !== "completed" ||
        !record.insertionText.trim() ||
        Date.parse(record.createdAt) <= this.selectedAt ||
        this.now() - Date.parse(record.updatedAt) > 10000
      )
        throw unavailable();
    }
    this.selected = id.toUpperCase();
    this.selectedAt = this.now();
    return this.state(id);
  }
  unregister(id: string, owner?: string) {
    this.authorize(id, owner);
    this.remove(id.toUpperCase());
    return this.state();
  }
  complete(id: string, takeID: string, owner?: string) {
    this.authorize(id, owner);
    if (
      this.route?.destinationID === id.toUpperCase() &&
      this.route.takeID === takeID.toUpperCase()
    ) {
      this.route.controller.abort();
      this.route = undefined;
      delete this.registrations.get(id.toUpperCase())!.command;
    }
    return this.state(id);
  }
  private remove(id: string) {
    if (this.selected === id || this.route?.destinationID === id) this.disarm();
    this.registrations.delete(id);
  }
  private disarm() {
    const route = this.route;
    this.selected = undefined;
    this.route = undefined;
    if (route) {
      route.controller.abort();
      const registration = this.registrations.get(route.destinationID);
      if (registration) registration.command = this.command("cancel", route);
    }
  }
  private command(action: Command["action"], route: Route): Command {
    return {
      id: randomUUID().toUpperCase(),
      takeID: route.takeID,
      action,
      source: structuredClone(route.source),
      expiresAt: new Date(Math.floor((this.now() + buttonLimits.commandMS) / 1000) * 1000)
        .toISOString()
        .replace(/\.\d{3}Z$/, "Z"),
    };
  }
  /** Only a verified, device-scoped native monitor calls this. No public button injection route. */
  press(epoch: string, sequence: number) {
    this.expire();
    if (
      epoch !== this.inputEpoch ||
      !Number.isSafeInteger(sequence) ||
      sequence <= this.lastSequence
    )
      return;
    this.lastSequence = sequence;
    if (this.now() - this.lastPress < buttonLimits.debounceMS) return;
    this.lastPress = this.now();
    const registration = this.selected ? this.registrations.get(this.selected) : undefined;
    if (!registration || !this.source || !this.eligible()) return;
    if (this.route) {
      if (this.route.phase === "preparing") {
        this.disarm();
        return;
      }
      if (this.route.phase === "stopping") return;
      this.route.phase = "stopping";
      registration.command = this.command("stop", this.route);
      return;
    }
    this.route = {
      takeID: randomUUID().toUpperCase(),
      destinationID: this.selected!,
      source: structuredClone(this.source),
      controller: new AbortController(),
      phase: "preparing",
      deadline: this.now() + buttonLimits.commandMS,
    };
    registration.command = this.command("start", this.route);
  }
  claim(request: Schema["StartCaptureRequest"], owner?: string) {
    this.expire();
    const route = this.route;
    const hash = secret(owner);
    if (
      !route ||
      route.takeID !== request.buttonTicket?.toUpperCase() ||
      route.destinationID !== this.selected ||
      route.controller.signal.aborted ||
      !this.eligible() ||
      key(request.source) !== key(route.source) ||
      request.mode !== "dictation" ||
      this.registrations.get(route.destinationID)?.destination.device.id !== request.device.id
    )
      throw unavailable();
    if (
      route.requestID &&
      (route.requestID !== request.requestID.toUpperCase() ||
        !timingSafeEqual(route.ownerHash!, hash))
    )
      throw unavailable();
    route.requestID = request.requestID.toUpperCase();
    route.ownerHash = hash;
    return {
      signal: route.controller.signal,
      admitted: (id: string) => {
        route.generationID = id;
      },
      ready: () => {
        this.expire();
        if (route.controller.signal.aborted) throw unavailable();
        route.phase = "recording";
      },
    };
  }
  state(id?: string): Schema["ButtonDestinationState"] {
    this.expire();
    return {
      destinations: [...this.registrations.values()].map((r) => structuredClone(r.destination)),
      selected: this.selected
        ? structuredClone(this.registrations.get(this.selected)?.destination)
        : undefined,
      source: this.source ? structuredClone(this.source) : undefined,
      available: this.eligible(),
      command: id ? structuredClone(this.registrations.get(id.toUpperCase())?.command) : undefined,
    };
  }
  shutdown() {
    this.closed = true;
    clearInterval(this.timer);
    this.disarm();
    this.registrations.clear();
    this.source = undefined;
    this.inputEpoch = undefined;
  }
}
