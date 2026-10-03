import { ClientNotice } from "./errors.ts";
import { randomBytes, randomUUID } from "node:crypto";
import type { API, Device } from "./api.ts";
import type { Controller, Desktop } from "./controller.ts";
import type { components } from "../../../Server/src/generated/api.ts";
type State = components["schemas"]["ButtonDestinationState"];
type Registration = { id: string; owner: string; acknowledgement?: string };
/** Registration is consent for this process only; reconnecting never restores selection. */
export class ButtonDestinationClient {
  private registration?: Registration;
  private epoch = 0;
  private closed = false;
  private pending?: Promise<void>;
  private lastTick = Date.now();
  state?: State;
  constructor(
    private api: Pick<API, "buttonRequest">,
    private desktop: Pick<Desktop, "unlocked">,
    private controller: Controller,
    private device: Device,
    private receiving = true,
  ) {}
  get enabled() {
    return this.receiving && !this.closed;
  }
  get selectedHere() {
    return this.registration !== undefined && this.state?.selected?.id === this.registration.id;
  }
  async setEnabled(enabled: boolean) {
    if (this.closed)
      throw new ClientNotice("Restart the client before changing DJI button settings.");
    if (this.controller.busy)
      throw new ClientNotice("Finish dictation before changing DJI button settings.");
    if (this.receiving === enabled) return;
    this.receiving = enabled;
    this.lastTick = Date.now();
    if (!enabled) await this.disarm();
  }
  start() {
    this.controller.onStart = (ticket) => {
      // Each keyboard take remembers the registration it began under.
      return ticket ? undefined : this.registration;
    };
    this.controller.onComplete = (id, ticket, succeeded, keyboardRegistration) => {
      const registration = this.registration;
      if (!registration) return;
      if (ticket)
        void this.request(registration, "/complete", { takeID: ticket }).catch(() => {
          if (this.registration === registration) return this.disarm();
        });
      else if (succeeded && id && keyboardRegistration === registration)
        void this.select(id).catch(() => {});
    };
    this.pending ??= this.loop();
  }
  private async request(registration: Registration, path: string, body: unknown) {
    const state = await this.api.buttonRequest(
      `/${registration.id}${path}`,
      registration.owner,
      body,
    );
    if (this.registration === registration) this.state = state;
    return state;
  }
  async select(generationID?: string) {
    const registration = this.registration;
    if (
      !this.enabled ||
      !registration ||
      !(await this.desktop.unlocked()) ||
      this.registration !== registration
    )
      throw new ClientNotice("The button destination is not connected and unlocked.");
    // A completed keyboard take may reselect while a newer take is still queued.
    if (!generationID && this.controller.busy)
      throw new ClientNotice("Finish dictation before changing its destination.");
    if (!this.state?.available)
      throw new ClientNotice("The DJI receiver is unavailable. Check receiver status.");
    return this.request(registration, "/select", generationID ? { generationID } : {});
  }
  async disarm() {
    ++this.epoch;
    const registration = this.registration;
    this.registration = undefined;
    this.state = undefined;
    await this.controller.cancelButton();
    if (registration)
      await this.api
        .buttonRequest(`/${registration.id}`, registration.owner, undefined, "DELETE")
        .catch(() => {});
  }
  async close() {
    this.closed = true;
    this.controller.onComplete = undefined;
    this.controller.onStart = undefined;
    await this.disarm();
    await this.pending;
  }
  private async loop() {
    while (!this.closed) {
      try {
        await this.tick();
      } catch {
        await this.disarm();
      }
      this.lastTick = Date.now();
      if (!this.closed) await Bun.sleep(1000);
    }
  }
  async tick() {
    if (!this.enabled) return;
    const epoch = this.epoch;
    const now = Date.now();
    const slept = now - this.lastTick > 3000 || now < this.lastTick;
    if (slept || !(await this.desktop.unlocked())) {
      await this.disarm();
      return;
    }
    if (!this.enabled || epoch !== this.epoch) return;
    if (!this.registration) {
      const registration = {
        id: randomUUID().toUpperCase(),
        owner: randomBytes(32).toString("hex"),
      };
      const state = await this.api.buttonRequest("", registration.owner, {
        id: registration.id,
        device: this.device,
      });
      if (this.closed || epoch !== this.epoch) {
        await this.api
          .buttonRequest(`/${registration.id}`, registration.owner, undefined, "DELETE")
          .catch(() => {});
        return;
      }
      this.registration = registration;
      this.state = state;
    }
    const registration = this.registration;
    const state = await this.request(registration, "/heartbeat", {
      acknowledgement: registration.acknowledgement,
    });
    if (this.closed || epoch !== this.epoch || this.registration !== registration) return;
    const command = state.command;
    if (!command || command.id === registration.acknowledgement) return;
    registration.acknowledgement = command.id;
    if (Date.parse(command.expiresAt) <= Date.now()) {
      await this.disarm();
      return;
    }
    if (command.action === "cancel") await this.controller.cancelButton(command.takeID);
    else if (command.action === "stop") this.controller.stopButton(command.takeID);
    else {
      const unlocked = await this.desktop.unlocked();
      if (this.closed || epoch !== this.epoch || this.registration !== registration) return;
      if (!unlocked || Date.parse(command.expiresAt) <= Date.now()) {
        await this.disarm();
        return;
      }
      if (!this.controller.startButton(command.takeID, command.source))
        await this.request(registration, "/complete", { takeID: command.takeID });
    }
  }
}
