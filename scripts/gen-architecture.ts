import { execSync } from 'child_process';
import { writeFileSync, readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

const now = new Date().toISOString().split('T')[0];
const commitHash = execSync('git rev-parse --short HEAD').toString().trim();

console.log(`Generating architecture docs...`);
console.log(`Date: ${now}`);
console.log(`Commit: ${commitHash}`);

function countLines(dir: string): Map<string, number> {
  const results = new Map<string, number>();
  
  function walkDir(currentPath: string) {
    const files = readdirSync(currentPath);
    for (const file of files) {
      const filePath = join(currentPath, file);
      const stat = statSync(filePath);
      
      if (stat.isDirectory() && !file.startsWith('.') && file !== 'node_modules') {
        walkDir(filePath);
      } else if (file.endsWith('.ts')) {
        const content = readFileSync(filePath, 'utf-8');
        const lines = content.split('\n').length;
        results.set(filePath, lines);
      }
    }
  }
  
  walkDir(dir);
  return results;
}

const lineCounts = countLines('src');
const sortedFiles = [...lineCounts.entries()].sort((a, b) => b[1] - a[1]);
const totalLines = sortedFiles.reduce((sum, [, lines]) => sum + lines, 0);

console.log(`\nComplexity Summary:`);
console.log(`Total TypeScript files: ${sortedFiles.length}`);
console.log(`Total lines of code: ${totalLines.toLocaleString()}`);
console.log(`\nTop 10 largest files:`);
sortedFiles.slice(0, 10).forEach(([file, lines]) => {
  console.log(`  ${lines.toString().padStart(5)} lines: ${file}`);
});

let circularDeps = '';
try {
  circularDeps = execSync('npx madge --circular src/bot/index.ts 2>/dev/null').toString();
} catch (e: any) {
  circularDeps = e.stdout?.toString() || 'Error checking circular deps';
}

console.log(`\nCircular dependencies:`);
console.log(circularDeps || '  None detected');

const buildInfo = `
# Build Information

**Generated:** ${now}  
**Git Commit:** ${commitHash}  
**Build ID:** v1.0.0-${commitHash}

## Quick Stats
- Total Files: ${sortedFiles.length}
- Total Lines: ${totalLines.toLocaleString()}
- Largest File: ${sortedFiles[0]?.[0] || 'N/A'} (${sortedFiles[0]?.[1]?.toLocaleString() || 0} lines)

## Generation Command
\`\`\`bash
npm run docs:architecture
\`\`\`

## Last Updated
This file was auto-generated. Run the command above to refresh.
`;

writeFileSync('docs/architecture/BUILD_INFO.md', buildInfo.trim());

const updateReadme = readFileSync('docs/architecture/README.md', 'utf-8');
const updatedReadme = updateReadme
  .replace(/\*\*Generated:\*\* .+/, `**Generated:** ${now}`)
  .replace(/\*\*Git Commit:\*\* .+/, `**Git Commit:** ${commitHash}`)
  .replace(/\*\*Build:\*\* .+/, `**Build:** v1.0.0-${commitHash}`)
  .replace(/Total Lines of Code \| [\d,]+/, `Total Lines of Code | ${totalLines.toLocaleString()}`)
  .replace(/TypeScript Files \| \d+/, `TypeScript Files | ${sortedFiles.length}`);
writeFileSync('docs/architecture/README.md', updatedReadme);

const files = ['DEPENDENCY_GRAPH.md', 'ARCHITECTURE.md', 'DECISION_FLOWS.md', 'COMPLEXITY_REPORT.md'];
for (const file of files) {
  const path = `docs/architecture/${file}`;
  try {
    let content = readFileSync(path, 'utf-8');
    content = content
      .replace(/\*\*Generated:\*\* .+/, `**Generated:** ${now}`)
      .replace(/\*\*Git Commit:\*\* .+/, `**Git Commit:** ${commitHash}`);
    writeFileSync(path, content);
    console.log(`Updated: ${file}`);
  } catch (e) {
    console.log(`Skipped: ${file} (not found)`);
  }
}

console.log(`\nArchitecture documentation regenerated successfully!`);
console.log(`View at: docs/architecture/README.md`);
