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
  const githubToken = process.env.GITHUB_TOKEN;
  const repo = 'Disentinel/grafema';

  // Build issue body
  const body = `## Description
${description}

${context ? `## Context\n\`\`\`\n${context}\n\`\`\`\n` : ''}
## Environment
- Reported via: MCP tool

---
*This issue was created via Grafema MCP server.*`;

  // Try GitHub API if user has a token configured
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
          `Issue created: #${issue.number} ${issue.html_url}`
        );
      } else {
        const error = await response.text();
        throw new Error(`GitHub API error: ${response.status} - ${error}`);
      }
    } catch (error) {
      console.error('[report_issue] GitHub API failed:', error);
    }
  }

  // Return template for manual submission
  const issueUrl = `https://github.com/${repo}/issues/new`;
  const encodedTitle = encodeURIComponent(title);
  const encodedBody = encodeURIComponent(body);
  const encodedLabels = encodeURIComponent(labels.join(','));
  const directUrl = `${issueUrl}?title=${encodedTitle}&body=${encodedBody}&labels=${encodedLabels}`;

  return textResult(
    `Create issue manually:\n\n` +
    `**Link:** ${directUrl}\n\n` +
    `Or copy to ${issueUrl}:\n\n` +
    `---\n**Title:** ${title}\n\n${body}\n---\n\n` +
    `Tip: Set GITHUB_TOKEN env var to create issues automatically.`
  );
}
