// Per-session override for the message sent when a session is picked back up.
//
// `usageLimitMessage` in ~/.claude-auto-retry.json is one instruction for every session on the
// machine. That is the right default and the wrong thing when two sessions are doing unrelated
// work — the overnight prompt that says "fetch todo.md and continue the build" is actively
// misleading if sent to a session that was doing something else.
//
// The override is a PLAIN TEXT file, not another JSON field, for two reasons: these prompts are
// long paragraphs, and JSON makes editing one an escaping exercise; and a text file opens
// straight in an editor, which is how the menu bar app exposes this.
//
// The filename carries the claude PID, so the override is SELF-EXPIRING and immune to tmux
// pane-id reuse — exactly the property reconcile's exclude list gets from recording PIDs. When
// that claude exits, its file no longer matches any live session and can never be sent to a
// later one that inherits the pane. (The cost is that an override does not survive restarting
// the session; a global prompt is the place for something that should.)

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { sanitizeKey, socketIdFromEnv } from './pane-key.js';

export const SESSION_PROMPT_DIR = join(homedir(), '.claude-auto-retry', 'session-prompts');

// Socket-prefixed like every other pane-keyed file here (status snapshots, StopFailure
// markers): pane ids are only unique within one tmux server.
export function sessionPromptFile(paneKey, claudePid, dir = SESSION_PROMPT_DIR, socketId = socketIdFromEnv()) {
  return join(dir, `${sanitizeKey(socketId)}_${sanitizeKey(paneKey)}_${sanitizeKey(claudePid)}.txt`);
}

// The retry is delivered by `tmux send-keys -l <text>` followed by a separate Enter, so a
// newline inside the text would SUBMIT the message early and leave the rest of it typed into
// the next prompt. Collapsing whitespace lets the file be written as a wrapped paragraph — the
// way anyone actually writes a long instruction — and still arrive as one line.
export function normalize(text) {
  return text.trim().split(/\s+/).join(' ');
}

// The override for this session, or null when there isn't one. Read at SEND time rather than
// cached at monitor start, so editing the file takes effect without restarting anything.
export async function readSessionPrompt(paneKey, claudePid, dir = SESSION_PROMPT_DIR) {
  if (!paneKey || !claudePid) return null;
  try {
    const normalized = normalize(await readFile(sessionPromptFile(paneKey, claudePid, dir), 'utf-8'));
    return normalized || null;   // an emptied file means "no override", not "send nothing"
  } catch {
    return null;                 // absent / unreadable → the global message stands
  }
}
