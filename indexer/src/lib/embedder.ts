import OpenAI from "openai";

export class EmbeddingService {
  private readonly client: OpenAI | null;

  constructor(private readonly apiKey: string | undefined, private readonly model: string) {
    this.client = apiKey ? new OpenAI({ apiKey }) : null;
  }

  isEnabled(): boolean {
    return this.client !== null;
  }

  async embed(text: string): Promise<number[] | null> {
    if (!this.client) {
      return null;
    }

    try {
      const response = await this.client.embeddings.create({
        model: this.model,
        input: text.slice(0, 8000)
      });

      return response.data[0]?.embedding ?? null;
    } catch {
      return null;
    }
  }

  async embedMany(texts: string[], batchSize = 64): Promise<Array<number[] | null>> {
    if (texts.length === 0) {
      return [];
    }
    if (!this.client) {
      return texts.map(() => null);
    }

    const safeBatchSize = Math.max(1, batchSize);
    const results: Array<number[] | null> = [];

    for (let index = 0; index < texts.length; index += safeBatchSize) {
      const batch = texts.slice(index, index + safeBatchSize).map((text) => text.slice(0, 8000));
      try {
        const response = await this.client.embeddings.create({
          model: this.model,
          input: batch
        });
        const vectors = response.data.map((item) => item.embedding ?? null);
        if (vectors.length < batch.length) {
          results.push(...vectors);
          results.push(...Array.from({ length: batch.length - vectors.length }, () => null));
        } else {
          results.push(...vectors.slice(0, batch.length));
        }
      } catch {
        results.push(...Array.from({ length: batch.length }, () => null));
      }
    }

    if (results.length < texts.length) {
      results.push(...Array.from({ length: texts.length - results.length }, () => null));
    }

    return results.slice(0, texts.length);
  }
}
