import type { SchedulerRequestResult } from "./scheduler.js";

export interface TerminalOutcomeAudioRequester {
  request(event: "agentStart" | "agentAborted" | "agentSettled"): Promise<SchedulerRequestResult>;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finalAssistantWasAborted(messages: unknown): boolean {
  if (!Array.isArray(messages)) return false;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message: unknown = messages[index];
    if (isRecord(message) && message.role === "assistant") {
      return message.stopReason === "aborted";
    }
  }
  return false;
}

/**
 * Pure adapter from Pi's terminal run outcomes to the scheduler request API.
 * Hook registration and raw terminal input ownership intentionally remain outside this class.
 */
export class TerminalOutcomeRequestAdapter {
  readonly #requester: TerminalOutcomeAudioRequester;
  #nextGeneration = 0;
  #activeGeneration: number | null = null;
  #escapeGeneration: number | null = null;
  #abortedGeneration: number | null = null;

  constructor(requester: TerminalOutcomeAudioRequester) {
    this.#requester = requester;
  }

  async onAgentStart(): Promise<SchedulerRequestResult> {
    this.#nextGeneration += 1;
    this.#activeGeneration = this.#nextGeneration;
    this.#escapeGeneration = null;
    this.#abortedGeneration = null;
    return this.#requester.request("agentStart");
  }

  /** Record only an already-decoded literal physical Escape key. */
  onLiteralEscape(): void {
    if (this.#activeGeneration !== null) this.#escapeGeneration = this.#activeGeneration;
  }

  onAgentEnd(messages: unknown): void {
    const generation = this.#activeGeneration;
    if (
      generation !== null &&
      this.#escapeGeneration === generation &&
      finalAssistantWasAborted(messages)
    ) {
      this.#abortedGeneration = generation;
    }
  }

  async onAgentSettled(): Promise<SchedulerRequestResult> {
    const generation = this.#activeGeneration;
    const event =
      generation !== null && this.#abortedGeneration === generation
        ? "agentAborted"
        : "agentSettled";
    this.#activeGeneration = null;
    this.#escapeGeneration = null;
    this.#abortedGeneration = null;
    return this.#requester.request(event);
  }

  shutdown(): void {
    this.#activeGeneration = null;
    this.#escapeGeneration = null;
    this.#abortedGeneration = null;
  }
}
