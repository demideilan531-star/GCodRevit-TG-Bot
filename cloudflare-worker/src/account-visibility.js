export const ACCOUNT_READABLE_SQL = `NOT EXISTS (
  SELECT 1 FROM account_context_sync s WHERE s.owner_id=?
    AND COALESCE(s.reconciliation_json,json_extract(s.update_state_json,'$.reconciliation_required'),0)<>0
    AND (COALESCE(json_extract(s.reconciliation_json,'$.scope'),json_extract(s.update_state_json,'$.reconciliation_required.scope')) IS NOT 'channel'
      OR COALESCE(json_extract(s.reconciliation_json,'$.chat_id'),json_extract(s.update_state_json,'$.reconciliation_required.chat_id'))=?)
) AND NOT EXISTS (
  SELECT 1 FROM account_context_chats c WHERE c.owner_id=? AND c.chat_id=?
    AND c.history_status IN ('paused','unavailable')
)`;

export const accountVisibilityArgs = (owner, chat) => [String(owner), String(chat), String(owner), String(chat)];

export async function assertAccountChatReadable(env, owner, chat) {
  if (!env.ACCOUNT_CONTEXT_DB || String(owner) !== String(env.TELEGRAM_ACCOUNT_OWNER_ID)) return;
  const row = await env.ACCOUNT_CONTEXT_DB.prepare(`SELECT (${ACCOUNT_READABLE_SQL}) AS readable`)
    .bind(...accountVisibilityArgs(owner, chat)).first();
  if (!row?.readable) throw Object.assign(new Error('Чтение приостановлено: нужно проверить полноту синхронизации этого чата.'), { status: 409 });
}
