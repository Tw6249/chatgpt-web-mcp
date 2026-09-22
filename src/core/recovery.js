// Guidance only. Never turn a diagnostic suggestion into an automatic action.
export function recoveryFor(task) {
  if (['completed', 'cancelled', 'failed', 'abandoned'].includes(task.state)) {
    return { action: 'none', automatic_retry: false, message: 'Tracking finished. Reusing the request_id will return this record without sending.' };
  }
  const code = task.error?.code;
  if (code === 'CONVERSATION_CHANGED') return { action: 'return_to_conversation', automatic_retry: false, message: 'Manually open the saved conversation in the dedicated browser, then call chat_result.' };
  if (code === 'RATE_LIMITED') return { action: 'wait_for_manual_recovery', automatic_retry: false, message: 'Wait for the provider limit to clear. Confirm recovery before clearing its circuit breaker, then resume this task.' };
  if (code === 'LOGIN_REQUIRED') return { action: 'manual_login', automatic_retry: false, message: 'Sign in manually in the dedicated browser, then resume this task. Never provide credentials to a tool.' };
  if (task.state === 'uncertain') return { action: 'inspect_page', automatic_retry: false, message: 'Inspect the original page, then call chat_result. Do not resend with a new request_id. Abandon tracking only after explicit user authorization.' };
  return { action: 'chat_result', automatic_retry: false, message: 'Resume observation with this task_id. A wait timeout does not cancel or resend the task.' };
}
