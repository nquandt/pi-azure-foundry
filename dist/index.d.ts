/**
 * Azure Foundry Extension
 *
 * Discovers models from Azure AI Foundry Deployments API and registers them with pi.
 * Routes to the correct API based on model publisher:
 *   - Anthropic → native Messages API at /anthropic/v1/messages
 *   - OpenAI/others → OpenAI-compat at /openai/deployments/{id}/chat/completions
 *
 * Config: ./azure-foundry.config.json
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI): Promise<void>;
//# sourceMappingURL=index.d.ts.map