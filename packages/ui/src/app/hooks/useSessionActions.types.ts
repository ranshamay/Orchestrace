import type { ClipboardEvent } from 'react';
import type {
  AgentTodo,
  ChatMessage,
  WorkSession,
} from '../../lib/api';
import type {
  ComposerImageAttachment,
  SessionLlmControls,
} from '../types';

export type SessionActionsParams = {
  selectedSessionId: string;
  selectedSession?: WorkSession;
  sessions: WorkSession[];
  chatMessages: ChatMessage[];
  todos: AgentTodo[];
  composerText: string;
  composerImages: ComposerImageAttachment[];
  workWorkspaceId: string;
  workProvider: string;
  workModel: string;
  autoApprove: boolean;
  adaptiveConcurrency: boolean;
  batchConcurrency: number;
  batchMinConcurrency: number;
  setErrorMessage: (message: string) => void;
  setSessions: (sessions: WorkSession[]) => void;
  setSelectedSessionId: (id: string) => void;
  setChatMessages: (messages: ChatMessage[]) => void;
  setTodos: (items: AgentTodo[]) => void;
  setComposerText: (value: string) => void;
  setComposerImages: (
    updater:
      | ComposerImageAttachment[]
      | ((current: ComposerImageAttachment[]) => ComposerImageAttachment[])
  ) => void;
  setLlmControlsBySessionId: (
    updater:
      | Record<string, SessionLlmControls>
      | ((current: Record<string, SessionLlmControls>) => Record<string, SessionLlmControls>)
  ) => void;
};

export type ComposerPasteEvent = ClipboardEvent<HTMLTextAreaElement>;