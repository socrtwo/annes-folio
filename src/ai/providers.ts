/**
 * AI provider registry: where to sign up, where keys live, what is free, how to call it.
 *
 * Facts were checked in October 2026 (provider docs, SDK sources, a live CORS test against the
 * Gemini API, and the models.dev catalog); default model ids and base URLs were re-checked against
 * each provider's own docs on 14 November 2026. Provider consoles move pages often; every entry also
 * has a docs link, and model lists are fetched live after a key is added, so stale defaults
 * correct themselves.
 *
 * Provider and model names are used nominatively (to say which service a key belongs to); no
 * provider's branding is used for Anne's Folio's own features.
 */

export type ApiKind = 'openai' | 'anthropic' | 'gemini' | 'local' | 'builtin';
export type FreeTier = 'device' | 'free' | 'trial' | 'paid' | 'local';

export interface ProviderField {
  key: 'baseUrl' | 'accountId' | 'resource' | 'region' | 'apiVersion';
  label: string;
  placeholder: string;
  help?: string;
}

export interface ProviderDef {
  id: string;
  name: string;
  kind: ApiKind;
  /** OpenAI-compatible or native base URL; {accountId}, {resource}, {region} are substituted. */
  baseUrl: string;
  needsKey: boolean;
  /** Recognizes this provider's key in pasted or copied text. */
  keyPattern?: RegExp;
  /** The pattern is generic (no distinctive prefix): only used when this provider is being set up. */
  weakKey?: boolean;
  keyLabel?: string;
  fields?: ProviderField[];
  links: { signup?: string; keys?: string; billing?: string; free?: string; docs: string; download?: string };
  free: FreeTier;
  freeNote: string;
  /** Keys can be viewed again later (otherwise they are shown once, at creation). */
  keyViewable: boolean;
  models: { fast: string; quality: string };
  /** Browser CORS: 'yes' works from the web build; 'no' needs native HTTP (the Android, iOS or desktop app). */
  cors: 'yes' | 'no' | 'unknown' | 'local';
  /** One-click sign-in that returns a key (no copy/paste). */
  oauth?: 'openrouter';
  /** Supports image input (alt text, OCR) on the default quality model. */
  vision?: boolean;
  /** Supports /images/generations. */
  images?: string;
  notes?: string;
  extraHeaders?: Record<string, string>;
  /** Use max_completion_tokens instead of max_tokens. */
  completionTokens?: boolean;
}

