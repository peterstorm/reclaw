// ─── Scheduled Output ─────────────────────────────────────────────────────────
//
// The one sentinel every scheduled skill shares: a skill that has nothing to say emits
// exactly this, and the runtime suppresses the message instead of delivering it. It lives
// on its own because it is a scheduling concept, not a learning one — the learning
// messages, the builder and every other cron skill consume it, none owns it.

/** "Nothing to say": a scheduled handler suppresses a message that is exactly this. */
export const ALL_CLEAR = 'ALL_CLEAR';
