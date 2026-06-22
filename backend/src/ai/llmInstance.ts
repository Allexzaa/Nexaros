import { LLMClient } from './client';
import { env } from '../config/env';

export const llmClient = new LLMClient(env.LLM_BASE_URL, env.LLM_API_KEY, env.LLM_MODEL);
