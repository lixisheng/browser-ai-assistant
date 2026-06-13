import type { ChatSession } from "../../shared/types";

export function upsertSession(sessions: ChatSession[], session: ChatSession): ChatSession[] {
  const nextSessions = sessions.filter((item) => item.id !== session.id);
  return [session, ...nextSessions].sort((left, right) => right.updatedAt - left.updatedAt);
}
