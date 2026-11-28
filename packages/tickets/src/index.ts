/**
 * @dbbkp/tickets: Deploy King tickets.
 *
 * One package for the three sides of the contract, with no dependency besides Node, so the folder
 * can be copied as it is:
 *  - the control server signs tickets (signTicket, encodeTicket);
 *  - the desktop app asks classify() whether a request needs one, and which class to ask for;
 *  - the machine's API asks classify() the same question and checks the ticket (verifyTicket).
 */
export * from "./types";
export * from "./ticket";
export * from "./classify";
export { TRPC_MUTATIONS, MCP_TOOLS, REST_ROUTES, EXEMPT_PREFIXES, WS_MESSAGES, type Entry, type RestRule } from "./table";