export const PROVIDERS: ProviderDef[] = [
  // ---------------------------------------------------------------- free, no account
  {
    id: 'device', name: 'On-device model (Anne\'s Folio Local AI)', kind: 'local', baseUrl: '', needsKey: false,
    links: { docs: 'https://huggingface.co/docs/transformers.js' },
    free: 'device', freeNote: 'Free, private, no account. Downloads a small open model once (about 270 MB to 1.3 GB) and runs it on this device; works offline afterwards. Slower and less capable than cloud models.',
    keyViewable: true, models: { fast: 'onnx-community/Qwen2.5-0.5B-Instruct', quality: 'onnx-community/Qwen2.5-0.5B-Instruct' }, cors: 'local',
  },
  {
    id: 'builtin', name: 'Built-in browser AI (desktop Chrome)', kind: 'builtin', baseUrl: '', needsKey: false,
    links: { docs: 'https://developer.chrome.com/docs/ai/built-in' },
    free: 'device', freeNote: 'Free and on-device where the browser provides a model (Chrome 148+ on Windows, macOS, Linux and Chromebook Plus with enough memory). Not available on Android or iOS.',
    keyViewable: true, models: { fast: 'default', quality: 'default' }, cors: 'local',
  },
  // ---------------------------------------------------------------- free tiers (account required)
  {
    id: 'openrouter', name: 'OpenRouter (free models)', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', needsKey: true,
    keyPattern: /\bsk-or-v1-[0-9a-f]{64}\b/, oauth: 'openrouter',
    links: { signup: 'https://openrouter.ai/', keys: 'https://openrouter.ai/settings/keys', billing: 'https://openrouter.ai/settings/credits', free: 'https://openrouter.ai/models?max_price=0', docs: 'https://openrouter.ai/docs' },
    free: 'free', freeNote: 'Free models (":free" and the openrouter/free router): 20 requests per minute, 50 per day (1,000 per day after a one-time $10 credit purchase). One-click sign-in returns a key automatically. Paid models from every major lab with credits.',
    keyViewable: false, models: { fast: 'openrouter/free', quality: 'openrouter/auto' }, cors: 'yes', vision: true,
    extraHeaders: { 'HTTP-Referer': 'https://github.com/socrtwo/annes-folio', 'X-Title': 'Anne\'s Folio' },
  },
  {
    id: 'gemini', name: 'Google Gemini API', kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', needsKey: true,
    keyPattern: /\b(AIza[\w-]{35}|AQ\.[\w.-]{20,})/,
    links: { signup: 'https://aistudio.google.com/', keys: 'https://aistudio.google.com/apikey', billing: 'https://aistudio.google.com/usage', docs: 'https://ai.google.dev/gemini-api/docs' },
    free: 'free', freeNote: 'Free tier without a card for the Flash and Flash-Lite models (per-project quotas; free-tier prompts may be used to improve Google products). Pro models need billing.',
    keyViewable: true, models: { fast: 'gemini-flash-lite-latest', quality: 'gemini-flash-latest' }, cors: 'yes', vision: true,
  },
  {
    id: 'groq', name: 'Groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', needsKey: true,
    keyPattern: /\bgsk_[A-Za-z0-9]{52}\b/,
    links: { signup: 'https://console.groq.com/', keys: 'https://console.groq.com/keys', billing: 'https://console.groq.com/settings/billing', docs: 'https://console.groq.com/docs' },
    free: 'free', freeNote: 'Free tier without a card; rate-limited per organization. Very fast open models.',
    keyViewable: false, models: { fast: 'openai/gpt-oss-20b', quality: 'openai/gpt-oss-120b' }, cors: 'yes',
  },
  {
    id: 'mistral', name: 'Mistral AI', kind: 'openai', baseUrl: 'https://api.mistral.ai/v1', needsKey: true,
    keyPattern: /\b[A-Za-z0-9]{32}\b/, weakKey: true,
    links: { signup: 'https://console.mistral.ai/', keys: 'https://console.mistral.ai/api-keys', billing: 'https://console.mistral.ai/billing', docs: 'https://docs.mistral.ai/' },
    free: 'free', freeNote: 'Free "Experiment" plan: verified phone number, no card; requests may be used for training.',
    keyViewable: false, models: { fast: 'mistral-small-latest', quality: 'mistral-medium-latest' }, cors: 'yes',
  },
  {
    id: 'cerebras', name: 'Cerebras', kind: 'openai', baseUrl: 'https://api.cerebras.ai/v1', needsKey: true,
    keyPattern: /\bcsk-[A-Za-z0-9]{30,}\b/,
    links: { signup: 'https://cloud.cerebras.ai/', keys: 'https://cloud.cerebras.ai/platform', docs: 'https://inference-docs.cerebras.ai/' },
    free: 'free', freeNote: 'Free tier listed on the pricing page (some accounts are asked for a card to unlock credits).',
    keyViewable: false, models: { fast: 'gpt-oss-120b', quality: 'gpt-oss-120b' }, cors: 'yes',
  },
  {
    id: 'sambanova', name: 'SambaNova Cloud', kind: 'openai', baseUrl: 'https://api.sambanova.ai/v1', needsKey: true,
    keyPattern: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/, weakKey: true,
    links: { signup: 'https://cloud.sambanova.ai/', keys: 'https://cloud.sambanova.ai/apis', docs: 'https://docs.sambanova.ai/' },
    free: 'free', freeNote: 'Free tier without a card: about 20 requests per minute and 200k tokens per day.',
    keyViewable: false, models: { fast: 'gpt-oss-120b', quality: 'gpt-oss-120b' }, cors: 'unknown',
  },
  {
    id: 'zai', name: 'Z.ai (GLM)', kind: 'openai', baseUrl: 'https://api.z.ai/api/paas/v4', needsKey: true,
    keyPattern: /\b[a-f0-9]{32}\.[A-Za-z0-9]{16}\b/, weakKey: true,
    links: { signup: 'https://z.ai/', keys: 'https://z.ai/manage-apikey/apikey-list', docs: 'https://docs.z.ai/' },
    free: 'free', freeNote: 'GLM Flash models are free (one request at a time).',
    keyViewable: false, models: { fast: 'glm-4.7-flash', quality: 'glm-5.3' }, cors: 'unknown',
  },
  {
    id: 'cohere', name: 'Cohere', kind: 'openai', baseUrl: 'https://api.cohere.ai/compatibility/v1', needsKey: true,
    keyPattern: /\b[A-Za-z0-9]{40}\b/, weakKey: true,
    links: { signup: 'https://dashboard.cohere.com/', keys: 'https://dashboard.cohere.com/api-keys', billing: 'https://dashboard.cohere.com/billing', docs: 'https://docs.cohere.com/' },
    free: 'trial', freeNote: 'Free trial key: 1,000 calls per month, non-commercial use only.',
    keyViewable: true, models: { fast: 'command-r7b-12-2024', quality: 'command-a-plus-05-2026' }, cors: 'unknown',
  },
  // ---------------------------------------------------------------- local servers (free)
  {
    id: 'ollama', name: 'Ollama (local server)', kind: 'openai', baseUrl: 'http://localhost:11434/v1', needsKey: false,
    fields: [{ key: 'baseUrl', label: 'Server address', placeholder: 'http://localhost:11434/v1', help: 'Plain http:// works only for a server on this device (in the Android app: on the phone itself, for example in Termux). In a browser, also start Ollama with OLLAMA_ORIGINS set to this page\'s address (the Android and desktop apps are allowed by default). A server on another computer must be reached over https:// (for example behind a reverse proxy).' }],
    links: { download: 'https://ollama.com/download', docs: 'https://github.com/ollama/ollama/blob/main/docs/faq.md', free: 'https://ollama.com/library' },
    free: 'local', freeNote: 'Free open models on your own computer. Run "ollama pull qwen3" (or any model) first.',
    keyViewable: true, models: { fast: 'llama3.2', quality: 'qwen3' }, cors: 'local',
  },
  {
    id: 'lmstudio', name: 'LM Studio (local server)', kind: 'openai', baseUrl: 'http://localhost:1234/v1', needsKey: false,
    fields: [{ key: 'baseUrl', label: 'Server address', placeholder: 'http://localhost:1234/v1', help: 'Turn on "Enable CORS" in LM Studio\'s server settings (or run: lms server start --cors). Plain http:// works only for a server on this device; a server on another computer must be reached over https://.' }],
    links: { download: 'https://lmstudio.ai/', docs: 'https://lmstudio.ai/docs/app/api' },
    free: 'local', freeNote: 'Free open models on your own computer.',
    keyViewable: true, models: { fast: 'local-model', quality: 'local-model' }, cors: 'local',
  },
  // ---------------------------------------------------------------- paid
  {
    id: 'openai', name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', needsKey: true,
    keyPattern: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}|\bsk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}\b/,
    links: { signup: 'https://platform.openai.com/signup', keys: 'https://platform.openai.com/api-keys', billing: 'https://platform.openai.com/settings/organization/billing', docs: 'https://platform.openai.com/docs' },
    free: 'paid', freeNote: 'Prepaid credits; no free tier.',
    keyViewable: false, models: { fast: 'gpt-6-luna', quality: 'gpt-6.1-sol' }, cors: 'yes', vision: true, images: 'gpt-image-2', completionTokens: true,
  },
  {
    id: 'anthropic', name: 'Anthropic (Claude)', kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', needsKey: true,
    keyPattern: /\bsk-ant-api03-[\w-]{80,}/,
    links: { signup: 'https://platform.claude.com/', keys: 'https://platform.claude.com/settings/keys', billing: 'https://platform.claude.com/settings/billing', docs: 'https://docs.claude.com/' },
    free: 'paid', freeNote: 'Prepaid credits; no free tier.',
    keyViewable: false, models: { fast: 'claude-haiku-5-5', quality: 'claude-sonnet-5-5' }, cors: 'yes', vision: true,
  },
  {
    id: 'deepseek', name: 'DeepSeek', kind: 'openai', baseUrl: 'https://api.deepseek.com', needsKey: true,
    keyPattern: /\bsk-[a-f0-9]{32}\b/,
    links: { signup: 'https://platform.deepseek.com/', keys: 'https://platform.deepseek.com/api_keys', billing: 'https://platform.deepseek.com/top_up', docs: 'https://api-docs.deepseek.com/' },
    free: 'paid', freeNote: 'Low-cost prepaid credits.',
    keyViewable: false, models: { fast: 'deepseek-flash', quality: 'deepseek-v4-pro' }, cors: 'yes',
  },
  {
    id: 'xai', name: 'xAI (Grok)', kind: 'openai', baseUrl: 'https://api.x.ai/v1', needsKey: true,
    keyPattern: /\bxai-[0-9a-zA-Z_]{80}\b/,
    links: { signup: 'https://console.x.ai/', keys: 'https://console.x.ai/', billing: 'https://console.x.ai/', docs: 'https://docs.x.ai/' },
    free: 'paid', freeNote: 'Prepaid credits; the former monthly free credits ended in April 2026.',
    keyViewable: false, models: { fast: 'grok-4.3', quality: 'grok-4.7' }, cors: 'yes', vision: true,
  },
  {
    id: 'perplexity', name: 'Perplexity (web-grounded)', kind: 'openai', baseUrl: 'https://api.perplexity.ai', needsKey: true,
    keyPattern: /\bpplx-[a-zA-Z0-9]{48}\b/,
    links: { signup: 'https://www.perplexity.ai/', keys: 'https://www.perplexity.ai/account/api', billing: 'https://www.perplexity.ai/account/api', docs: 'https://docs.perplexity.ai/' },
    free: 'paid', freeNote: 'Paid; answers cite live web sources (useful for Find Sources).',
    keyViewable: false, models: { fast: 'sonar', quality: 'sonar-pro' }, cors: 'no', notes: 'Browsers cannot call this API directly; it works in the Android, iOS and desktop apps.',
  },
  {
    id: 'together', name: 'Together AI', kind: 'openai', baseUrl: 'https://api.together.xyz/v1', needsKey: true,
    keyPattern: /\btgp_v1_[\w-]{20,}|\b[a-f0-9]{64}\b/, weakKey: true,
    links: { signup: 'https://api.together.ai/', keys: 'https://api.together.ai/settings/api-keys', billing: 'https://api.together.ai/settings/billing', docs: 'https://docs.together.ai/' },
    free: 'paid', freeNote: '$5 minimum credit purchase.',
    keyViewable: false, models: { fast: 'zai-org/GLM-5.3-Flash', quality: 'moonshotai/Kimi-K3' }, cors: 'yes',
  },
  {
    id: 'fireworks', name: 'Fireworks AI', kind: 'openai', baseUrl: 'https://api.fireworks.ai/inference/v1', needsKey: true,
    keyPattern: /\bfw_[A-Za-z0-9]{20,}\b/,
    links: { signup: 'https://app.fireworks.ai/', keys: 'https://app.fireworks.ai/settings/users/api-keys', billing: 'https://app.fireworks.ai/billing', docs: 'https://docs.fireworks.ai/' },
    free: 'trial', freeNote: 'Small starter credit, then paid.',
    keyViewable: false, models: { fast: 'accounts/fireworks/models/glm-5p3-flash', quality: 'accounts/fireworks/models/kimi-k3' }, cors: 'yes',
  },
  {
    id: 'huggingface', name: 'Hugging Face Inference Providers', kind: 'openai', baseUrl: 'https://router.huggingface.co/v1', needsKey: true,
    keyPattern: /\bhf_[A-Za-z]{34}\b/,
    links: { signup: 'https://huggingface.co/join', keys: 'https://huggingface.co/settings/tokens', billing: 'https://huggingface.co/settings/billing', docs: 'https://huggingface.co/docs/inference-providers' },
    free: 'paid', freeNote: 'Free accounts get no monthly inference credits; PRO includes $2 per month. Use a fine-grained token with "Make calls to Inference Providers".',
    keyViewable: false, models: { fast: 'zai-org/GLM-5.3-Flash', quality: 'moonshotai/Kimi-K3' }, cors: 'unknown',
  },
  {
    id: 'moonshot', name: 'Moonshot AI (Kimi)', kind: 'openai', baseUrl: 'https://api.moonshot.ai/v1', needsKey: true,
    keyPattern: /\bsk-[A-Za-z0-9]{40,}\b/,
    links: { signup: 'https://platform.moonshot.ai/', keys: 'https://platform.moonshot.ai/console/api-keys', billing: 'https://platform.moonshot.ai/console/pay', docs: 'https://platform.moonshot.ai/docs' },
    free: 'paid', freeNote: '$1 minimum top-up. Keys from the China site do not work on the international API.',
    keyViewable: false, models: { fast: 'kimi-k3', quality: 'kimi-k3' }, cors: 'unknown',
  },
  {
    id: 'qwen', name: 'Alibaba Cloud Model Studio (Qwen)', kind: 'openai', baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', needsKey: true,
    keyPattern: /\bsk-[a-f0-9]{32}\b/,
    links: { signup: 'https://modelstudio.console.alibabacloud.com/', keys: 'https://modelstudio.console.alibabacloud.com/', docs: 'https://www.alibabacloud.com/help/en/model-studio/' },
    free: 'trial', freeNote: 'New users: 1 million free tokens per model for 90 days (Singapore region). Keys work only in their own region.',
    keyViewable: true, models: { fast: 'qwen3.8-flash', quality: 'qwen3.8-max' }, cors: 'unknown',
  },
  {
    id: 'nvidia', name: 'NVIDIA NIM (build.nvidia.com)', kind: 'openai', baseUrl: 'https://integrate.api.nvidia.com/v1', needsKey: true,
    keyPattern: /\bnvapi-[\w-]{40,}/,
    links: { signup: 'https://build.nvidia.com/', keys: 'https://build.nvidia.com/settings/api-keys', docs: 'https://docs.api.nvidia.com/' },
    free: 'free', freeNote: 'Free for development and testing with the NVIDIA Developer Program (about 40 requests per minute).',
    keyViewable: false, models: { fast: 'nvidia/nemotron-3.5-lightning-30b-a3b', quality: 'moonshotai/kimi-k3' }, cors: 'no', notes: 'Browsers cannot call this API directly; it works in the Android, iOS and desktop apps.',
  },
  {
    id: 'cloudflare', name: 'Cloudflare Workers AI', kind: 'openai', baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1', needsKey: true,
    keyPattern: /\b[A-Za-z0-9_-]{40}\b/, weakKey: true,
    fields: [{ key: 'accountId', label: 'Account ID', placeholder: '32-character account ID', help: 'Shown on the right of the Cloudflare dashboard overview.' }],
    links: { signup: 'https://dash.cloudflare.com/sign-up', keys: 'https://dash.cloudflare.com/profile/api-tokens', docs: 'https://developers.cloudflare.com/workers-ai/' },
    free: 'free', freeNote: 'Free plan: 10,000 Neurons per day (the quality model, GLM-5.3, needs the Workers Paid plan). Create an API token with the Workers AI permission.',
    keyViewable: false, models: { fast: '@cf/qwen/qwen3.8-27b', quality: '@cf/zai-org/glm-5.3' }, cors: 'no', notes: 'Browsers cannot call this API directly; it works in the Android, iOS and desktop apps.',
  },
  {
    id: 'azure', name: 'Azure OpenAI / AI Foundry', kind: 'openai', baseUrl: 'https://{resource}.openai.azure.com/openai/v1', needsKey: true,
    keyPattern: /\b[A-Za-z0-9]{32,84}\b/, weakKey: true,
    fields: [{ key: 'resource', label: 'Resource name', placeholder: 'my-resource', help: 'From "Keys and Endpoint" on the resource page. The model is your deployment name.' }],
    links: { signup: 'https://azure.microsoft.com/free/', keys: 'https://portal.azure.com/', docs: 'https://learn.microsoft.com/azure/ai-foundry/openai/' },
    free: 'paid', freeNote: 'Paid Azure subscription (the general Azure trial needs a card).',
    keyViewable: true, models: { fast: 'gpt-6-luna', quality: 'gpt-6.1-sol' }, cors: 'unknown', completionTokens: true,
    extraHeaders: {},
  },
  {
    id: 'bedrock', name: 'Amazon Bedrock', kind: 'openai', baseUrl: 'https://bedrock-runtime.{region}.amazonaws.com/openai/v1', needsKey: true,
    keyPattern: /\bABSK[A-Za-z0-9+/]{100,}={0,2}|\bbedrock-api-key-[\w+/=.-]{20,}/,
    fields: [{ key: 'region', label: 'Region', placeholder: 'us-east-1' }],
    links: { signup: 'https://aws.amazon.com/bedrock/', keys: 'https://console.aws.amazon.com/bedrock/home#/api-keys', docs: 'https://docs.aws.amazon.com/bedrock/latest/userguide/api-keys.html' },
    free: 'paid', freeNote: 'Paid AWS account. Use a Bedrock API key (long-term keys start with ABSK).',
    keyViewable: false, models: { fast: 'openai.gpt-oss-20b-1:0', quality: 'openai.gpt-oss-120b-1:0' }, cors: 'unknown',
  },
  {
    id: 'custom', name: 'Other OpenAI-compatible service', kind: 'openai', baseUrl: '', needsKey: true,
    fields: [{ key: 'baseUrl', label: 'Base URL', placeholder: 'https://example.com/v1', help: 'Any server that implements /v1/chat/completions (LiteLLM, vLLM, LocalAI, Jan, Open WebUI, Pollinations, a company gateway...). Leave the key empty if none is needed.' }],
    links: { docs: 'https://platform.openai.com/docs/api-reference/chat' },
    free: 'paid', freeNote: 'Depends on the service.',
    keyViewable: true, models: { fast: '', quality: '' }, cors: 'unknown',
  },
];

export function providerById(id: string): ProviderDef | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** Find a provider key inside copied text, preferring the provider the user is setting up. */
export function detectKey(text: string, preferred?: string): { provider: string; key: string } | null {
  const t = (text || '').trim();
  if (!t || t.length > 4000) return null;
  const order = [...PROVIDERS].filter((p) => p.keyPattern).sort((a, b) => (a.id === preferred ? -1 : b.id === preferred ? 1 : 0));
  // Distinctive prefixes first so generic patterns (plain 32/40-character tokens) never shadow them.
  const strong = order.filter((p) => !p.weakKey);
  const weak = order.filter((p) => p.weakKey && p.id === preferred);
  for (const p of [...strong, ...weak]) {
    const m = p.keyPattern!.exec(t);
    if (m) return { provider: p.id, key: m[0] };
  }
  return null;
}

export const FREE_LABEL: Record<FreeTier, string> = {
  device: 'Free · on device', free: 'Free tier', trial: 'Free trial', paid: 'Paid', local: 'Free · your computer',
};
