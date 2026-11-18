/** One synchronous reservation ledger shared by all model calls in a Run.
 * Input is conservatively estimated as UTF-8 bytes plus protocol/schema allowance.
 * Failed calls retain their reservation because provider usage is unknown.
 */
interface BudgetUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  iterations?: BudgetUsage[] | null;
}

export class ModelTokenBudget {
  private charged = 0;
  private reserved = 0;
  readonly finalReserve: number;
  constructor(readonly maximum: number, reserveFinal = true) {
    this.finalReserve = reserveFinal ? Math.min(128_000, Math.floor(maximum * 0.2)) : 0;
  }
  reserve(input: string, output: number, final = false) {
    const amount = Buffer.byteLength(input, "utf8") + 16_000 + output;
    const ceiling = this.maximum - (final ? 0 : this.finalReserve);
    if (this.charged + this.reserved + amount > ceiling) throw new Error("The Run model token budget cannot cover this call; remaining tokens are reserved for final review.");
    this.reserved += amount;
    let done = false;
    return (usage?: BudgetUsage) => {
      if (done) return;
      done = true;
      this.reserved -= amount;
      const attempts = usage?.iterations?.length ? usage.iterations : [usage];
      this.charged += attempts.some((item) => item?.input_tokens == null || item.output_tokens == null) ? amount
        : attempts.reduce((sum, item) => sum + item!.input_tokens! + item!.output_tokens! + (item!.cache_creation_input_tokens ?? 0) + (item!.cache_read_input_tokens ?? 0), 0);
    };
  }
  snapshot() { return { maximum: this.maximum, charged: this.charged, reserved: this.reserved, finalReserve: this.finalReserve }; }
}
