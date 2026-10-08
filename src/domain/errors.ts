export type DomainErrorCode = "VALIDATION" | "NOT_FOUND" | "DNC" | "DEMO" | "CONFLICT" | "MERGED" | "FORBIDDEN" | "BLOCKED";

/** Очаквана бизнес грешка със смислено съобщение на български (без stack trace към клиента). */
export class DomainError extends Error {
  constructor(
    public code: DomainErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "DomainError";
  }
}
