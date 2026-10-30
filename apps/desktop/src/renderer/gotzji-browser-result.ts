export interface BrowserReadResult { readonly url: string; readonly text: string }

/** Presentation only: the existing Core result call verifies the artifact before this projection. */
export function browserReadResult(value: unknown): BrowserReadResult | undefined {
  if (!record(value) || !record(value.output)) return undefined;
  const receipt = value.output.browserReceipt;
  if (!record(receipt) || receipt.operation !== 'browser.read' || receipt.verified !== true || receipt.releaseResources !== true
    || !record(receipt.binding) || typeof receipt.binding.url !== 'string' || !Array.isArray(receipt.steps) || receipt.steps.length !== 1) return undefined;
  const step: unknown = receipt.steps[0];
  if (!record(step) || step.operation !== 'browser.read' || !record(step.after) || typeof step.after.text !== 'string') return undefined;
  try {
    const url = new URL(receipt.binding.url);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
  } catch { return undefined; }
  return { url: receipt.binding.url, text: step.after.text };
}
function record(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object' && !Array.isArray(value); }
