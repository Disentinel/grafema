/**
 * MCP Issue Handlers
 */

import {
  textResult,
} from '../utils.js';
import type {
  ToolResult,
  ReportIssueArgs,
} from '../types.js';

// === BUG REPORTING ===

export async function handleReportIssue(args: ReportIssueArgs): Promise<ToolResult> {
  const { title, description, context, labels = ['bug'] } = args;
  // Use user's token if provided, otherwise fall back to project's issue-only token
  const GRAFEMA_ISSUE_TOKEN = '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';
  const githubToken = process.env.GITHUB_TOKEN || GRAFEMA_ISSUE_TOKEN;
  const repo = 'Disentinel/grafema';

  // Build issue body
  const body = `## Description
${description}

${context ? `## Context\n\`\`\`\n${context}\n\`\`\`\n` : ''}
## Environment
- Grafema version: 0.1.0-alpha.1
- Reported via: MCP tool

---
*This issue was automatically created via Grafema MCP server.*`;

  // Try GitHub API if token is available
  if (githubToken) {
    try {
      const response = await fetch(`https://api.github.com/repos/${repo}/issues`, {
        method: 'POST',
        headers: {
          'Authorization': `token ${githubToken}`,
          'Content-Type': 'application/json',
          'Accept': 'application/vnd.github.v3+json',
        },
        body: JSON.stringify({
          title,
          body,
          labels: labels.filter(l => ['bug', 'enhancement', 'documentation', 'question'].includes(l)),
        }),
      });

      if (response.ok) {
        const issue = await response.json() as { html_url: string; number: number };
        return textResult(
          `✅ Issue created successfully!\n\n` +
          `**Issue #${issue.number}**: ${issue.html_url}\n\n` +
          `Thank you for reporting this issue.`
        );
      } else {
        const error = await response.text();
        throw new Error(`GitHub API error: ${response.status} - ${error}`);
      }
    } catch (error) {
      // Fall through to manual template if API fails
      console.error('[report_issue] GitHub API failed:', error);
    }
  }

  // Fallback: return template for manual submission
  const issueUrl = `https://github.com/${repo}/issues/new`;
  const encodedTitle = encodeURIComponent(title);
  const encodedBody = encodeURIComponent(body);
  const encodedLabels = encodeURIComponent(labels.join(','));
  const directUrl = `${issueUrl}?title=${encodedTitle}&body=${encodedBody}&labels=${encodedLabels}`;

  return textResult(
    `⚠️ Failed to create issue automatically. Please create it manually:\n\n` +
    `**Quick link** (may truncate long descriptions):\n${directUrl}\n\n` +
    `**Or copy this template to** ${issueUrl}:\n\n` +
    `---\n**Title:** ${title}\n\n${body}\n---`
  );
}
