import { config } from '../config.ts';
import { GeminiError } from './errors.ts';

/**
 * Daily spending guard for the whole service. Counts calls per UTC day and
 * refuses once the configured limit is reached, so a loop, a bug or an
 * abusive client cannot run up the Gemini bill. Per-user limits live in the
 * backend, which knows who is asking.
 */
export class GeminiBudget {
  static readonly shared = new GeminiBudget(config.gemini.dailyLimit, config.gemini.imageDailyLimit);

  private day = '';
  private used = { text: 0, image: 0 };

  constructor(
    private readonly textLimit: number,
    private readonly imageLimit: number,
    private readonly now: () => Date = () => new Date(),
  ) {}

  take(kind: 'text' | 'image'): void {
    const today = this.now().toISOString().slice(0, 10);
    if (today !== this.day) {
      this.day = today;
      this.used = { text: 0, image: 0 };
    }
    const limit = kind === 'text' ? this.textLimit : this.imageLimit;
    if (this.used[kind] >= limit) {
      throw new GeminiError(
        kind === 'text'
          ? 'Se alcanzó el cupo diario de consultas a Gemini del servicio. Vuelve a intentarlo mañana.'
          : 'Se alcanzó el cupo diario de renders con IA. Vuelve a intentarlo mañana.',
      );
    }
    this.used[kind]++;
  }

  usage(): { day: string; text: number; image: number; textLimit: number; imageLimit: number } {
    return { day: this.day, ...this.used, textLimit: this.textLimit, imageLimit: this.imageLimit };
  }
}
