/**
 * Deploy King tickets: the shared types (the contract between the control server, the desktop app
 * and the machine's API).
 *
 * A ticket is the control server's signed "yes" for ONE deploy or change on ONE computer. The app
 * asks for it, sends it with the request in the `x-dk-ticket` header, and the API inside the machine
 * refuses to act without a valid one.
 */

export type TicketAction = "deploy" | "change" | "delete";

export interface TicketFields {
  v: 1;
  /** Which signing key, e.g. "2026-11" */
  kid: string;
  /** Account id */
  account: string;
  /** Device id: chosen by the app, registered with the control server */
  device: string;
  action: TicketAction;
  /** App name, "" when the action is not tied to one */
  app: string;
  /** Hex SHA-256 of the uploaded ZIP for a deploy from a ZIP or folder, else "" */
  sha256: string;
  /** 32 hex characters, good for one use */
  nonce: string;
  /** Unix seconds */
  iat: number;
  /** Unix seconds: iat + 300 */
  exp: number;
}

export interface Ticket extends TicketFields {
  /** base64url Ed25519 signature over signedBytes(fields) */
  sig: string;
}

export interface PublicKey {
  kid: string;
  alg: "Ed25519";
  /** base64 of the raw 32-byte key */
  publicKey: string;
}

/**
 * What a request needs. `zip: true` marks the two routes that carry a project ZIP: a ticket for them
 * may name the file's SHA-256, and the API then checks the uploaded bytes against it.
 */
export type RequestClass = { ticket: false } | { ticket: true; action: TicketAction; kind: string; zip?: true };

/** The HTTP header that carries a ticket in its wire form. */
export const TICKET_HEADER = "x-dk-ticket";

/** Seconds a ticket is still accepted after `exp`, for clocks that disagree a little. */
export const CLOCK_TOLERANCE_SECONDS = 60;

/** Why the API refused. HTTP 403 `{ error: { code, message } }`; for tRPC a FORBIDDEN error whose message starts with the code. */
export const TICKET_CODES = [
  "ticket_required",
  "ticket_invalid",
  "ticket_expired",
  "ticket_used",
  "ticket_wrong_device",
  "ticket_wrong_action",
  "ticket_wrong_file",
] as const;
export type TicketCode = (typeof TICKET_CODES)[number];

const MESSAGES: Record<TicketCode, string> = {
  ticket_required: "This needs approval from your Deploy King account. Do it from the Deploy King app while signed in.",
  ticket_invalid: "The approval for this action could not be checked. Try again from the Deploy King app.",
  ticket_expired: "The approval for this action has expired. Try again.",
  ticket_used: "This approval was already used once. Try again to get a new one.",
  ticket_wrong_device: "This approval was given for another computer.",
  ticket_wrong_action: "This approval was given for a different kind of action.",
  ticket_wrong_file: "The uploaded file is not the one that was approved.",
};

/** Plain English for a refusal, fit to show as it is. */
export function ticketMessage(code: TicketCode): string {
  return MESSAGES[code];
}
