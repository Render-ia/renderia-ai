import { GeminiAnalyzer } from './GeminiAnalyzer.ts';
import { LocalVisionAnalyzer } from './LocalVisionAnalyzer.ts';
import type { PlanAnalyzer } from './PlanAnalyzer.ts';
import { SampleAnalyzer } from './SampleAnalyzer.ts';

/**
 * Picks the analyzer for a provider name (ai_models.provider).
 *
 * This is the "switch" of models: to add a new AI create a class that
 * implements PlanAnalyzer and register it here (GeminiAnalyzer is the example). The backend, the frontend and the database do not change;
 * the administrator only activates the new row in ai_models.
 */
export class AnalyzerFactory {
  private readonly analyzers = new Map<string, PlanAnalyzer>();

  constructor(analyzers: PlanAnalyzer[] = [new LocalVisionAnalyzer(), new GeminiAnalyzer(), new SampleAnalyzer()]) {
    for (const analyzer of analyzers) this.register(analyzer);
  }

  register(analyzer: PlanAnalyzer): void {
    this.analyzers.set(analyzer.provider, analyzer);
  }

  forProvider(provider: string): PlanAnalyzer | undefined {
    return this.analyzers.get(provider);
  }

  /** "configured" is false when the analyzer needs a key that the service does not have. */
  list(): { provider: string; name: string; configured: boolean }[] {
    return [...this.analyzers.values()].map((a) => ({
      provider: a.provider,
      name: a.name,
      configured: (a as { configured?: boolean }).configured ?? true,
    }));
  }
}
