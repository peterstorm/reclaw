/** The human-readable message of a thrown value, whatever was thrown. */
export function errorMessage(thrown: unknown): string {
  return thrown instanceof Error ? thrown.message : String(thrown);
}
