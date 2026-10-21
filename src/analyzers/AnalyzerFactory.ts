import { LocalVisionAnalyzer } from './LocalVisionAnalyzer.ts';
import type { PlanAnalyzer } from './PlanAnalyzer.ts';
import { SampleAnalyzer } from './SampleAnalyzer.ts';

/**
 * Picks the analyzer for a provider name (ai_models.provider).
 *
 * This is the "switch" of models: to add a new AI (for example a vision model
 * from Groq or Gemini) create a class that implements PlanAnalyzer and
 * register it here. The backend, the frontend and the database do not change;
 * the administrator only activates the new row in ai_models.
 */
export class AnalyzerFactory {
  private readonly analyzers = new Map<string, PlanAnalyzer>();

  constructor() {
    this.register(new LocalVisionAnalyzer());
    this.register(new SampleAnalyzer());
  }

  register(analyzer: PlanAnalyzer): void {
    this.analyzers.set(analyzer.provider, analyzer);
  }

  forProvider(provider: string): PlanAnalyzer | undefined {
    return this.analyzers.get(provider);
  }

  list(): { provider: string; name: string }[] {
    return [...this.analyzers.values()].map(({ provider, name }) => ({ provider, name }));
  }
}
