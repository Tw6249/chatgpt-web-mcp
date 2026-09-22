// Prefer Gemini's semantic controls; keep provider-specific DOM details here.
export const SELECTORS = {
  composer: ['rich-textarea [contenteditable="true"][role="textbox"]', '[contenteditable="true"][role="textbox"]'],
  send: ['button[aria-label="Send message"]', 'button[aria-label="Send"]', 'button[aria-label="发送消息"]', 'button[aria-label="发送"]', 'button.send-button'],
  stop: ['button[aria-label="Stop response"]', 'button[aria-label="Stop generating"]', 'button[aria-label="停止回答"]', 'button[aria-label="停止生成"]', 'button[aria-label="停止回复"]', 'button.stop-button'],
  model: ['button[aria-label*="Open mode picker"]', 'button[aria-label*="打开模式选择器"]', 'button[aria-label*="Choose model"]', 'button[aria-label*="选择模型"]', 'button.input-area-switch'],
  models: '[role="menuitemradio"], [role="menuitem"], [role="option"]',
  user: 'user-query',
  assistant: 'model-response',
  answer: 'message-content .markdown, .model-response-text .markdown, message-content',
  complete: 'button[aria-label*="Copy"], button[aria-label*="复制"], button[data-test-id="copy-button"]',
  alerts: '[role="alert"], .error-message, .response-error, .snackbar-message',
  attachments: 'file-preview, .file-preview, .attachment-preview, [data-test-id="file-preview"]',
  upload: ['button[aria-label="Upload files"]', 'button[aria-label="上传文件"]', 'button[aria-label="上传和工具"]', 'button[aria-label="Add files"]', 'button[aria-label="添加文件"]', 'button[aria-label="Open upload file menu"]'],
};
