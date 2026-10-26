export {
  runStudyChat,
  testAiConnection,
  listAiModels,
  type RunStudyChatInput,
  type StudyChatResult,
  type StudyDocumentInput,
} from './chat'
export {
  buildStudyPrompt,
  type StudyContextInput,
  type StudyContextMode,
  type StudyPrompt,
  type StudyPromptMeta,
} from './context'
export {
  buildDocIndex,
  estimateTokens,
  extractSinglePage,
  getCachedDocIndex,
  isPageTextReadable,
  putCachedDocIndex,
} from './document'
export {
  aiConfigIssue,
  createBuiltinProviders,
  createCustomProvider,
  defaultAiSettings,
  defaultStudySettings,
  getActiveProvider,
  isCliKind,
  modelPresets,
  resolveAiConfig,
} from './providers'
export type { ModelInfo } from './providers/http'
export { clearChat, loadChat, saveChat } from './chatStore'
export { renderPageImage } from './pdfImage'
export { useDocIndex, type DocIndexState } from './useDocIndex'
export {
  buildTaskDisplay,
  buildTaskUserText,
  starterQuestions,
  systemPrompt,
  defaultSystemPromptBody,
  taskInstruction,
  taskLabel,
} from './prompts'
export {
  parseHighlightSuggestions,
  type AiHighlightSuggestion,
} from './highlightSuggestions'
export {
  clearDocCoach,
  loadDocCoach,
  saveDocCoach,
  type AiCoachMode,
  type AiDocCoach,
} from './docCoach'
