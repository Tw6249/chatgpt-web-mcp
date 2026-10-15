// Runs in the renderer. Require a recognized label near the active composer;
// a CSS pill class or an arbitrary nearby button is not sufficient evidence.
export function answerTierControlDOM(composer) {
  if (!composer?.isConnected) return null;
  const rect = composer.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const scope = composer.closest('form') || composer.closest('main') || document.body;
  const buttons = [...document.querySelectorAll('button, [role="button"]')];
  const tier = /^(?:(?:answer tier|thinking effort|回答档位|能力档位|思考强度)\s*[:：]?\s*)?(?:快速|标准|较高|高|极高|专业|高级|pro|fast|standard|high|very high|advanced)$/i;
  const candidates = buttons.flatMap(button => {
    if (!scope.contains(button) || button.closest('article, [data-message-author-role], [data-turn]')) return [];
    const box = button.getBoundingClientRect();
    if (!box.width || !box.height || getComputedStyle(button).visibility === 'hidden' || button.disabled || button.getAttribute('aria-disabled') === 'true') return [];
    const labels = [button.innerText, button.getAttribute('aria-label'), button.getAttribute('title')].map(v => (v || '').replace(/\s+/g, ' ').trim());
    if (!labels.some(label => tier.test(label))) return [];
    const distance = Math.abs(box.y + box.height / 2 - rect.y - rect.height / 2);
    if (distance > Math.max(160, rect.height * 2)) return [];
    return [{ button, score: distance + Math.abs(box.x + box.width / 2 - rect.right) * 0.02 }];
  }).sort((a, b) => a.score - b.score);
  if (!candidates.length || (candidates[1] && Math.abs(candidates[0].score - candidates[1].score) < 1)) return null;
  return candidates[0].button;
}
