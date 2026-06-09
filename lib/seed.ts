import { getDb } from '@/lib/db';
import { v4 as uuidv4 } from 'uuid';

export function seedProviders() {
  const db = getDb();

  const existing = db.prepare(`SELECT COUNT(*) as count FROM providers`).get() as { count: number };
  if (existing.count > 0) return;

  const providers = [
    {
      id: uuidv4(),
      name: 'GeekAI',
      baseUrl: process.env.GEEKAI_BASE_URL || 'https://geekai.co/api',
      apiKeyEnv: 'GEEKAI_API_KEY',
      apiKey: process.env.GEEKAI_API_KEY || '',
      model: 'gpt-image-2',
      type: 'geekai-json',
      enabled: 1,
      defaultCostPerImage: 0.5,
    },
    {
      id: uuidv4(),
      name: 'Packy GPT-Image-2',
      baseUrl: process.env.PACKY_BASE_URL || 'https://www.packyapi.com',
      apiKeyEnv: 'PACKY_API_KEY',
      apiKey: process.env.PACKY_API_KEY || '',
      model: 'gpt-image-2',
      type: 'packy-images',
      enabled: 0,
      defaultCostPerImage: 0.5,
    },
    {
      id: uuidv4(),
      name: '公司现有 API',
      baseUrl: process.env.COMPANY_BASE_URL || 'https://company-gateway.example.com',
      apiKeyEnv: 'COMPANY_API_KEY',
      apiKey: process.env.COMPANY_API_KEY || '',
      model: 'gpt-image-2',
      type: 'openai-compatible',
      enabled: 0,
      defaultCostPerImage: 1.2,
    },
  ];

  const insert = db.prepare(
    `INSERT INTO providers (id, name, baseUrl, apiKeyEnv, apiKey, model, type, enabled, defaultCostPerImage)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const p of providers) {
    insert.run(p.id, p.name, p.baseUrl, p.apiKeyEnv, p.apiKey, p.model, p.type, p.enabled, p.defaultCostPerImage);
  }
}
