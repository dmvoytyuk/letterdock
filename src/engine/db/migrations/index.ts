import init from './001_init.sql?raw';
import m2m3 from './002_m2_m3.sql?raw';
import snippetChecked from './003_snippet_checked.sql?raw';
import resetHeaderSnippets from './004_reset_header_snippets.sql?raw';
import contacts from './005_contacts.sql?raw';
import localDrafts from './006_local_drafts.sql?raw';
import conversations from './007_conversations.sql?raw';
import scheduledSend from './008_scheduled_send.sql?raw';

export interface Migration {
  version: number;
  sql: string;
}

/** Append new migrations here; never edit an applied one. */
export const MIGRATIONS: Migration[] = [
  { version: 1, sql: init },
  { version: 2, sql: m2m3 },
  { version: 3, sql: snippetChecked },
  { version: 4, sql: resetHeaderSnippets },
  { version: 5, sql: contacts },
  { version: 6, sql: localDrafts },
  { version: 7, sql: conversations },
  { version: 8, sql: scheduledSend },
];
