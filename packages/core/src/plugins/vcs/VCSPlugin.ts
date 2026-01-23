/**
 * Базовый класс для VCS плагинов (Version Control System)
 *
 * Этот плагин не работает с графом напрямую, а предоставляет
 * информацию о версиях файлов для incremental analysis
 *
 * Поддерживаемые VCS:
 * - Git
 * - CVS
 * - SVN
 * - Mercurial
 * - Perforce
 */

import type { Logger } from '../../logging/Logger.js';

/**
 * VCS Plugin configuration
 */
export interface VCSConfig {
  rootPath?: string;
  [key: string]: unknown;
}

/**
 * VCS Plugin metadata
 */
export interface VCSPluginMetadata {
  name: string;
  type: 'vcs';
  supported: boolean;
}

/**
 * Changed file info
 */
export interface ChangedFile {
  path: string;
  status: string;
  oldPath?: string;
  contentHash?: string | null;
}

/**
 * Diff hunk
 */
export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/**
 * File diff
 */
export interface FileDiff {
  path: string;
  hunks: DiffHunk[];
}

export abstract class VCSPlugin {
  config: VCSConfig;
  rootPath: string;

  constructor(config: VCSConfig = {}) {
    this.config = config;
    this.rootPath = config.rootPath || process.cwd();
  }

  /**
   * Метаданные плагина
   */
  abstract get metadata(): VCSPluginMetadata;

  /**
   * Проверить, доступна ли VCS в текущей директории
   */
  abstract isAvailable(): Promise<boolean>;

  /**
   * Получить список изменённых файлов (uncommitted changes)
   */
  abstract getChangedFiles(): Promise<ChangedFile[]>;

  /**
   * Получить содержимое файла из последнего коммита (main version)
   */
  abstract getCommittedContent(filePath: string): Promise<string | null>;

  /**
   * Получить diff для конкретного файла
   */
  abstract getFileDiff(filePath: string): Promise<FileDiff>;

  /**
   * Получить текущую ветку
   */
  abstract getCurrentBranch(): Promise<string>;

  /**
   * Получить хеш последнего коммита
   */
  abstract getLastCommitHash(): Promise<string | null>;

  /**
   * Проверить, является ли файл отслеживаемым (tracked)
   */
  abstract isTracked(filePath: string): Promise<boolean>;

  /**
   * Проверить, есть ли uncommitted изменения
   */
  async hasUncommittedChanges(): Promise<boolean> {
    const changedFiles = await this.getChangedFiles();
    return changedFiles.length > 0;
  }
}

/**
 * Вспомогательные типы для результатов
 */
export const FileStatus = {
  ADDED: 'added',
  MODIFIED: 'modified',
  DELETED: 'deleted',
  RENAMED: 'renamed',
  COPIED: 'copied',
  UNTRACKED: 'untracked'
} as const;

export type FileStatusType = typeof FileStatus[keyof typeof FileStatus];

/**
 * VCS Plugin class constructor type
 */
export interface VCSPluginConstructor {
  new (config?: VCSConfig): VCSPlugin;
}

/**
 * Фабрика для создания VCS плагинов
 * Автоматически определяет доступную VCS систему
 */
export class VCSPluginFactory {
  static availablePlugins: VCSPluginConstructor[] = [];

  /**
   * Зарегистрировать VCS плагин
   */
  static register(pluginClass: VCSPluginConstructor): void {
    this.availablePlugins.push(pluginClass);
  }

  /**
   * Автоматически определить и создать подходящий VCS плагин
   */
  static async detect(config: VCSConfig = {}, logger?: Logger): Promise<VCSPlugin | null> {
    for (const PluginClass of this.availablePlugins) {
      const plugin = new PluginClass(config);

      try {
        if (await plugin.isAvailable()) {
          logger?.info('VCS detected', { name: plugin.metadata.name });
          return plugin;
        }
      } catch {
        // Игнорируем ошибки и пробуем следующий плагин
      }
    }

    logger?.warn('No VCS system detected');
    return null;
  }

  /**
   * Создать плагин по имени
   */
  static create(name: string, config: VCSConfig = {}, logger?: Logger): VCSPlugin | null {
    const PluginClass = this.availablePlugins.find(
      Plugin => new Plugin(config).metadata.name === name
    );

    if (!PluginClass) {
      logger?.error('VCS plugin not found', { name });
      return null;
    }

    return new PluginClass(config);
  }
}
