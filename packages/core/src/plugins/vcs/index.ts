/**
 * VCS Plugins Export
 *
 * Экспортируем VCS плагины для работы с различными системами контроля версий
 */

export { VCSPlugin, FileStatus, VCSPluginFactory } from './VCSPlugin.js';
export type {
  VCSConfig,
  VCSPluginMetadata,
  ChangedFile,
  DiffHunk,
  FileDiff,
  FileStatusType,
  VCSPluginConstructor
} from './VCSPlugin.js';
export { GitPlugin } from './GitPlugin.js';
export type { CommitInfo } from './GitPlugin.js';

/**
 * Автоматическая регистрация всех VCS плагинов
 */
import { VCSPluginFactory } from './VCSPlugin.js';
import { GitPlugin } from './GitPlugin.js';

// Регистрируем Git плагин
VCSPluginFactory.register(GitPlugin);

// В будущем добавим:
// VCSPluginFactory.register(CVSPlugin);
// VCSPluginFactory.register(SVNPlugin);
// VCSPluginFactory.register(MercurialPlugin);
