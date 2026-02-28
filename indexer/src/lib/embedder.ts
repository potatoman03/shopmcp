import OpenAI from "openai";

export class EmbeddingService {
  private readonly client: OpenAI | null;
  private readonly summaryModel: string;
  private readonly summaryEnabled: boolean;
  private readonly summaryMaxChars: number;

  constructor(
    apiKey: string | undefined,
    private readonly model: string,
    summaryConfig?: {
      enabled?: boolean;
      model?: string;
      maxChars?: number;
    }
  ) {
    this.client = apiKey ? new OpenAI({ apiKey }) : null;
    this.summaryModel = summaryConfig?.model ?? "gpt-4o-mini";
    this.summaryEnabled = Boolean(summaryConfig?.enabled);
    this.summaryMaxChars = Math.max(80, summaryConfig?.maxChars ?? 220);
  }

  isEnabled(): boolean {
    return this.client !== null;
  }

  canSummarize(): boolean {
    return this.client !== null && this.summaryEnabled;
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

  async summarizeOneLine(input: {
    title: string;
    productType?: string;
    description?: string;
    tags?: string[];
  }): Promise<string | null> {
    if (!this.client || !this.summaryEnabled) {
      return null;
    }

    const title = input.title.trim();
    if (!title) {
      return null;
    }

    const context = [
      `Title: ${title}`,
      input.productType ? `Type: ${input.productType}` : "",
      input.tags && input.tags.length > 0 ? `Tags: ${input.tags.slice(0, 8).join(", ")}` : "",
      input.description ? `Description: ${input.description.slice(0, 600)}` : ""
    ]
      .filter(Boolean)
      .join("\n");

    try {
      const response = await this.client.chat.completions.create({
        model: this.summaryModel,
        temperature: 0.2,
        max_tokens: 80,
        messages: [
          {
            role: "system",
            content:
              "Write a single-sentence ecommerce product summary, factual and concise. No hype. No markdown."
          },
          {
            role: "user",
            content: `${context}\n\nReturn one sentence under ${this.summaryMaxChars} characters.`
          }
        ]
      });

      const text = response.choices[0]?.message?.content?.trim();
      if (!text) {
        return null;
      }
      return text.length > this.summaryMaxChars ? `${text.slice(0, this.summaryMaxChars - 1)}…` : text;
    } catch {
      return null;
    }
  }
}
