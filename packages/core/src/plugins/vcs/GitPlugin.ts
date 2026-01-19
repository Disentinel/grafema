/**
 * Git VCS Plugin
 *
 * Плагин для работы с Git репозиториями
 * Обнаруживает изменённые файлы и предоставляет их содержимое
 */

import { VCSPlugin, FileStatus } from './VCSPlugin.js';
import type { VCSConfig, VCSPluginMetadata, ChangedFile, FileDiff, DiffHunk } from './VCSPlugin.js';
import { exec } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';
import { existsSync } from 'fs';
import { readFile } from 'fs/promises';
import { createHash } from 'crypto';

const execAsync = promisify(exec);

/**
 * Commit info
 */
export interface CommitInfo {
  hash: string;
  author: string;
  email: string;
  timestamp: number;
  message: string;
}

export class GitPlugin extends VCSPlugin {
  private gitDir: string;

  constructor(config: VCSConfig = {}) {
    super(config);
    this.gitDir = join(this.rootPath, '.git');
  }

  get metadata(): VCSPluginMetadata {
    return {
      name: 'git',
      type: 'vcs',
      supported: existsSync(this.gitDir)
    };
  }

  /**
   * Проверить доступность Git
   */
  async isAvailable(): Promise<boolean> {
    try {
      // Проверяем существование .git директории
      if (!existsSync(this.gitDir)) {
        return false;
      }

      // Проверяем работу git команды
      const { stdout } = await this._exec('git rev-parse --git-dir');
      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Получить список изменённых файлов
   */
  async getChangedFiles(): Promise<ChangedFile[]> {
    try {
      // Получаем список файлов через git status --porcelain
      const { stdout } = await this._exec('git status --porcelain');

      if (!stdout.trim()) {
        return []; // Нет изменений
      }

      const files: ChangedFile[] = [];
      const lines = stdout.trim().split('\n');

      for (const line of lines) {
        // Git status format: XY filename
        // X = index status, Y = working tree status
        // После XY идёт пробел(ы), затем filename
        const status = line.substring(0, 2);
        // Убираем XY и все leading пробелы
        const filePath = line.substring(2).trim();

        // Пропускаем ignored и unmerged файлы
        if (status === '!!' || status === 'UU') {
          continue;
        }

        // Парсим статус
        const parsedStatus = this._parseGitStatus(status);

        // Получаем хеш содержимого для tracked файлов
        let contentHash: string | null = null;
        try {
          const fullPath = join(this.rootPath, filePath);
          if (existsSync(fullPath) && parsedStatus !== FileStatus.DELETED) {
            const content = await readFile(fullPath, 'utf-8');
            contentHash = this._hashContent(content);
          }
        } catch {
          // Игнорируем ошибки чтения файла
        }

        files.push({
          path: filePath,
          status: parsedStatus,
          contentHash
        });
      }

      return files;
    } catch (error) {
      console.error('[GitPlugin] Failed to get changed files:', (error as Error).message);
      return [];
    }
  }

  /**
   * Получить содержимое файла из HEAD
   */
  async getCommittedContent(filePath: string): Promise<string | null> {
    try {
      // Проверяем, отслеживается ли файл
      const isTracked = await this.isTracked(filePath);
      if (!isTracked) {
        return null;
      }

      // Получаем содержимое из HEAD
      const { stdout } = await this._exec(`git show HEAD:"${filePath}"`);
      return stdout;
    } catch {
      // Файл может не существовать в HEAD (новый файл)
      return null;
    }
  }

  /**
   * Получить diff для файла
   */
  async getFileDiff(filePath: string): Promise<FileDiff> {
    try {
      const { stdout } = await this._exec(`git diff HEAD -- "${filePath}"`);

      if (!stdout.trim()) {
        return { path: filePath, hunks: [] };
      }

      // Парсим unified diff
      return this._parseUnifiedDiff(filePath, stdout);
    } catch (error) {
      console.error(`[GitPlugin] Failed to get diff for ${filePath}:`, (error as Error).message);
      return { path: filePath, hunks: [] };
    }
  }

  /**
   * Получить текущую ветку
   */
  async getCurrentBranch(): Promise<string> {
    try {
      const { stdout } = await this._exec('git rev-parse --abbrev-ref HEAD');
      return stdout.trim();
    } catch {
      return 'unknown';
    }
  }

  /**
   * Получить хеш последнего коммита
   */
  async getLastCommitHash(): Promise<string | null> {
    try {
      const { stdout } = await this._exec('git rev-parse HEAD');
      return stdout.trim();
    } catch {
      return null;
    }
  }

  /**
   * Проверить, отслеживается ли файл
   */
  async isTracked(filePath: string): Promise<boolean> {
    try {
      await this._exec(`git ls-files --error-unmatch "${filePath}"`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Вспомогательные методы
   */

  /**
   * Выполнить git команду
   */
  private async _exec(command: string): Promise<{ stdout: string; stderr: string }> {
    return await execAsync(command, {
      cwd: this.rootPath,
      maxBuffer: 10 * 1024 * 1024 // 10MB буфер для больших diff'ов
    });
  }

  /**
   * Парсить git status код в FileStatus
   */
  private _parseGitStatus(statusCode: string): string {
    const index = statusCode[0];
    const workingTree = statusCode[1];

    // Приоритет: working tree > index
    if (workingTree === 'M' || index === 'M') {
      return FileStatus.MODIFIED;
    }

    if (workingTree === 'A' || index === 'A') {
      return FileStatus.ADDED;
    }

    if (workingTree === 'D' || index === 'D') {
      return FileStatus.DELETED;
    }

    if (workingTree === 'R' || index === 'R') {
      return FileStatus.RENAMED;
    }

    if (workingTree === 'C' || index === 'C') {
      return FileStatus.COPIED;
    }

    if (workingTree === '?') {
      return FileStatus.UNTRACKED;
    }

    return FileStatus.MODIFIED; // По умолчанию
  }

  /**
   * Парсить unified diff формат
   */
  private _parseUnifiedDiff(filePath: string, diffText: string): FileDiff {
    const hunks: DiffHunk[] = [];
    const lines = diffText.split('\n');

    let currentHunk: DiffHunk | null = null;

    for (const line of lines) {
      // Начало нового hunk: @@ -oldStart,oldLines +newStart,newLines @@
      if (line.startsWith('@@')) {
        if (currentHunk) {
          hunks.push(currentHunk);
        }

        const match = line.match(/@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
        if (match) {
          currentHunk = {
            oldStart: parseInt(match[1]),
            oldLines: match[2] ? parseInt(match[2]) : 1,
            newStart: parseInt(match[3]),
            newLines: match[4] ? parseInt(match[4]) : 1,
            lines: []
          };
        }
        continue;
      }

      // Пропускаем заголовки diff
      if (line.startsWith('diff --git') ||
          line.startsWith('index ') ||
          line.startsWith('---') ||
          line.startsWith('+++')) {
        continue;
      }

      // Добавляем строку в текущий hunk
      if (currentHunk) {
        currentHunk.lines.push(line);
      }
    }

    // Добавляем последний hunk
    if (currentHunk) {
      hunks.push(currentHunk);
    }

    return { path: filePath, hunks };
  }

  /**
   * Вычислить SHA256 хеш содержимого
   */
  private _hashContent(content: string): string {
    return createHash('sha256').update(content, 'utf-8').digest('hex');
  }

  /**
   * Получить список всех tracked файлов в репозитории
   * (полезно для initial analysis)
   */
  async getAllTrackedFiles(): Promise<string[]> {
    try {
      const { stdout } = await this._exec('git ls-files');
      return stdout.trim().split('\n').filter(line => line.length > 0);
    } catch (error) {
      console.error('[GitPlugin] Failed to get tracked files:', (error as Error).message);
      return [];
    }
  }

  /**
   * Получить информацию о последнем коммите
   */
  async getLastCommitInfo(): Promise<CommitInfo | null> {
    try {
      const { stdout } = await this._exec('git log -1 --pretty=format:"%H%n%an%n%ae%n%at%n%s"');
      const lines = stdout.split('\n');

      return {
        hash: lines[0],
        author: lines[1],
        email: lines[2],
        timestamp: parseInt(lines[3]) * 1000,
        message: lines[4]
      };
    } catch {
      return null;
    }
  }

  /**
   * Проверить, есть ли uncommitted изменения
   */
  async hasUncommittedChanges(): Promise<boolean> {
    const changedFiles = await this.getChangedFiles();
    return changedFiles.length > 0;
  }
}
